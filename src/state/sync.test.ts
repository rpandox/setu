import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitSyncStatus } from "../ipc/contract";
import { useSync } from "./sync";

const ipcInvoke = vi.hoisted(() => vi.fn());
const onSyncUpdate = vi.hoisted(() => vi.fn());
vi.mock("../ipc/client", () => ({ ipcInvoke, onSyncUpdate }));

/**
 * A status fixture.
 *
 * @param overrides - Fields to override on the clean default.
 * @returns The status.
 */
function status(overrides: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return {
    state: "clean",
    dirty: false,
    ahead: 0,
    behind: 0,
    conflictFiles: [],
    ...overrides,
  };
}

beforeEach(() => {
  useSync.setState({ status: null, syncing: false, lastMessage: null, lastBlocked: [] });
  ipcInvoke.mockReset();
});

describe("refresh", () => {
  it("stores the fetched status", async () => {
    ipcInvoke.mockResolvedValueOnce(status({ state: "ahead", ahead: 2 }));
    await useSync.getState().refresh();
    expect(ipcInvoke).toHaveBeenCalledWith("git_sync_status", {});
    expect(useSync.getState().status?.state).toBe("ahead");
  });
});

describe("syncNow", () => {
  it("stores the run's status and clears old failures", async () => {
    useSync.setState({ lastMessage: "old failure" });
    ipcInvoke.mockResolvedValueOnce({
      ok: true,
      status: status(),
      blocked: [],
      conflictFiles: [],
    });
    const result = await useSync.getState().syncNow();
    expect(result?.ok).toBe(true);
    expect(useSync.getState().status?.state).toBe("clean");
    expect(useSync.getState().lastMessage).toBeNull();
    expect(useSync.getState().syncing).toBe(false);
  });

  it("keeps the lint block for the popover", async () => {
    const blocked = [
      {
        file: "hosts.toml",
        lineNo: 2,
        line: 'password = "hunter2"',
        rule: "secret_assignment",
      },
    ];
    ipcInvoke.mockResolvedValueOnce({
      ok: false,
      status: status({ state: "ahead", dirty: true }),
      blocked,
      conflictFiles: [],
    });
    const result = await useSync.getState().syncNow();
    expect(result?.ok).toBe(false);
    expect(useSync.getState().lastBlocked).toEqual(blocked);
  });

  it("records an infrastructure failure and stops the spinner", async () => {
    ipcInvoke.mockRejectedValueOnce("git not found");
    const result = await useSync.getState().syncNow();
    expect(result).toBeNull();
    expect(useSync.getState().syncing).toBe(false);
    expect(useSync.getState().lastMessage).toContain("git not found");
  });
});

describe("setRemote", () => {
  it("adopts the fresh status on success", async () => {
    ipcInvoke.mockResolvedValueOnce({
      ok: true,
      status: status({
        state: "ahead",
        remoteUrl: "git@github.com:me/cfg.git",
        ahead: 1,
      }),
    });
    const result = await useSync.getState().setRemote("git@github.com:me/cfg.git");
    expect(result.ok).toBe(true);
    expect(useSync.getState().status?.remoteUrl).toBe("git@github.com:me/cfg.git");
  });

  it("surfaces a rejected URL result-side", async () => {
    ipcInvoke.mockResolvedValueOnce({ ok: false, message: "not a usable remote URL" });
    const result = await useSync.getState().setRemote("two words");
    expect(result.ok).toBe(false);
    expect(useSync.getState().lastMessage).toContain("not a usable");
  });
});

describe("recordUpdate", () => {
  it("converges on a status broadcast from another window", () => {
    useSync
      .getState()
      .recordUpdate(status({ state: "conflict", conflictFiles: ["hosts.toml"] }));
    expect(useSync.getState().status?.state).toBe("conflict");
    expect(useSync.getState().status?.conflictFiles).toEqual(["hosts.toml"]);
  });
});
