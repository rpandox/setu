// Broadcast behavior (F4): selection, arming, fan-out resolution, paste
// guard, auto-disarm, pruning. IPC and the registry are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const exitCallbacks = new Map<string, (exit: { code: number | null }) => void>();
let spawnCounter = 0;

const ipcInvoke = vi.hoisted(() => vi.fn());
const pasteSpy = vi.hoisted(() => vi.fn());

vi.mock("../ipc/client", () => ({
  ipcInvoke,
  onPtyExit: vi.fn(
    async (sessionId: string, cb: (exit: { code: number | null }) => void) => {
      exitCallbacks.set(sessionId, cb);
      return () => exitCallbacks.delete(sessionId);
    },
  ),
}));

vi.mock("../features/terminal/registry", () => ({
  createSessionTerminal: vi.fn(async () => ({
    term: {
      onTitleChange: () => ({ dispose: () => undefined }),
      focus: vi.fn(),
    },
    fit: { fit: vi.fn() },
    search: {},
    open: vi.fn(),
    dispose: vi.fn(),
  })),
  disposeSessionTerminal: vi.fn(),
  getSessionTerminal: vi.fn(() => ({ term: { paste: pasteSpy, cols: 80, rows: 24 } })),
  rebindSessionTerminal: vi.fn(),
}));

import {
  countBroadcastTargets,
  resolvePtyWriteTargets,
  useBroadcast,
  wireBroadcastHousekeeping,
} from "./broadcast";
import { useSessions } from "./sessions";
import { useToast } from "./toast";
import { leavesOf } from "./splits";

beforeEach(() => {
  useSessions.setState({
    sessions: [],
    tabs: [],
    activeTabId: null,
    findOpen: false,
    findFocusSeq: 0,
  });
  useBroadcast.setState({
    selected: {},
    active: {},
    autoDisarm: true,
    pendingPaste: null,
  });
  useToast.setState({ message: null, seq: 0 });
  exitCallbacks.clear();
  ipcInvoke.mockReset();
  pasteSpy.mockClear();
  ipcInvoke.mockImplementation(async (command: string) =>
    command === "pty_spawn" ? { sessionId: `s${++spawnCounter}` } : null,
  );
});

/**
 * Opens one local tab and splits it into panes.
 *
 * @param count - How many panes the tab ends up with.
 * @returns The tab id plus pane/session ids in layout order.
 */
async function tabWithPanes(count: number): Promise<{
  tabId: string;
  paneIds: string[];
  sessionIds: string[];
}> {
  await useSessions.getState().openLocalTab();
  for (let i = 1; i < count; i++) {
    await useSessions.getState().splitPane("row");
  }
  const tab = useSessions.getState().tabs[0];
  const leaves = leavesOf(tab.layout);
  return {
    tabId: tab.tabId,
    paneIds: leaves.map((l) => l.paneId),
    sessionIds: leaves.map((l) => l.sessionId),
  };
}

describe("resolvePtyWriteTargets", () => {
  it("returns just the source when broadcast is off", async () => {
    const { sessionIds } = await tabWithPanes(2);
    expect(resolvePtyWriteTargets(sessionIds[0])).toEqual([sessionIds[0]]);
  });

  it("returns just the source for sessions outside any tab", () => {
    expect(resolvePtyWriteTargets("ghost")).toEqual(["ghost"]);
  });

  it("fans out to every selected running pane when armed (uptime⏎ × 4)", async () => {
    const { sessionIds } = await tabWithPanes(4);
    useBroadcast.getState().toggleBroadcast();
    const targets = resolvePtyWriteTargets(sessionIds[0]);
    expect(targets.sort()).toEqual([...sessionIds].sort());
  });

  it("excludes a deselected pane; typing into it stays normal input", async () => {
    const { tabId, paneIds, sessionIds } = await tabWithPanes(3);
    useBroadcast.getState().toggleBroadcast();
    useBroadcast.getState().togglePaneSelected(tabId, paneIds[1]);
    // From a selected pane: everyone selected, minus the opted-out pane.
    const targets = resolvePtyWriteTargets(sessionIds[0]);
    expect(targets.sort()).toEqual([sessionIds[0], sessionIds[2]].sort());
    // Into the deselected pane: normal single-pane input.
    expect(resolvePtyWriteTargets(sessionIds[1])).toEqual([sessionIds[1]]);
  });

  it("toggling broadcast off restores normal input", async () => {
    const { sessionIds } = await tabWithPanes(2);
    useBroadcast.getState().toggleBroadcast();
    expect(resolvePtyWriteTargets(sessionIds[0])).toHaveLength(2);
    useBroadcast.getState().toggleBroadcast();
    expect(resolvePtyWriteTargets(sessionIds[0])).toEqual([sessionIds[0]]);
  });

  it("skips dead panes and toasts the count once per burst", async () => {
    const { sessionIds } = await tabWithPanes(3);
    useBroadcast.getState().toggleBroadcast();
    exitCallbacks.get(sessionIds[1])?.({ code: 255 });
    const targets = resolvePtyWriteTargets(sessionIds[0]);
    expect(targets.sort()).toEqual([sessionIds[0], sessionIds[2]].sort());
    expect(useToast.getState().message).toBe("Broadcast skipped 1 disconnected pane");
    // Immediately again: rate-limited, no second toast.
    const seq = useToast.getState().seq;
    resolvePtyWriteTargets(sessionIds[0]);
    expect(useToast.getState().seq).toBe(seq);
  });

  it("stays silent when asked (paste-guard dry resolution)", async () => {
    const { sessionIds } = await tabWithPanes(2);
    useBroadcast.getState().toggleBroadcast();
    exitCallbacks.get(sessionIds[1])?.({ code: 255 });
    useToast.setState({ message: null, seq: 0 });
    resolvePtyWriteTargets(sessionIds[0], { silent: true });
    expect(useToast.getState().message).toBeNull();
  });
});

