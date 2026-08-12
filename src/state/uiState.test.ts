// state.json frontend behavior (F4): hydration, migration, debounced
// persistence, layout serialization, restore pruning. IPC and the terminal
// registry are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exitCallbacks = new Map<string, (exit: { code: number | null }) => void>();
let spawnCounter = 0;

const ipcInvoke = vi.hoisted(() => vi.fn());

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
  getSessionTerminal: vi.fn(() => undefined),
  rebindSessionTerminal: vi.fn(),
}));

import type { Host, SavedSplitNode, UiState } from "../ipc/contract";
import { useBroadcast } from "./broadcast";
import { useSessions } from "./sessions";
import { leavesOf } from "./splits";
import {
  defaultUiState,
  initUiState,
  isPersistDisabledForTests,
  pruneSavedLayout,
  resetUiStateForTests,
  serializeLayout,
  toRestorePlan,
  useUiPrefs,
} from "./uiState";

/**
 * A minimal host fixture.
 *
 * @param overrides - Fields to override.
 * @returns The host.
 */
function host(overrides: Partial<Host> = {}): Host {
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

/**
 * Mocks IPC with a given state.json document and host list.
 *
 * @param state - What `ui_state_get` returns (or an Error to throw).
 * @param hosts - What `hosts_list` returns.
 */
function mockIpc(state: UiState | Error, hosts: Host[] = []): void {
  ipcInvoke.mockImplementation(async (command: string) => {
    switch (command) {
      case "ui_state_get":
        if (state instanceof Error) throw state;
        return state;
      case "ui_state_set":
        return null;
      case "hosts_list":
        return hosts;
      case "pty_spawn":
        return { sessionId: `s${++spawnCounter}` };
      default:
        return null;
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetUiStateForTests();
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
  useUiPrefs.setState({
    collapsedSections: [],
    restoreOnLaunch: false,
    hydrated: false,
  });
  exitCallbacks.clear();
  ipcInvoke.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initUiState", () => {
  it("hydrates prefs and the broadcast flag from state.json", async () => {
    mockIpc({
      ...defaultUiState(),
      sidebar: { collapsedSections: ["favorites"] },
      broadcastAutoDisarm: false,
    });
    await initUiState();
    expect(useUiPrefs.getState().collapsedSections).toEqual(["favorites"]);
    expect(useUiPrefs.getState().hydrated).toBe(true);
    expect(useBroadcast.getState().autoDisarm).toBe(false);
  });

  it("runs on defaults and disables persistence when the file is corrupt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockIpc(new Error("failed to parse state.json"));
    await initUiState();
    expect(useUiPrefs.getState().hydrated).toBe(true);
    expect(isPersistDisabledForTests()).toBe(true);
    // A layout change must NOT write over the corrupt file.
    await useSessions.getState().openLocalTab();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ipcInvoke).not.toHaveBeenCalledWith("ui_state_set", expect.anything());
    warn.mockRestore();
  });

  it("persists layout changes with a debounce", async () => {
    mockIpc(defaultUiState());
    await initUiState();
    await useSessions.getState().openLocalTab();
    expect(ipcInvoke).not.toHaveBeenCalledWith("ui_state_set", expect.anything());
    await vi.advanceTimersByTimeAsync(600);
    const call = ipcInvoke.mock.calls.find(([cmd]) => cmd === "ui_state_set");
    expect(call).toBeDefined();
    const written = (call as [string, { state: UiState }])[1].state;
    expect(written.savedLayout).toHaveLength(1);
    expect(written.savedLayout[0].layout).toEqual({ kind: "leaf", hostId: null });
  });

  it("restores the saved layout when opted in, pruning non-setu hosts", async () => {
    const layout: SavedSplitNode = {
      kind: "split",
      dir: "row",
      ratio: 0.3,
      a: { kind: "leaf", hostId: "host-1" },
      b: {
        kind: "split",
        dir: "col",
        ratio: 0.6,
        a: { kind: "leaf", hostId: "sshcfg:atlas" }, // not restorable → pruned
        b: { kind: "leaf", hostId: null }, // local → fresh shell
      },
    };
    mockIpc({ ...defaultUiState(), restoreOnLaunch: true, savedLayout: [{ layout }] }, [
      host(),
    ]);
    await initUiState();
    const state = useSessions.getState();
    expect(state.tabs).toHaveLength(1);
    const leaves = leavesOf(state.tabs[0].layout);
    expect(leaves).toHaveLength(2); // sshcfg leaf pruned, split healed
    const metas = leaves.map((l) =>
      state.sessions.find((s) => s.sessionId === l.sessionId),
    );
    expect(metas[0]).toMatchObject({ kind: "ssh", hostId: "host-1", title: "hermes" });
    expect(metas[1]).toMatchObject({ kind: "local" });
  });

  it("skips restore when not opted in", async () => {
    mockIpc({
      ...defaultUiState(),
      restoreOnLaunch: false,
      savedLayout: [{ layout: { kind: "leaf", hostId: null } }],
    });
    await initUiState();
    expect(useSessions.getState().tabs).toHaveLength(0);
  });

  it("opens failed spawns as exited panes instead of blocking", async () => {
    mockIpc(
      {
        ...defaultUiState(),
        restoreOnLaunch: true,
        savedLayout: [{ layout: { kind: "leaf", hostId: "host-1" } }],
      },
      [host()],
    );
    ipcInvoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "ui_state_get":
          return {
            ...defaultUiState(),
            restoreOnLaunch: true,
            savedLayout: [{ layout: { kind: "leaf", hostId: "host-1" } }],
          };
        case "hosts_list":
          return [host()];
        case "pty_spawn":
          throw new Error("spawn failed");
        default:
          return null;
      }
    });
    await initUiState();
    const state = useSessions.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      kind: "ssh",
      hostId: "host-1",
      status: "exited",
    });
  });
});

