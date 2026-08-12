// Store behavior: tab/pane lifecycle, splits, exit handling, activation,
// find bar. IPC and the terminal registry are mocked — this tests the
// state machine.
import { beforeEach, describe, expect, it, vi } from "vitest";

const exitCallbacks = new Map<string, (exit: { code: number | null }) => void>();
const titleCallbacks = new Map<string, (title: string) => void>();
let spawnCounter = 0;

const ipcInvoke = vi.hoisted(() => vi.fn());
const disposeSessionTerminal = vi.hoisted(() => vi.fn());
const rebindSessionTerminal = vi.hoisted(() => vi.fn());

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
  createSessionTerminal: vi.fn(async (sessionId: string) => ({
    term: {
      onTitleChange: (cb: (title: string) => void) => {
        titleCallbacks.set(sessionId, cb);
        return { dispose: () => undefined };
      },
      focus: vi.fn(),
    },
    fit: { fit: vi.fn() },
    search: {},
    open: vi.fn(),
    dispose: vi.fn(),
  })),
  disposeSessionTerminal,
  getSessionTerminal: vi.fn(() => ({ term: { cols: 120, rows: 40 } })),
  rebindSessionTerminal,
}));

import type { Host } from "../ipc/contract";
import { activeSessionOf, useSessions, type Tab } from "./sessions";
import { findLeafBySession, leavesOf } from "./splits";

/**
 * A minimal host fixture for SSH-tab tests.
 *
 * @param overrides - Fields to override on the base fixture.
 * @returns The host.
 */
function sshHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    label: "hermes",
    group: "",
    tags: [],
    hue: 4,
    hostname: "hermes.example.net",
    user: "pandox",
    port: 22,
    identity: "agent",
    use_mosh: false,
    startup: "",
    control_master: false,
    reachability: true,
    forwards: [],
    health: { enabled: false, interval_s: 30 },
    notes: "",
    favorite: false,
    source: "setu",
    ...overrides,
  };
}

/** The focused session's id, or undefined. */
function activeId(): string | undefined {
  return activeSessionOf(useSessions.getState())?.sessionId;
}

/**
 * The tab whose layout contains a session.
 *
 * @param sessionId - The session to look up.
 * @returns Its tab, or `undefined`.
 */
function tabForSession(sessionId: string): Tab | undefined {
  return useSessions.getState().tabs.find((t) => findLeafBySession(t.layout, sessionId));
}

beforeEach(() => {
  useSessions.setState({
    sessions: [],
    tabs: [],
    activeTabId: null,
    findOpen: false,
    findFocusSeq: 0,
  });
  exitCallbacks.clear();
  titleCallbacks.clear();
  ipcInvoke.mockReset();
  disposeSessionTerminal.mockClear();
  rebindSessionTerminal.mockReset();
  rebindSessionTerminal.mockImplementation(async () => ({
    term: { focus: vi.fn(), cols: 120, rows: 40 },
  }));
  ipcInvoke.mockImplementation(async (command: string) =>
    command === "pty_spawn" ? { sessionId: `s${++spawnCounter}` } : null,
  );
});

async function openTabs(count: number): Promise<string[]> {
  const before = useSessions.getState().sessions.length;
  for (let i = 0; i < count; i++) {
    await useSessions.getState().openLocalTab();
  }
  return useSessions
    .getState()
    .sessions.slice(before)
    .map((s) => s.sessionId);
}

describe("openLocalTab", () => {
  it("spawns, registers, and activates the new single-pane tab", async () => {
    const [id] = await openTabs(1);
    const state = useSessions.getState();
    expect(ipcInvoke).toHaveBeenCalledWith("pty_spawn", {
      kind: "local",
      cols: 80,
      rows: 24,
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      sessionId: id,
      title: "local",
      status: "running",
      exitCode: null,
    });
    expect(state.tabs).toHaveLength(1);
    expect(leavesOf(state.tabs[0].layout)).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0].tabId);
    expect(activeId()).toBe(id);
  });

  it("appends tabs in order and activates the latest", async () => {
    const [a, b] = await openTabs(2);
    const state = useSessions.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual([a, b]);
    expect(state.tabs).toHaveLength(2);
    expect(activeId()).toBe(b);
  });

  it("follows shell title changes", async () => {
    const [id] = await openTabs(1);
    titleCallbacks.get(id)?.("vim ~/notes");
    expect(useSessions.getState().sessions[0].title).toBe("vim ~/notes");
  });
});

