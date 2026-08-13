// Store behavior: CRUD round-trips, drawer/editor state, and the run
// orchestration (targets, unresolved-variable abort). IPC, sessions,
// broadcast, hosts, and toast are mocked — this tests the state machine.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcInvoke = vi.hoisted(() => vi.fn());
const show = vi.hoisted(() => vi.fn());
const openSshTab = vi.hoisted(() => vi.fn());
const resolvePtyWriteTargets = vi.hoisted(() => vi.fn());
/** Mutable fixtures the mock factories close over. */
const fixtures = vi.hoisted(() => ({
  focused: undefined as { sessionId: string; status: "running" | "exited" } | undefined,
  hosts: [] as { id: string; label: string; hue: number }[],
}));

vi.mock("../ipc/client", () => ({ ipcInvoke }));
vi.mock("./toast", () => ({ useToast: { getState: () => ({ show }) } }));
vi.mock("./broadcast", () => ({ resolvePtyWriteTargets }));
vi.mock("./sessions", () => ({
  useSessions: { getState: () => ({ openSshTab }) },
  activeSessionOf: () => fixtures.focused,
}));
vi.mock("./hosts", () => ({
  useHosts: { getState: () => ({ hosts: fixtures.hosts }) },
}));

import type { Snippet } from "../ipc/contract";
import { useSnippets } from "./snippets";

/**
 * A snippet fixture.
 *
 * @param overrides - Fields to override.
 * @returns The snippet.
 */
