// SFTP panel state (F5): connect lifecycle, queue concurrency + retry,
// cancel semantics, and the hostkey verdict. IPC is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcInvoke = vi.hoisted(() => vi.fn());
const onSftpProgress = vi.hoisted(() => vi.fn());
const onHostkeyPrompt = vi.hoisted(() => vi.fn());
const localHomeDir = vi.hoisted(() => vi.fn());

vi.mock("../ipc/client", () => ({
  ipcInvoke,
  onSftpProgress,
  onHostkeyPrompt,
  localHomeDir,
}));

import type { SftpEntry, SftpProgressEvent } from "../ipc/contract";
import { resetSftpForTests, useSftp } from "./sftp";
import { useToast } from "./toast";

/** Captured progress callbacks by transfer id. */
const progressCbs = new Map<string, (p: SftpProgressEvent) => void>();

/** Transfer-id mint for the mocked upload/download commands. */
let mintedTransfers = 0;

/**
 * A listing entry.
 *
 * @param overrides - Fields to override.
 */
function entry(overrides: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name: "file.bin",
    size: 8,
    mtimeMs: 1000,
    mode: 0o644,
    isDir: false,
    isSymlink: false,
    ...overrides,
  };
}

/**
 * The default mocked IPC surface: a healthy, empty server.
 *
 * @param overrides - Per-command overrides of the default surface.
 */
function mockIpc(overrides: Record<string, (payload: never) => unknown> = {}): void {
  ipcInvoke.mockImplementation((command: string, payload: unknown) => {
    const override = overrides[command];
    if (override) return Promise.resolve(override(payload as never));
    switch (command) {
      case "sftp_connect":
        return Promise.resolve({ sftpSessionId: "sess-1" });
      case "sftp_realpath":
        return Promise.resolve({ path: "/home/pandox" });
      case "sftp_list":
      case "sftp_local_list":
        return Promise.resolve({ entries: [] });
      case "sftp_local_stat": {
        const path = (payload as { path: string }).path;
        return Promise.resolve(entry({ name: path.split("/").pop() ?? path }));
      }
      case "sftp_upload":
      case "sftp_download":
        return Promise.resolve({ transferId: `x-${++mintedTransfers}` });
      default:
        return Promise.resolve(null);
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  progressCbs.clear();
  mintedTransfers = 0;
  resetSftpForTests();
  useToast.setState({ message: null, variant: "info", seq: 0 });
  localHomeDir.mockResolvedValue("/Users/pandox");
  onSftpProgress.mockImplementation((transferId, cb) => {
    progressCbs.set(transferId, cb);
    return Promise.resolve(() => undefined);
  });
  mockIpc();
});

/**
 * Waits until the store settles into `predicate`.
 *
 * @param predicate - The condition to wait for.
 */
async function settle(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error("not yet");
  });
}

describe("toggleForHost", () => {
  it("connects, resolves the remote home, and lists both panes", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await settle(() => useSftp.getState().panes.remote.path === "/home/pandox");
    expect(useSftp.getState().open).toBe(true);
    expect(useSftp.getState().panes.local.path).toBe("/Users/pandox");
    expect(useSftp.getState().sftpSessionId).toBe("sess-1");
  });

  it("same-host toggle hides without disconnecting; reopen is instant", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    useSftp.getState().toggleForHost("h1", "hermes");
    expect(useSftp.getState().open).toBe(false);
    useSftp.getState().toggleForHost("h1", "hermes");
    expect(useSftp.getState().open).toBe(true);
    expect(useSftp.getState().connState).toBe("connected");
    const disconnects = ipcInvoke.mock.calls.filter(
      ([command]) => command === "sftp_disconnect",
    );
    expect(disconnects).toHaveLength(0);
  });

  it("switching hosts disconnects the old session", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    useSftp.getState().toggleForHost("h2", "athena");
    await settle(() => useSftp.getState().connState === "connected");
    const disconnects = ipcInvoke.mock.calls.filter(
      ([command]) => command === "sftp_disconnect",
    );
    expect(disconnects).toHaveLength(1);
  });

  it("a refused connect lands in the error state with the message", async () => {
    mockIpc({
      sftp_connect: () => {
        throw new Error("HOST KEY CHANGED for hermes");
      },
    });
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "error");
    expect(useSftp.getState().connError).toContain("HOST KEY CHANGED");
  });
});