describe("closeTab", () => {
  it("kills the PTY, disposes the terminal, and removes the tab", async () => {
    const [id] = await openTabs(1);
    const tab = tabForSession(id);
    expect(tab).toBeDefined();
    useSessions.getState().closeTab((tab as Tab).tabId);
    expect(ipcInvoke).toHaveBeenCalledWith("pty_kill", { sessionId: id });
    expect(disposeSessionTerminal).toHaveBeenCalledWith(id);
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(0);
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
  });

  it("moves focus to the tab that slides into the closed slot", async () => {
    const [a, b, c] = await openTabs(3);
    const tabB = tabForSession(b) as Tab;
    useSessions.getState().setActive(tabB.tabId);
    useSessions.getState().closeTab(tabB.tabId);
    const state = useSessions.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual([a, c]);
    expect(activeId()).toBe(c);
  });

  it("falls back to the last tab when the closed tab was last", async () => {
    const [a, b] = await openTabs(2);
    useSessions.getState().closeTab((tabForSession(b) as Tab).tabId);
    expect(activeId()).toBe(a);
  });

  it("kills every pane in a split tab", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const state = useSessions.getState();
    const [, b] = state.sessions.map((s) => s.sessionId);
    useSessions.getState().closeTab(state.tabs[0].tabId);
    expect(ipcInvoke).toHaveBeenCalledWith("pty_kill", { sessionId: a });
    expect(ipcInvoke).toHaveBeenCalledWith("pty_kill", { sessionId: b });
    expect(useSessions.getState().sessions).toHaveLength(0);
    expect(useSessions.getState().tabs).toHaveLength(0);
  });
});

describe("splitPane", () => {
  it("splits a local pane with a fresh local shell and focuses it", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const state = useSessions.getState();
    expect(state.tabs).toHaveLength(1);
    const leaves = leavesOf(state.tabs[0].layout);
    expect(leaves).toHaveLength(2);
    expect(leaves[0].sessionId).toBe(a);
    // The new pane is focused.
    expect(state.tabs[0].activePaneId).toBe(leaves[1].paneId);
    expect(activeId()).toBe(leaves[1].sessionId);
  });

  it("splits an SSH pane with a second session to the same host", async () => {
    await useSessions.getState().openSshTab(sshHost());
    await useSessions.getState().splitPane("col");
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[1]).toMatchObject({
      kind: "ssh",
      hostId: "host-1",
      title: "hermes",
      hue: 4,
    });
    expect(leavesOf(state.tabs[0].layout)).toHaveLength(2);
  });

  it("refuses to split an orphaned SSH pane", async () => {
    await useSessions.getState().openSshTab(sshHost());
    useSessions.getState().markOrphaned("host-1");
    await useSessions.getState().splitPane("row");
    expect(useSessions.getState().sessions).toHaveLength(1);
  });

  it("builds a 2×2 grid of four panes", async () => {
    await openTabs(1);
    const s = useSessions.getState();
    await s.splitPane("row");
    // Focus the left pane again, split down; then the right pane, split down.
    const tab = () => useSessions.getState().tabs[0];
    const leftPane = leavesOf(tab().layout)[0];
    useSessions.getState().focusPane(tab().tabId, leftPane.paneId);
    await useSessions.getState().splitPane("col");
    const rightPane = leavesOf(tab().layout)[2];
    useSessions.getState().focusPane(tab().tabId, rightPane.paneId);
    await useSessions.getState().splitPane("col");
    expect(leavesOf(tab().layout)).toHaveLength(4);
    expect(useSessions.getState().sessions).toHaveLength(4);
  });
});

describe("closePane", () => {
  it("heals the layout and keeps the sibling running (F4)", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const b = activeId();
    expect(b).not.toBe(a);
    useSessions.getState().closePane();
    const state = useSessions.getState();
    expect(ipcInvoke).toHaveBeenCalledWith("pty_kill", { sessionId: b });
    expect(state.tabs).toHaveLength(1);
    expect(leavesOf(state.tabs[0].layout)).toHaveLength(1);
    expect(state.sessions.map((s) => s.sessionId)).toEqual([a]);
    expect(state.sessions[0].status).toBe("running");
    expect(activeId()).toBe(a);
  });

  it("closes the tab when closing its last pane", async () => {
    await openTabs(1);
    useSessions.getState().closePane();
    expect(useSessions.getState().tabs).toHaveLength(0);
    expect(useSessions.getState().activeTabId).toBeNull();
  });
});

