// Store behavior: status application, stop semantics, the chip count,
// and the auto-start subscription (dedupe, red retry, conflict toasts).
// IPC, sessions, hosts, and toast are mocked — this tests the state machine.
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipcInvoke = vi.hoisted(() => vi.fn());
const show = vi.hoisted(() => vi.fn());
/** Mutable fixtures the mock factories close over. */
const fixtures = vi.hoisted(() => ({
  sessions: [] as {
    kind: "local" | "ssh";
    status: "running" | "exited";
    hostId?: string;
    orphaned?: boolean;
  }[],
  sessionListeners: [] as (() => void)[],
  hosts: [] as {
    id: string;
    forwards: { type: "L" | "R" | "D"; spec: string; auto: boolean }[];
  }[],
  forwardUpdate: undefined as ((status: unknown) => void) | undefined,
}));

vi.mock("../ipc/client", () => ({
  ipcInvoke,
  onForwardUpdate: vi.fn(async (cb: (status: unknown) => void) => {
    fixtures.forwardUpdate = cb;
    return () => undefined;
  }),
}));
vi.mock("./toast", () => ({ useToast: { getState: () => ({ show }) } }));
vi.mock("./sessions", () => ({
  useSessions: {
    getState: () => ({ sessions: fixtures.sessions }),
    subscribe: (cb: () => void) => {
      fixtures.sessionListeners.push(cb);
      return () => undefined;
    },
  },
}));
vi.mock("./hosts", () => ({
  useHosts: { getState: () => ({ hosts: fixtures.hosts }) },
}));

import type { ForwardStatus } from "../ipc/contract";
import {
  activeForwardCount,
  ruleFromKey,
  ruleKeyOf,
  useForwards,
  wireForwards,
  withBindPort,
} from "./forwards";

/**
 * A status fixture.
 *
 * @param overrides - Fields to override.
 * @returns The status.
 */
function status(overrides: Partial<ForwardStatus> = {}): ForwardStatus {
  return {
    ruleKey: "h1:L:8080:localhost:8080",
    hostId: "h1",
    state: "green",
    ...overrides,
  };
}

/** Notifies every captured sessions-store listener. */
function pokeSessions(): void {
  for (const listener of fixtures.sessionListeners) listener();
}