describe("toggleBroadcast", () => {
  it("selects all panes when arming with an empty selection", async () => {
    const { tabId, paneIds } = await tabWithPanes(3);
    useBroadcast.getState().toggleBroadcast();
    const state = useBroadcast.getState();
    expect(state.active[tabId]).toBe(true);
    expect((state.selected[tabId] ?? []).sort()).toEqual([...paneIds].sort());
  });

  it("keeps the selection across disarm/re-arm", async () => {
    const { tabId, paneIds } = await tabWithPanes(3);
    useBroadcast.getState().toggleBroadcast();
    useBroadcast.getState().togglePaneSelected(tabId, paneIds[0]);
    useBroadcast.getState().toggleBroadcast(); // disarm
    useBroadcast.getState().toggleBroadcast(); // re-arm
    const state = useBroadcast.getState();
    expect(state.active[tabId]).toBe(true);
    expect(state.selected[tabId]).not.toContain(paneIds[0]);
  });

  it("is a no-op with no tabs", () => {
    useBroadcast.getState().toggleBroadcast();
    expect(useBroadcast.getState().active).toEqual({});
  });
});

describe("housekeeping", () => {
  it("auto-disarms the tab you leave when the flag is on", async () => {
    wireBroadcastHousekeeping();
    const { tabId } = await tabWithPanes(2);
    useBroadcast.getState().toggleBroadcast();
    expect(useBroadcast.getState().active[tabId]).toBe(true);
    await useSessions.getState().openLocalTab(); // switches tabs
    expect(useBroadcast.getState().active[tabId]).toBe(false);
  });

  it("keeps the armed tab when auto-disarm is off", async () => {
    wireBroadcastHousekeeping();
    const { tabId } = await tabWithPanes(2);
    useBroadcast.getState().setAutoDisarm(false);
    useBroadcast.getState().toggleBroadcast();
    await useSessions.getState().openLocalTab();
    expect(useBroadcast.getState().active[tabId]).toBe(true);
  });

  it("prunes selection entries for closed panes and tabs", async () => {
    wireBroadcastHousekeeping();
    const { tabId, paneIds } = await tabWithPanes(2);
    useBroadcast.getState().toggleBroadcast();
    // Close the focused pane: its id must leave the selection.
    useSessions.getState().closePane();
    expect(useBroadcast.getState().selected[tabId]).not.toContain(
      paneIds[paneIds.length - 1],
    );
    // Close the whole tab: its entries disappear.
    useSessions.getState().closeTab(tabId);
    expect(useBroadcast.getState().selected[tabId]).toBeUndefined();
    expect(useBroadcast.getState().active[tabId]).toBeUndefined();
  });
});

describe("paste guard", () => {
  it("stores the pending paste and confirms through term.paste", async () => {
    const { sessionIds } = await tabWithPanes(2);
    useBroadcast.getState().requestPasteGuard({
      sessionId: sessionIds[0],
      text: "line1\nline2\n",
      targetCount: 2,
      reasons: ["Pastes more than one line"],
    });
    expect(useBroadcast.getState().pendingPaste?.targetCount).toBe(2);
    useBroadcast.getState().confirmPasteGuard("edited\n");
    expect(pasteSpy).toHaveBeenCalledWith("edited\n");
    expect(useBroadcast.getState().pendingPaste).toBeNull();
  });

  it("cancel drops the paste without touching any terminal", async () => {
    const { sessionIds } = await tabWithPanes(2);
    useBroadcast.getState().requestPasteGuard({
      sessionId: sessionIds[0],
      text: "rm -rf /tmp/x\n",
      targetCount: 2,
      reasons: ["Pastes more than one line", "Contains a destructive rm"],
    });
    useBroadcast.getState().cancelPasteGuard();
    expect(pasteSpy).not.toHaveBeenCalled();
    expect(useBroadcast.getState().pendingPaste).toBeNull();
  });
});

describe("countBroadcastTargets", () => {
  it("counts only selected, running panes", async () => {
    const { tabId, paneIds, sessionIds } = await tabWithPanes(3);
    useBroadcast.getState().toggleBroadcast();
    exitCallbacks.get(sessionIds[2])?.({ code: 255 });
    const tab = useSessions.getState().tabs.find((t) => t.tabId === tabId);
    if (!tab) throw new Error("tab vanished");
    const count = countBroadcastTargets(
      tab,
      useSessions.getState().sessions,
      useBroadcast.getState().selected[tabId] ?? [],
    );
    expect(count).toBe(2);
    expect(paneIds).toHaveLength(3);
  });
});
