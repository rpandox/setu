import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../ipc/client", () => ({
  ipcInvoke: (...args: unknown[]) => invoke(...args),
}));

import { pasteIntoPane, relativeTime, useHistory } from "./history";

describe("history store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHistory.getState().reset();
    vi.useFakeTimers();
  });

  it("debounces keystrokes and keeps only the latest answer", async () => {
    invoke.mockImplementation((_cmd: string, args: { params: { query: string } }) =>
      Promise.resolve({
        entries: [
          {
            id: 1,
            ts: 1,
            host: "h",
            cwd: "/",
            cmd: args.params.query,
            exit: 0,
            durationMs: 1,
          },
        ],
      }),
    );
    useHistory.getState().search("g");
    useHistory.getState().search("gi");
    useHistory.getState().search("git");
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1]).toEqual({ params: { query: "git", limit: 8 } });
    expect(useHistory.getState().rows[0].cmd).toBe("git");
    expect(useHistory.getState().loading).toBe(false);
  });

  it("drops an answer that arrives after reset", async () => {
    let resolve: (v: unknown) => void = () => undefined;
    invoke.mockImplementation(() => new Promise((r) => (resolve = r)));
    useHistory.getState().search("x");
    await vi.advanceTimersByTimeAsync(100);
    useHistory.getState().reset();
    resolve({
      entries: [{ id: 1, ts: 1, host: "h", cwd: "/", cmd: "x", exit: 0, durationMs: 1 }],
    });
    await vi.runAllTimersAsync();
    expect(useHistory.getState().rows).toEqual([]);
  });

  it("pastes without a carriage return", () => {
    invoke.mockResolvedValue(null);
    pasteIntoPane("s1", "ls -la");
    expect(invoke).toHaveBeenCalledWith("pty_write", { sessionId: "s1", data: "ls -la" });
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 7, 23, 12, 0, 0);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4d ago");
    expect(relativeTime(now - 40 * 86_400_000, now)).toBe("2026-07-14");
  });
});