describe("pane focus", () => {
  it("focusPane focuses a pane and its tab", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const tab = useSessions.getState().tabs[0];
    const first = leavesOf(tab.layout)[0];
    useSessions.getState().focusPane(tab.tabId, first.paneId);
    expect(activeId()).toBe(a);
  });

  it("movePaneFocus follows layout geometry (⌥⌘-arrows)", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const b = activeId();
    useSessions.getState().movePaneFocus("left");
    expect(activeId()).toBe(a);
    useSessions.getState().movePaneFocus("right");
    expect(activeId()).toBe(b);
    // At the edge: no-op.
    useSessions.getState().movePaneFocus("right");
    expect(activeId()).toBe(b);
  });

  it("ignores focusPane for unknown panes", async () => {
    const [a] = await openTabs(1);
    const tab = useSessions.getState().tabs[0];
    useSessions.getState().focusPane(tab.tabId, "nope");
    expect(activeId()).toBe(a);
  });
});

describe("exit handling", () => {
  it("closes the pane (and its only tab) on a clean exit", async () => {
    const [id] = await openTabs(1);
    exitCallbacks.get(id)?.({ code: 0 });
    expect(useSessions.getState().sessions).toHaveLength(0);
    expect(useSessions.getState().tabs).toHaveLength(0);
    expect(disposeSessionTerminal).toHaveBeenCalledWith(id);
  });

  it("heals the split when one pane exits cleanly", async () => {
    const [a] = await openTabs(1);
    await useSessions.getState().splitPane("row");
    const b = activeId();
    exitCallbacks.get(b as string)?.({ code: 0 });
    const state = useSessions.getState();
    expect(state.tabs).toHaveLength(1);
    expect(leavesOf(state.tabs[0].layout)).toHaveLength(1);
    expect(activeId()).toBe(a);
  });

  it("keeps the pane with the code on a failure exit", async () => {
    const [id] = await openTabs(1);
    exitCallbacks.get(id)?.({ code: 127 });
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      sessionId: id,
      status: "exited",
      exitCode: 127,
    });
  });

  it("keeps the pane on a signal death (null code)", async () => {
    const [id] = await openTabs(1);
    exitCallbacks.get(id)?.({ code: null });
    expect(useSessions.getState().sessions[0].status).toBe("exited");
    expect(useSessions.getState().sessions[0].exitCode).toBeNull();
  });
});

describe("activation", () => {
  it("activates by index and ignores out-of-range (⌘1–9)", async () => {
    const [a] = await openTabs(2);
    useSessions.getState().activateByIndex(0);
    expect(activeId()).toBe(a);
    useSessions.getState().activateByIndex(7);
    expect(activeId()).toBe(a);
  });

  it("cycles forward and backward with wrap-around (⌃Tab)", async () => {
    const [a, b, c] = await openTabs(3);
    expect(activeId()).toBe(c);
    useSessions.getState().cycleActive(1);
    expect(activeId()).toBe(a);
    useSessions.getState().cycleActive(-1);
    expect(activeId()).toBe(c);
    useSessions.getState().cycleActive(-1);
    expect(activeId()).toBe(b);
  });

  it("ignores setActive for unknown ids", async () => {
    const [id] = await openTabs(1);
    useSessions.getState().setActive("nope");
    expect(activeId()).toBe(id);
  });
});

describe("openSshTab", () => {
  it("spawns ssh with the host id and seeds title, hue, and host metadata", async () => {
    await useSessions.getState().openSshTab(sshHost());
    expect(ipcInvoke).toHaveBeenCalledWith("pty_spawn", {
      kind: "ssh",
      hostId: "host-1",
      cols: 80,
      rows: 24,
    });
    expect(useSessions.getState().sessions[0]).toMatchObject({
      kind: "ssh",
      title: "hermes",
      hostId: "host-1",
      hostLabel: "hermes",
      hue: 4,
      status: "running",
    });
  });
});