function snippet(overrides: Partial<Snippet> = {}): Snippet {
  return {
    id: "s1",
    label: "follow logs",
    command: "journalctl -u {{service}} -f",
    tags: [],
    variables: [{ name: "service", default: "sshd" }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.focused = { sessionId: "sess-1", status: "running" };
  fixtures.hosts = [
    { id: "h1", label: "hermes", hue: 1 },
    { id: "h2", label: "atlas", hue: 2 },
    { id: "h3", label: "ceres", hue: 3 },
  ];
  useSnippets.setState({
    snippets: [],
    loadError: null,
    drawerOpen: false,
    editorTarget: null,
    pendingRun: null,
  });
});

describe("load", () => {
  it("stores the list and clears the error", async () => {
    ipcInvoke.mockResolvedValueOnce([snippet()]);
    await useSnippets.getState().load();
    expect(ipcInvoke).toHaveBeenCalledWith("snippet_list", {});
    expect(useSnippets.getState().snippets).toHaveLength(1);
    expect(useSnippets.getState().loadError).toBeNull();
  });

  it("keeps the old list and records the error on failure", async () => {
    useSnippets.setState({ snippets: [snippet()] });
    ipcInvoke.mockRejectedValueOnce(new Error("corrupt file"));
    await useSnippets.getState().load();
    expect(useSnippets.getState().snippets).toHaveLength(1);
    expect(useSnippets.getState().loadError).toContain("corrupt file");
  });
});

describe("drawer and editor state", () => {
  it("toggling the drawer closed also closes the editor", () => {
    useSnippets.getState().toggleDrawer();
    useSnippets.getState().openEditor("new");
    useSnippets.getState().toggleDrawer();
    expect(useSnippets.getState().drawerOpen).toBe(false);
    expect(useSnippets.getState().editorTarget).toBeNull();
  });
});

describe("saveSnippet", () => {
  it("returns validation errors and keeps the editor open", async () => {
    useSnippets.getState().openEditor("new");
    ipcInvoke.mockResolvedValueOnce({
      errors: [{ field: "label", message: "Label is required" }],
    });
    const errors = await useSnippets.getState().saveSnippet(snippet({ label: "" }));
    expect(errors).toHaveLength(1);
    expect(useSnippets.getState().editorTarget).toBe("new");
  });

  it("closes the editor and reloads on success", async () => {
    useSnippets.getState().openEditor("new");
    ipcInvoke
      .mockResolvedValueOnce({ snippet: snippet() }) // upsert
      .mockResolvedValueOnce([snippet()]); // reload
    const errors = await useSnippets.getState().saveSnippet(snippet());
    expect(errors).toEqual([]);
    expect(useSnippets.getState().editorTarget).toBeNull();
    expect(useSnippets.getState().snippets).toHaveLength(1);
  });
});

describe("deleteSnippet", () => {
  it("deletes, closes a matching editor, and reloads", async () => {
    useSnippets.getState().openEditor("s1");
    ipcInvoke.mockResolvedValueOnce(null).mockResolvedValueOnce([]);
    await useSnippets.getState().deleteSnippet("s1");
    expect(ipcInvoke).toHaveBeenCalledWith("snippet_delete", { snippetId: "s1" });
    expect(useSnippets.getState().editorTarget).toBeNull();
  });
});

describe("runSnippet", () => {
  it("aborts with a toast when a variable is unresolved", async () => {
    await useSnippets.getState().runSnippet(snippet(), {
      target: "current-pane",
      values: {},
    });
    expect(show).toHaveBeenCalledWith(
      expect.stringContaining("Unresolved variable {{service}}"),
    );
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  it("writes the resolved command to the focused pane", async () => {
    await useSnippets.getState().runSnippet(snippet(), {
      target: "current-pane",
      values: { service: "nginx" },
    });
    expect(ipcInvoke).toHaveBeenCalledWith("pty_write", {
      sessionId: "sess-1",
      data: "journalctl -u nginx -f\n",
    });
  });

  it("refuses current-pane without a running focused pane", async () => {
    fixtures.focused = { sessionId: "sess-1", status: "exited" };
    await useSnippets.getState().runSnippet(snippet(), {
      target: "current-pane",
      values: { service: "nginx" },
    });
    expect(show).toHaveBeenCalledWith("Snippets need a running focused pane");
    expect(ipcInvoke).not.toHaveBeenCalled();
  });

  it("fans out to every broadcast target", async () => {
    resolvePtyWriteTargets.mockReturnValueOnce(["sess-1", "sess-2", "sess-3"]);
    await useSnippets.getState().runSnippet(snippet(), {
      target: "broadcast",
      values: { service: "nginx" },
    });
    expect(resolvePtyWriteTargets).toHaveBeenCalledWith("sess-1");
    expect(ipcInvoke).toHaveBeenCalledTimes(3);
    expect(ipcInvoke).toHaveBeenNthCalledWith(2, "pty_write", {
      sessionId: "sess-2",
      data: "journalctl -u nginx -f\n",
    });
  });

  it("opens a tab per host in picker order and writes into each", async () => {
    openSshTab
      .mockResolvedValueOnce("new-1")
      .mockResolvedValueOnce("new-2")
      .mockResolvedValueOnce("new-3");
    await useSnippets.getState().runSnippet(snippet(), {
      target: "new-tabs",
      hostIds: ["h1", "ghost", "h2", "h3"],
      values: { service: "nginx" },
    });
    // Unknown ids are dropped; order follows the picker.
    expect(openSshTab.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      "h1",
      "h2",
      "h3",
    ]);
    expect(ipcInvoke.mock.calls).toEqual([
      ["pty_write", { sessionId: "new-1", data: "journalctl -u nginx -f\n" }],
      ["pty_write", { sessionId: "new-2", data: "journalctl -u nginx -f\n" }],
      ["pty_write", { sessionId: "new-3", data: "journalctl -u nginx -f\n" }],
    ]);
  });

  it("refuses new-tabs with no known hosts", async () => {
    await useSnippets.getState().runSnippet(snippet(), {
      target: "new-tabs",
      hostIds: ["ghost"],
      values: { service: "nginx" },
    });
    expect(show).toHaveBeenCalledWith("No hosts selected — nothing was run");
    expect(openSshTab).not.toHaveBeenCalled();
  });
});

describe("packs", () => {
  it("importPack forwards the path + strategy and reloads", async () => {
    ipcInvoke
      .mockResolvedValueOnce({ imported: 2, skipped: 1 })
      .mockResolvedValueOnce([snippet()]);
    const outcome = await useSnippets.getState().importPack("/tmp/pack.toml", "keep");
    expect(ipcInvoke).toHaveBeenNthCalledWith(1, "snippet_import", {
      path: "/tmp/pack.toml",
      mergeStrategy: "keep",
    });
    expect(outcome).toEqual({ imported: 2, skipped: 1 });
    expect(useSnippets.getState().snippets).toHaveLength(1);
  });

  it("exportPack writes to the picked path", async () => {
    ipcInvoke.mockResolvedValueOnce(null);
    await useSnippets.getState().exportPack(["s1"], "/tmp/out.toml");
    expect(ipcInvoke).toHaveBeenCalledWith("snippet_export", {
      ids: ["s1"],
      path: "/tmp/out.toml",
    });
  });
});
