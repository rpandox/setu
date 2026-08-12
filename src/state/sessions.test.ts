// Store behavior: tab lifecycle, exit handling, activation, find bar.
// IPC and the terminal registry are mocked — this tests the state machine.
import { beforeEach, describe, expect, it, vi } from "vitest";

const exitCallbacks = new Map<string, (exit: { code: number | null }) => void>();
const titleCallbacks = new Map<string, (title: string) => void>();
let spawnCounter = 0;

const ipcInvoke = vi.hoisted(() => vi.fn());
const disposeSessionTerminal = vi.hoisted(() => vi.fn());

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
  getSessionTerminal: vi.fn(),
}));

import { useSessions } from "./sessions";

beforeEach(() => {
  useSessions.setState({
    sessions: [],
    activeSessionId: null,
    findOpen: false,
    findFocusSeq: 0,
  });
  exitCallbacks.clear();
  titleCallbacks.clear();
  ipcInvoke.mockReset();
  disposeSessionTerminal.mockClear();
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
  it("spawns, registers, and activates the new tab", async () => {
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
    expect(state.activeSessionId).toBe(id);
  });

  it("appends tabs in order and activates the latest", async () => {
    const [a, b] = await openTabs(2);
    const state = useSessions.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual([a, b]);
    expect(state.activeSessionId).toBe(b);
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
    useSessions.getState().closeTab(id);
    expect(ipcInvoke).toHaveBeenCalledWith("pty_kill", { sessionId: id });
    expect(disposeSessionTerminal).toHaveBeenCalledWith(id);
    const state = useSessions.getState();
    expect(state.sessions).toHaveLength(0);
    expect(state.activeSessionId).toBeNull();
  });

  it("moves focus to the tab that slides into the closed slot", async () => {
    const [a, b, c] = await openTabs(3);
    useSessions.getState().setActive(b);
    useSessions.getState().closeTab(b);
    const state = useSessions.getState();
    expect(state.sessions.map((s) => s.sessionId)).toEqual([a, c]);
    expect(state.activeSessionId).toBe(c);
  });

  it("falls back to the last tab when the closed tab was last", async () => {
    const [a, b] = await openTabs(2);
    useSessions.getState().closeTab(b);
    expect(useSessions.getState().activeSessionId).toBe(a);
  });
});

describe("exit handling", () => {
  it("closes the tab on a clean exit", async () => {
    const [id] = await openTabs(1);
    exitCallbacks.get(id)?.({ code: 0 });
    expect(useSessions.getState().sessions).toHaveLength(0);
    expect(disposeSessionTerminal).toHaveBeenCalledWith(id);
  });

  it("keeps the tab with the code on a failure exit", async () => {
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

  it("keeps the tab on a signal death (null code)", async () => {
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
    expect(useSessions.getState().activeSessionId).toBe(a);
    useSessions.getState().activateByIndex(7);
    expect(useSessions.getState().activeSessionId).toBe(a);
  });

  it("cycles forward and backward with wrap-around (⌃Tab)", async () => {
    const [a, b, c] = await openTabs(3);
    expect(useSessions.getState().activeSessionId).toBe(c);
    useSessions.getState().cycleActive(1);
    expect(useSessions.getState().activeSessionId).toBe(a);
    useSessions.getState().cycleActive(-1);
    expect(useSessions.getState().activeSessionId).toBe(c);
    useSessions.getState().cycleActive(-1);
    expect(useSessions.getState().activeSessionId).toBe(b);
  });

  it("ignores setActive for unknown ids", async () => {
    const [id] = await openTabs(1);
    useSessions.getState().setActive("nope");
    expect(useSessions.getState().activeSessionId).toBe(id);
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