describe("reconnect", () => {
  /** Opens an SSH tab and fails it with exit code 255 (a dropped link). */
  async function exitedSshTab(): Promise<string> {
    await useSessions.getState().openSshTab(sshHost());
    const id =
      useSessions.getState().sessions[useSessions.getState().sessions.length - 1]
        .sessionId;
    exitCallbacks.get(id)?.({ code: 255 });
    expect(
      useSessions.getState().sessions[useSessions.getState().sessions.length - 1].status,
    ).toBe("exited");
    return id;
  }

  it("spawns a fresh PTY, rebinds the terminal, and swaps the session id", async () => {
    const oldId = await exitedSshTab();
    await useSessions.getState().reconnect(oldId);
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(1);
    const meta = state.sessions[0];
    expect(meta.sessionId).not.toBe(oldId);
    expect(meta).toMatchObject({ status: "running", exitCode: null, kind: "ssh" });
    expect(rebindSessionTerminal).toHaveBeenCalledWith(oldId, meta.sessionId);
    expect(activeId()).toBe(meta.sessionId);
    // The reconnect spawn reuses the terminal's real size.
    expect(ipcInvoke).toHaveBeenLastCalledWith("pty_spawn", {
      kind: "ssh",
      hostId: "host-1",
      cols: 120,
      rows: 40,
    });
  });

  it("updates the pane's leaf, keeping the pane id (F4)", async () => {
    const oldId = await exitedSshTab();
    const oldLeaf = findLeafBySession(useSessions.getState().tabs[0].layout, oldId);
    await useSessions.getState().reconnect(oldId);
    const state = useSessions.getState();
    const newId = state.sessions[0].sessionId;
    const newLeaf = findLeafBySession(state.tabs[0].layout, newId);
    expect(newLeaf).toBeDefined();
    expect(newLeaf?.paneId).toBe(oldLeaf?.paneId);
    expect(findLeafBySession(state.tabs[0].layout, oldId)).toBeUndefined();
  });

  it("wires exit handling for the new session id", async () => {
    const oldId = await exitedSshTab();
    await useSessions.getState().reconnect(oldId);
    const newId = useSessions.getState().sessions[0].sessionId;
    expect(exitCallbacks.has(oldId)).toBe(false);
    exitCallbacks.get(newId)?.({ code: 255 });
    expect(useSessions.getState().sessions[0].status).toBe("exited");
  });

  it("is a no-op for running tabs and local tabs", async () => {
    await useSessions.getState().openSshTab(sshHost());
    const running =
      useSessions.getState().sessions[useSessions.getState().sessions.length - 1]
        .sessionId;
    await useSessions.getState().reconnect(running);
    expect(rebindSessionTerminal).not.toHaveBeenCalled();

    const [local] = await openTabs(1);
    exitCallbacks.get(local)?.({ code: 1 });
    await useSessions.getState().reconnect(local);
    expect(rebindSessionTerminal).not.toHaveBeenCalled();
  });

  it("reconnectAll revives every exited ssh pane", async () => {
    const a = await exitedSshTab();
    const b = await exitedSshTab();
    await useSessions.getState().reconnectAll();
    const state = useSessions.getState();
    expect(state.sessions.every((s) => s.status === "running")).toBe(true);
    expect(state.sessions.map((s) => s.sessionId)).not.toContain(a);
    expect(state.sessions.map((s) => s.sessionId)).not.toContain(b);
  });
});

describe("duplicateTab", () => {
  it("opens a new tab with a second session to the same host", async () => {
    await useSessions.getState().openSshTab(sshHost());
    const tab = useSessions.getState().tabs[0];
    await useSessions.getState().duplicateTab(tab.tabId);
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(2);
    expect(state.tabs).toHaveLength(2);
    expect(state.sessions[1]).toMatchObject({
      kind: "ssh",
      hostId: "host-1",
      title: "hermes",
      hue: 4,
    });
    expect(state.sessions[1].sessionId).not.toBe(state.sessions[0].sessionId);
  });

  it("refuses local and orphaned tabs", async () => {
    await openTabs(1);
    const localTab = useSessions.getState().tabs[0];
    await useSessions.getState().duplicateTab(localTab.tabId);
    expect(useSessions.getState().sessions).toHaveLength(1);

    await useSessions.getState().openSshTab(sshHost());
    useSessions.getState().markOrphaned("host-1");
    const orphanTab = useSessions.getState().tabs[1];
    await useSessions.getState().duplicateTab(orphanTab.tabId);
    expect(useSessions.getState().sessions).toHaveLength(2);
  });
});

describe("markOrphaned", () => {
  it("flags every session on the deleted host and no others", async () => {
    await useSessions.getState().openSshTab(sshHost());
    await useSessions.getState().openSshTab(sshHost({ id: "host-2", label: "atlas" }));
    useSessions.getState().markOrphaned("host-1");
    const [a, b] = useSessions.getState().sessions;
    expect(a.orphaned).toBe(true);
    expect(b.orphaned).toBeUndefined();
  });
});

describe("find bar", () => {
  it("opens on the first ⇧⌘F", () => {
    expect(useSessions.getState().findOpen).toBe(false);
    useSessions.getState().openFind();
    expect(useSessions.getState().findOpen).toBe(true);
    expect(useSessions.getState().findFocusSeq).toBe(1);
  });

  it("stays open and bumps the focus sequence on repeat ⇧⌘F", () => {
    useSessions.getState().openFind();
    useSessions.getState().openFind();
    expect(useSessions.getState().findOpen).toBe(true);
    expect(useSessions.getState().findFocusSeq).toBe(2);
  });

  it("closes on closeFind and reopens cleanly", () => {
    useSessions.getState().openFind();
    useSessions.getState().closeFind();
    expect(useSessions.getState().findOpen).toBe(false);
    useSessions.getState().openFind();
    expect(useSessions.getState().findOpen).toBe(true);
  });
});
