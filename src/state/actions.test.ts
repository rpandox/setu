// The action registry (F11): §8 completeness, shortcut dispatch, and
// parametric expansion. IPC and the terminal registry are mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  ipcInvoke: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onReachUpdate: vi.fn(),
}));

vi.mock("../features/terminal/registry", () => ({
  createSessionTerminal: vi.fn(),
  getSessionTerminal: vi.fn(),
  disposeSessionTerminal: vi.fn(),
}));

import { actionRegistry, dispatchShortcut, paletteEntries } from "./actions";
import { useSessions, type Tab } from "./sessions";
import { useUiChrome } from "./ui";

/**
 * A keydown stand-in for dispatch tests.
 *
 * @param key - The event key.
 * @param mods - Modifier flags.
 */
function key(
  key: string,
  mods: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
): KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent;
}

/**
 * A minimal single-pane tab.
 *
 * @param tabId - The tab's id.
 * @param sessionId - Its one pane's session.
 */
function tab(tabId: string, sessionId: string): Tab {
  return {
    tabId,
    layout: { kind: "leaf", paneId: `p-${sessionId}`, sessionId },
    activePaneId: `p-${sessionId}`,
  };
}

beforeEach(() => {
  useUiChrome.setState({ sidebarCollapsed: false, paletteMode: null });
});

describe("actionRegistry", () => {
  it("covers every implemented §8 action", () => {
    // The PLAN.md §8 rows whose features exist in Phases 0–4 (the §5 log
    // scopes the palette to implemented actions; ⌘C/⌘V stay native).
    const expected = [
      "quick-connect", // ⌘T
      "command-palette", // ⌘K
      "new-local-tab", // ⌘N
      "split-right", // ⌘D
      "split-down", // ⇧⌘D
      "close-pane", // ⌘W
      "go-to-tab", // ⌘1–9
      "next-tab", // ⌃Tab
      "previous-tab", // ⌃⇧Tab
      "focus-pane-left", // ⌥⌘←
      "focus-pane-right", // ⌥⌘→
      "focus-pane-up", // ⌥⌘↑
      "focus-pane-down", // ⌥⌘↓
      "toggle-broadcast", // ⇧⌘B
      "find-in-terminal", // ⇧⌘F
      "toggle-sidebar", // ⌘/
    ];
    const ids = actionRegistry().map((a) => a.id);
    for (const id of expected) {
      expect(ids, `missing §8 action: ${id}`).toContain(id);
    }
  });

  it("ids are unique and every action shows a shortcut", () => {
    const actions = actionRegistry();
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of actions) {
      expect(action.shortcut, `${action.id} needs a shortcut label`).toBeTruthy();
    }
  });
});

describe("dispatchShortcut", () => {
  it("⌘/ toggles the sidebar", () => {
    expect(dispatchShortcut(key("/", { metaKey: true }))).toBe(true);
    expect(useUiChrome.getState().sidebarCollapsed).toBe(true);
  });

  it("⌘T opens the hosts palette, ⌘K the commands palette", () => {
    expect(dispatchShortcut(key("t", { metaKey: true }))).toBe(true);
    expect(useUiChrome.getState().paletteMode).toBe("hosts");
    expect(dispatchShortcut(key("k", { metaKey: true }))).toBe(true);
    expect(useUiChrome.getState().paletteMode).toBe("commands");
    expect(dispatchShortcut(key("k", { metaKey: true }))).toBe(true);
    expect(useUiChrome.getState().paletteMode).toBe(null);
  });

  it("plain keys and unknown combos fall through", () => {
    expect(dispatchShortcut(key("d"))).toBe(false);
    expect(dispatchShortcut(key("d", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(dispatchShortcut(key("x", { metaKey: true }))).toBe(false);
  });

  it("⌘1 activates the first tab", () => {
    useSessions.setState({
      tabs: [tab("t1", "s1"), tab("t2", "s2")],
      activeTabId: "t2",
    });
    expect(dispatchShortcut(key("1", { metaKey: true }))).toBe(true);
    expect(useSessions.getState().activeTabId).toBe("t1");
  });
});

describe("paletteEntries", () => {
  it("expands go-to-tab into one row per open tab", () => {
    useSessions.setState({
      tabs: [tab("t1", "s1"), tab("t2", "s2")],
      activeTabId: "t1",
      sessions: [
        { sessionId: "s1", title: "hermes", kind: "ssh", status: "running", exitCode: null },
        { sessionId: "s2", title: "local", kind: "local", status: "running", exitCode: null },
      ],
    });
    const rows = paletteEntries().filter((e) => e.id.startsWith("go-to-tab:"));
    expect(rows.map((r) => r.id)).toEqual(["go-to-tab:1", "go-to-tab:2"]);
    expect(rows[0].title).toContain("hermes");
    rows[1].perform();
    expect(useSessions.getState().activeTabId).toBe("t2");
  });

  it("lists every non-parametric action as itself", () => {
    const ids = paletteEntries().map((e) => e.id);
    expect(ids).toContain("split-right");
    expect(ids).toContain("toggle-broadcast");
    expect(ids).not.toContain("go-to-tab"); // parametric: expanded rows only
  });
});