describe("the transfer queue", () => {
  /** Connects and drops five files to upload. */
  async function connectAndDropFive(): Promise<void> {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await useSftp.getState().uploadDroppedPaths(["/d/a", "/d/b", "/d/c", "/d/d", "/d/e"]);
  }

  it("runs at most three transfers; the rest wait queued", async () => {
    await connectAndDropFive();
    await settle(
      () =>
        useSftp.getState().transfers.filter((t) => t.state === "running").length === 3,
    );
    const states = useSftp.getState().transfers.map((t) => t.state);
    expect(states.filter((s) => s === "queued")).toHaveLength(2);
  });

  it("a terminal done event frees the slot and pumps the queue", async () => {
    await connectAndDropFive();
    await settle(() => progressCbs.size === 3);
    const [firstId] = [...progressCbs.keys()];
    progressCbs.get(firstId)?.({ bytes: 8, total: 8, state: "done" });
    await settle(
      () => useSftp.getState().transfers.filter((t) => t.state === "done").length === 1,
    );
    await settle(
      () =>
        useSftp.getState().transfers.filter((t) => t.state === "running").length === 3,
    );
    expect(useSftp.getState().transfers.filter((t) => t.state === "queued")).toHaveLength(
      1,
    );
  });

  it("running progress updates bytes and totals", async () => {
    await connectAndDropFive();
    await settle(() => progressCbs.size === 3);
    const [firstId] = [...progressCbs.keys()];
    progressCbs.get(firstId)?.({ bytes: 4, total: 8, state: "running" });
    await settle(() => useSftp.getState().transfers[0].bytes === 4);
    expect(useSftp.getState().transfers[0].total).toBe(8);
  });

  it("a retryable failure re-queues exactly once, then sticks as failed", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await useSftp.getState().uploadDroppedPaths(["/d/a"]);
    await settle(() => progressCbs.size === 1);

    const fail = (id: string) =>
      progressCbs.get(id)?.({
        bytes: 0,
        total: 0,
        state: "failed",
        error: "Connection lost",
        retryable: true,
      });

    const firstId = [...progressCbs.keys()][0];
    fail(firstId);
    // The retry re-runs it under a fresh transfer id.
    await settle(() => progressCbs.size === 2);
    expect(useSftp.getState().transfers[0].retried).toBe(true);
    const secondId = [...progressCbs.keys()][1];
    fail(secondId);
    await settle(() => useSftp.getState().transfers[0].state === "failed");
    expect(useSftp.getState().transfers[0].error).toContain("Connection lost");
  });

  it("permanent failures don't auto-retry but a manual retry re-queues", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await useSftp.getState().uploadDroppedPaths(["/d/a"]);
    await settle(() => progressCbs.size === 1);
    progressCbs.get([...progressCbs.keys()][0])?.({
      bytes: 0,
      total: 0,
      state: "failed",
      error: "Permission denied",
      retryable: false,
    });
    await settle(() => useSftp.getState().transfers[0].state === "failed");

    useSftp.getState().retryTransfer(useSftp.getState().transfers[0].clientId);
    await settle(() => progressCbs.size === 2);
    expect(useSftp.getState().transfers[0].state).toBe("running");
  });

  it("cancelling a running transfer invokes sftp_cancel; the event finalizes", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await useSftp.getState().uploadDroppedPaths(["/d/a"]);
    await settle(() => progressCbs.size === 1);

    const row = useSftp.getState().transfers[0];
    useSftp.getState().cancelTransfer(row.clientId);
    await settle(() =>
      ipcInvoke.mock.calls.some(([command]) => command === "sftp_cancel"),
    );
    progressCbs.get(row.transferId ?? "")?.({ bytes: 0, total: 0, state: "cancelled" });
    await settle(() => useSftp.getState().transfers[0].state === "cancelled");
  });

  it("cancelling a queued transfer needs no backend call", async () => {
    await connectAndDropFive();
    await settle(
      () => useSftp.getState().transfers.filter((t) => t.state === "queued").length === 2,
    );
    const queued = useSftp.getState().transfers.find((t) => t.state === "queued");
    useSftp.getState().cancelTransfer(queued?.clientId ?? "");
    expect(
      useSftp.getState().transfers.find((t) => t.clientId === queued?.clientId)?.state,
    ).toBe("cancelled");
    expect(
      ipcInvoke.mock.calls.filter(([command]) => command === "sftp_cancel"),
    ).toHaveLength(0);
  });

  it("clearFinished keeps only queued and running rows", async () => {
    await connectAndDropFive();
    await settle(() => progressCbs.size === 3);
    progressCbs.get([...progressCbs.keys()][0])?.({ bytes: 8, total: 8, state: "done" });
    await settle(
      () => useSftp.getState().transfers.filter((t) => t.state === "done").length === 1,
    );
    useSftp.getState().clearFinished();
    expect(useSftp.getState().transfers.every((t) => t.state !== "done")).toBe(true);
  });
});

describe("panes and entries", () => {
  it("double-clicking a file queues a transfer to the other pane's cwd", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await settle(() => useSftp.getState().panes.remote.path === "/home/pandox");

    await useSftp.getState().openEntry("remote", entry({ name: "notes.md" }));
    const [row] = useSftp.getState().transfers;
    expect(row.direction).toBe("download");
    expect(row.remotePath).toBe("/home/pandox/notes.md");
    expect(row.localPath).toBe("/Users/pandox/notes.md");
  });

  it("a failed listing keeps the pane's previous path and reports the error", async () => {
    useSftp.getState().toggleForHost("h1", "hermes");
    await settle(() => useSftp.getState().connState === "connected");
    await settle(() => useSftp.getState().panes.remote.path === "/home/pandox");

    mockIpc({
      sftp_list: () => {
        throw new Error("Permission denied: /root");
      },
    });
    await useSftp.getState().navigate("remote", "/root");
    const pane = useSftp.getState().panes.remote;
    expect(pane.path).toBe("/home/pandox");
    expect(pane.error).toContain("Permission denied");
  });
});

describe("respondHostkey", () => {
  it("passes the verdict through hostkey_trust and clears the prompt", async () => {
    useSftp.setState({
      hostkeyPrompt: {
        hostId: "h1",
        hostLabel: "hermes",
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:abc",
      },
    });
    useSftp.getState().respondHostkey(true);
    expect(useSftp.getState().hostkeyPrompt).toBeNull();
    await settle(() =>
      ipcInvoke.mock.calls.some(
        ([command, payload]) =>
          command === "hostkey_trust" &&
          (payload as { hostId: string; accept: boolean }).accept === true,
      ),
    );
  });
});