/** Drains the microtask queue (async chains inside autoStartFor). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  useForwards.setState({ byRuleKey: {} });
  fixtures.sessions = [];
  fixtures.hosts = [];
});

describe("ruleKeyOf", () => {
  it("mirrors the Rust key format", () => {
    expect(ruleKeyOf("h1", { type: "L", spec: "8080:localhost:8080", auto: true })).toBe(
      "h1:L:8080:localhost:8080",
    );
  });
});

describe("withBindPort", () => {
  it("rewrites the bind port in every spec shape", () => {
    expect(
      withBindPort({ type: "L", spec: "8080:localhost:8080", auto: true }, 8081).spec,
    ).toBe("8081:localhost:8080");
    expect(
      withBindPort({ type: "L", spec: "0.0.0.0:8080:web:80", auto: false }, 8081).spec,
    ).toBe("0.0.0.0:8081:web:80");
    expect(withBindPort({ type: "D", spec: "1080", auto: false }, 1081).spec).toBe(
      "1081",
    );
    expect(
      withBindPort({ type: "D", spec: "127.0.0.1:1080", auto: false }, 1081).spec,
    ).toBe("127.0.0.1:1081");
  });

  it("never marks the override auto", () => {
    expect(
      withBindPort({ type: "L", spec: "8080:localhost:8080", auto: true }, 8081).auto,
    ).toBe(false);
  });
});

describe("ruleFromKey", () => {
  it("reconstructs rules, including for colon-bearing host ids", () => {
    expect(ruleFromKey("sshcfg:hermes:L:8080:localhost:8080", "sshcfg:hermes")).toEqual({
      type: "L",
      spec: "8080:localhost:8080",
      auto: false,
    });
    expect(ruleFromKey("h1:D:1080", "h1")).toEqual({
      type: "D",
      spec: "1080",
      auto: false,
    });
    expect(ruleFromKey("h1:L:8080:localhost:8080", "other")).toBeNull();
    expect(ruleFromKey("h1:X:8080", "h1")).toBeNull();
  });
});

describe("apply / stop / count", () => {
  it("applies transitions keyed by rule", () => {
    useForwards.getState().apply(status({ state: "amber" }));
    useForwards.getState().apply(status({ state: "green" }));
    expect(useForwards.getState().byRuleKey["h1:L:8080:localhost:8080"].state).toBe(
      "green",
    );
  });

  it("stop invokes the command and drops the status", async () => {
    useForwards.getState().apply(status());
    ipcInvoke.mockResolvedValueOnce(null);
    await useForwards.getState().stop("h1:L:8080:localhost:8080");
    expect(ipcInvoke).toHaveBeenCalledWith("forward_stop", {
      ruleKey: "h1:L:8080:localhost:8080",
    });
    expect(useForwards.getState().byRuleKey).toEqual({});
  });

  it("counts starting/amber/green but not red", () => {
    const byRuleKey = {
      a: status({ ruleKey: "a", state: "starting" }),
      b: status({ ruleKey: "b", state: "green" }),
      c: status({ ruleKey: "c", state: "red", reason: "died" }),
    };
    expect(activeForwardCount(byRuleKey)).toBe(2);
  });
});

describe("wireForwards auto-start", () => {
  it("fires auto rules once per running transition, deduped and toasting conflicts", async () => {
    fixtures.hosts = [
      {
        id: "h1",
        forwards: [
          { type: "L", spec: "8080:localhost:8080", auto: true },
          { type: "D", spec: "1080", auto: false }, // manual: never auto-fired
        ],
      },
    ];
    wireForwards();
    expect(fixtures.forwardUpdate).toBeDefined();

    // First running session for h1 → the auto rule starts.
    ipcInvoke.mockResolvedValueOnce({
      started: true,
      ruleKey: "h1:L:8080:localhost:8080",
    });
    fixtures.sessions = [{ kind: "ssh", status: "running", hostId: "h1" }];
    pokeSessions();
    await flush();
    expect(ipcInvoke).toHaveBeenCalledTimes(1);
    expect(ipcInvoke).toHaveBeenCalledWith("forward_start", {
      hostId: "h1",
      rule: { type: "L", spec: "8080:localhost:8080", auto: true },
    });

    // A second session on the same host (split/duplicate): no re-fire —
    // the host never left the running set.
    fixtures.sessions = [
      { kind: "ssh", status: "running", hostId: "h1" },
      { kind: "ssh", status: "running", hostId: "h1" },
    ];
    pokeSessions();
    await flush();
    expect(ipcInvoke).toHaveBeenCalledTimes(1);

    // Rule already live → a fresh transition never double-starts.
    useForwards.getState().apply(status({ state: "green" }));
    fixtures.sessions = [];
    pokeSessions(); // host drops out of the running set…
    fixtures.sessions = [{ kind: "ssh", status: "running", hostId: "h1" }];
    pokeSessions(); // …and comes back: rule is live, so no start.
    await flush();
    expect(ipcInvoke).toHaveBeenCalledTimes(1);

    // A red rule re-fires on the next transition — and a conflict toasts.
    useForwards.getState().apply(status({ state: "red", reason: "died" }));
    ipcInvoke.mockResolvedValueOnce({
      started: false,
      error: { kind: "port_in_use", message: "Port 8080 is in use by httpd (pid 4)" },
    });
    fixtures.sessions = [];
    pokeSessions();
    fixtures.sessions = [{ kind: "ssh", status: "running", hostId: "h1" }];
    pokeSessions();
    await flush();
    expect(ipcInvoke).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledWith(
      expect.stringContaining("Port 8080 is in use by httpd"),
    );

    // Exited and orphaned sessions never count as running.
    fixtures.sessions = [
      { kind: "ssh", status: "exited", hostId: "h1" },
      { kind: "ssh", status: "running", hostId: "h1", orphaned: true },
      { kind: "local", status: "running" },
    ];
    pokeSessions();
    fixtures.sessions = [];
    pokeSessions();
    await flush();
    expect(ipcInvoke).toHaveBeenCalledTimes(2);
  });
});
