// Reachability state (F1, Phase 4): probe-result application, LED
// derivation (§7 table), and the last-seen label. IPC is mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  ipcInvoke: vi.fn(),
  onReachUpdate: vi.fn(),
}));

import type { Host } from "../ipc/contract";
import { emptyHostDraft } from "./hosts";
import { lastSeenLabel, ledInfoOf, useReach } from "./reach";
import type { SessionMeta } from "./sessions";

/**
 * A minimal saved host.
 *
 * @param overrides - Fields to override on the draft.
 */
function host(overrides: Partial<Host> = {}): Host {
  return { ...emptyHostDraft(), id: "h1", label: "hermes", hostname: "hermes.example.net", ...overrides };
}

/**
 * A running SSH session.
 *
 * @param hostId - The host the session is connected to.
 */
function runningSession(hostId: string): SessionMeta {
  return {
    sessionId: "s1",
    title: "hermes",
    kind: "ssh",
    hostId,
    status: "running",
    exitCode: null,
  };
}

beforeEach(() => {
  useReach.setState({ byHost: {}, probing: true });
});

describe("apply", () => {
  it("records an up probe with latency and last-up time", () => {
    useReach.getState().apply({ hostId: "h1", state: "up", rttMs: 12 }, 1000);
    expect(useReach.getState().byHost["h1"]).toEqual({
      state: "up",
      rttMs: 12,
      lastUpAt: 1000,
    });
  });

  it("a down probe keeps the previous last-up time and drops the latency", () => {
    const s = useReach.getState();
    s.apply({ hostId: "h1", state: "up", rttMs: 12 }, 1000);
    s.apply({ hostId: "h1", state: "down" }, 5000);
    expect(useReach.getState().byHost["h1"]).toEqual({
      state: "down",
      rttMs: undefined,
      lastUpAt: 1000,
    });
  });

  it("a down probe with no prior up has no last-up time", () => {
    useReach.getState().apply({ hostId: "h1", state: "down" }, 5000);
    expect(useReach.getState().byHost["h1"].lastUpAt).toBeUndefined();
  });
});

describe("ledInfoOf", () => {
  it("is hollow with a probing reason before the first result", () => {
    const led = ledInfoOf(host(), {}, [], true);
    expect(led.state).toBe("hollow");
    expect(led.reason).toBe("Probing…");
  });

  it("lights up with the latency chip on an up result", () => {
    const led = ledInfoOf(host(), { h1: { state: "up", rttMs: 12, lastUpAt: 1 } }, [], true);
    expect(led).toEqual({ state: "up", rttMs: 12, lastUpAt: 1 });
  });

  it("goes red with last-seen on a down result", () => {
    const led = ledInfoOf(host(), { h1: { state: "down", lastUpAt: 1 } }, [], true);
    expect(led.state).toBe("down");
    expect(led.lastUpAt).toBe(1);
  });

  it("pulses when the host has a running session, whatever the probe says", () => {
    const led = ledInfoOf(
      host(),
      { h1: { state: "down" } },
      [runningSession("h1")],
      true,
    );
    expect(led.state).toBe("pulsing");
  });

  it("an exited or orphaned session does not pulse", () => {
    const exited = { ...runningSession("h1"), status: "exited" as const };
    const orphaned = { ...runningSession("h1"), orphaned: true };
    expect(ledInfoOf(host(), {}, [exited], true).state).toBe("hollow");
    expect(ledInfoOf(host(), {}, [orphaned], true).state).toBe("hollow");
  });

  it("stays hollow when the prober is not running (global kill switch)", () => {
    const led = ledInfoOf(host(), { h1: { state: "up", rttMs: 5 } }, [], false);
    expect(led.state).toBe("hollow");
    expect(led.reason).toBe("Reachability probing is off");
  });

  it("stays hollow when the host opted out (per-host kill switch)", () => {
    const led = ledInfoOf(host({ reachability: false }), {}, [], true);
    expect(led.state).toBe("hollow");
    expect(led.reason).toBe("Reachability off for this host");
  });

  it("stays hollow for alias-only imports with the adopt hint", () => {
    const led = ledInfoOf(host({ hostname: "", source: "ssh_config" }), {}, [], true);
    expect(led.state).toBe("hollow");
    expect(led.reason).toContain("adopt");
  });
});

describe("lastSeenLabel", () => {
  it("covers the never / just-now / seconds / minutes / hours ladder", () => {
    const now = 10_000_000;
    expect(lastSeenLabel(undefined, now)).toBe("never seen up");
    expect(lastSeenLabel(now - 3_000, now)).toBe("last seen just now");
    expect(lastSeenLabel(now - 30_000, now)).toBe("last seen 30s ago");
    expect(lastSeenLabel(now - 5 * 60_000, now)).toBe("last seen 5m ago");
    expect(lastSeenLabel(now - 3 * 3_600_000, now)).toBe("last seen 3h ago");
  });
});