describe("serializeLayout", () => {
  it("saves ssh panes by hostId and local panes as null", async () => {
    mockIpc(defaultUiState());
    await useSessions.getState().openLocalTab();
    await useSessions.getState().openSshTab(host());
    const { tabs, sessions } = useSessions.getState();
    const saved = serializeLayout(tabs, sessions);
    expect(saved).toHaveLength(2);
    expect(saved[0].layout).toEqual({ kind: "leaf", hostId: null });
    expect(saved[1].layout).toEqual({ kind: "leaf", hostId: "host-1" });
  });

  it("keeps split structure and ratios", async () => {
    mockIpc(defaultUiState());
    await useSessions.getState().openLocalTab();
    await useSessions.getState().splitPane("col");
    const tab = useSessions.getState().tabs[0];
    useSessions.getState().setSplitRatio(tab.tabId, [], 0.25);
    const saved = serializeLayout(
      useSessions.getState().tabs,
      useSessions.getState().sessions,
    );
    expect(saved[0].layout).toMatchObject({ kind: "split", dir: "col", ratio: 0.25 });
  });
});

describe("pruneSavedLayout / toRestorePlan", () => {
  const restorable = new Set(["host-1"]);

  it("keeps local leaves and restorable hosts, heals around the rest", () => {
    const node: SavedSplitNode = {
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { kind: "leaf", hostId: "gone" },
      b: { kind: "leaf", hostId: "host-1" },
    };
    expect(pruneSavedLayout(node, restorable)).toEqual({
      kind: "leaf",
      hostId: "host-1",
    });
  });

  it("returns null when nothing survives", () => {
    expect(pruneSavedLayout({ kind: "leaf", hostId: "gone" }, restorable)).toBeNull();
  });

  it("resolves hosts into a restore plan", () => {
    const byId = new Map([["host-1", host()]]);
    const plan = toRestorePlan(
      {
        kind: "split",
        dir: "col",
        ratio: 0.4,
        a: { kind: "leaf", hostId: "host-1" },
        b: { kind: "leaf", hostId: null },
      },
      byId,
    );
    expect(plan).toMatchObject({
      kind: "split",
      dir: "col",
      ratio: 0.4,
      a: { kind: "leaf", host: { id: "host-1" } },
      b: { kind: "leaf", host: null },
    });
  });
});
