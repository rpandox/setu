/**
 * Tailnet store tests (F9, Phase 7): dedupe against hosts, LED mapping,
 * the peer→Host bridge, and the poll/refresh state handling.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/client", () => ({
  ipcInvoke: vi.fn(),
}));

import type { Host, TailscalePeer } from "../ipc/contract";
import { ipcInvoke } from "../ipc/client";
import type { SessionMeta } from "./sessions";
import {
  peerAsHost,
  peerLedInfo,
  peerOfflineLabel,
  resetTailnetForTests,
  splitPeersAgainstHosts,
  stableHue,
  useTailnet,
} from "./tailnet";

/**
 * A tailnet peer for tests.
 *
 * @param overrides - Fields to override on the base peer.
 */
function peer(overrides: Partial<TailscalePeer> = {}): TailscalePeer {
  return {
    id: "ts:peer-a",
    dnsName: "hermes.tail1234.ts.net",
    hostName: "hermes",
    os: "linux",
    online: true,
    tags: [],
    tsSsh: false,
    ...overrides,
  };
}

/**
 * A persisted host for the dedupe tests.
 *
 * @param hostname - The host's hostname.
 */
function host(hostname: string): Host {
  return {
    id: "h1",
    label: "hermes",
    group: "",
    tags: [],
    hue: 0,
    hostname,
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
  };
}

beforeEach(() => {
  resetTailnetForTests();
  vi.mocked(ipcInvoke).mockReset();
});

describe("splitPeersAgainstHosts", () => {
  it("collapses peers whose DNS name matches a host hostname", () => {
    const peers = [peer(), peer({ id: "ts:b", dnsName: "other.tail1234.ts.net" })];
    const { visible, badged } = splitPeersAgainstHosts(peers, [
      host("hermes.tail1234.ts.net"),
    ]);
    expect(visible.map((p) => p.id)).toEqual(["ts:b"]);
    expect(badged.has("hermes.tail1234.ts.net")).toBe(true);
  });

  it("matches case-insensitively and ignores trailing dots on hosts", () => {
    const { visible, badged } = splitPeersAgainstHosts(
      [peer({ dnsName: "Hermes.Tail1234.ts.net" })],
      [host("hermes.tail1234.ts.net.")],
    );
    expect(visible).toEqual([]);
    expect(badged.size).toBe(1);
  });

  it("keeps everything visible with no overlap", () => {
    const { visible, badged } = splitPeersAgainstHosts([peer()], [host("elsewhere.net")]);
    expect(visible.length).toBe(1);
    expect(badged.size).toBe(0);
  });
});

describe("peerLedInfo", () => {
  const running: SessionMeta = {
    sessionId: "s1",
    title: "hermes",
    kind: "ssh",
    hostId: "ts:peer-a",
    status: "running",
    exitCode: null,
  };

  it("mirrors Tailscale's online state — up, never probed", () => {
    expect(peerLedInfo(peer(), []).state).toBe("up");
  });

  it("pulses over a live session on the peer", () => {
    expect(peerLedInfo(peer(), [running]).state).toBe("pulsing");
  });

  it("shows offline peers hollow with the last-seen reason", () => {
    const led = peerLedInfo(
      peer({ online: false, lastSeen: "2026-08-10T09:00:00Z" }),
      [],
    );
    expect(led.state).toBe("hollow");
    expect(led.reason).toContain("offline");
  });
});

describe("peerOfflineLabel", () => {
  it("formats a known last-seen relative to now", () => {
    const seen = new Date("2026-08-13T11:00:00Z").getTime();
    const now = new Date("2026-08-13T14:00:00Z").getTime();
    expect(peerOfflineLabel(new Date(seen).toISOString(), now)).toBe(
      "offline — last seen 3h ago",
    );
  });

  it("degrades to plain offline without a timestamp", () => {
    expect(peerOfflineLabel(undefined)).toBe("offline");
    expect(peerOfflineLabel("not a date")).toBe("offline");
  });
});

describe("peerAsHost", () => {
  it("builds an ephemeral agent-first tailscale record", () => {
    const built = peerAsHost(peer({ tags: ["tag:prod"] }), "ops");
    expect(built.id).toBe("ts:peer-a");
    expect(built.hostname).toBe("hermes.tail1234.ts.net");
    expect(built.user).toBe("ops");
    expect(built.identity).toBe("agent");
    expect(built.source).toBe("tailscale");
    expect(built.port).toBe(22);
    expect(built.tags).toEqual(["tag:prod"]);
  });

  it("derives a stable hue in range", () => {
    expect(peerAsHost(peer(), "a").hue).toBe(peerAsHost(peer(), "b").hue);
    expect(stableHue("ts:peer-a")).toBeLessThan(8);
  });
});

describe("refresh", () => {
  it("stores an available answer's peers and default user", async () => {
    vi.mocked(ipcInvoke).mockResolvedValueOnce({
      available: true,
      defaultUser: "ops",
      peers: [peer()],
    });
    await useTailnet.getState().refresh();
    const state = useTailnet.getState();
    expect(state.available).toBe(true);
    expect(state.defaultUser).toBe("ops");
    expect(state.peers.length).toBe(1);
    expect(state.polled).toBe(true);
  });

  it("hides the section on the graceful unavailable answer", async () => {
    vi.mocked(ipcInvoke).mockResolvedValueOnce({
      available: false,
      reason: "logged out",
      defaultUser: "ops",
      peers: [],
    });
    await useTailnet.getState().refresh();
    expect(useTailnet.getState().available).toBe(false);
    expect(useTailnet.getState().reason).toBe("logged out");
  });

  it("hides the section on infrastructure failure too", async () => {
    vi.mocked(ipcInvoke).mockRejectedValueOnce(new Error("boom"));
    await useTailnet.getState().refresh();
    expect(useTailnet.getState().available).toBe(false);
    expect(useTailnet.getState().peers).toEqual([]);
  });
});
