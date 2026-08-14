/**
 * Tailnet state (F9, Phase 7): the sidebar's Tailnet section.
 *
 * Pull model (PLAN.md §3): `tailscale_peers` is polled every 30 s, paused
 * while the app is hidden — peers are ephemeral and never persisted. Peer
 * LEDs mirror Tailscale's own online state; these rows are never
 * TCP-probed. When the binary is absent or the daemon is logged
 * out/stopped, `available` is false and the section hides entirely.
 * The default login user lives in Settings → Tailnet (Phase 8) and is
 * fresh-read Rust-side on every poll.
 */

import { create } from "zustand";

import { ipcInvoke } from "../ipc/client";
import type { Host, TailscalePeer } from "../ipc/contract";
import { lastSeenLabel } from "./reach";
import type { LedInfo } from "./reach";
import type { SessionMeta } from "./sessions";
import { useToast } from "./toast";

/** How often the peer list refreshes while the app is visible (F9). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Builds the ephemeral {@link Host} a peer row connects as. The core
 * resolves the `ts:` id itself at spawn time — this record only feeds the
 * frontend session plumbing (label, hue, id).
 *
 * @param peer - The tailnet peer.
 * @param defaultUser - The `[tailnet]` default user from the last poll.
 * @returns A `source: "tailscale"` host record (never persisted).
 */
export function peerAsHost(peer: TailscalePeer, defaultUser: string): Host {
  return {
    id: peer.id,
    label: peer.hostName,
    group: "",
    tags: peer.tags,
    hue: stableHue(peer.id),
    hostname: peer.dnsName,
    user: defaultUser,
    port: 22,
    identity: "agent",
    use_mosh: false,
    startup: "",
    control_master: false,
    reachability: false,
    forwards: [],
    health: { enabled: false, interval_s: 30 },
    notes: "",
    favorite: false,
    source: "tailscale",
  };
}

/**
 * A stable 0–7 hue from a peer id — FNV-1a folded to 3 bits, matching the
 * Rust side so tabs and adopted rows agree.
 *
 * @param id - The peer's stable id.
 */
export function stableHue(id: string): number {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(hash % 8n);
}

/**
 * Splits peers into the Tailnet section's rows and the duplicates that
 * collapse into existing host rows (F9 edge case: same DNS name). The
 * returned map keys existing-host hostnames that earned a tailnet badge.
 *
 * @param peers - Peers from the last poll.
 * @param hosts - The current host list (Setu + imported).
 * @returns Visible peers plus the badge lookup.
 */
export function splitPeersAgainstHosts(
  peers: TailscalePeer[],
  hosts: Host[],
): { visible: TailscalePeer[]; badged: Set<string> } {
  const hostnames = new Set(
    hosts.map((host) => host.hostname.replace(/\.$/, "").toLowerCase()),
  );
  const visible: TailscalePeer[] = [];
  const badged = new Set<string>();
  for (const peer of peers) {
    const dns = peer.dnsName.toLowerCase();
    if (hostnames.has(dns)) {
      badged.add(dns);
    } else {
      visible.push(peer);
    }
  }
  return { visible, badged };
}

/**
 * A peer row's LED treatment: Tailscale's own online state, never a
 * probe (§3) — pulsing over it when a session runs on the peer.
 *
 * @param peer - The tailnet peer.
 * @param sessions - Live sessions (for the pulse).
 * @returns The §7 LED treatment.
 */
export function peerLedInfo(peer: TailscalePeer, sessions: SessionMeta[]): LedInfo {
  const live = sessions.some(
    (s) => s.hostId === peer.id && s.status === "running" && !s.orphaned,
  );
  if (live) return { state: "pulsing" };
  if (peer.online) return { state: "up" };
  return { state: "hollow", reason: peerOfflineLabel(peer.lastSeen) };
}

/**
 * The dimmed offline row's label, e.g. `"offline — last seen 3h ago"`.
 *
 * @param lastSeen - The peer's RFC 3339 last-seen, when known.
 * @param now - Injectable clock for tests (epoch ms).
 */
export function peerOfflineLabel(lastSeen?: string, now: number = Date.now()): string {
  if (lastSeen === undefined) return "offline";
  const seen = Date.parse(lastSeen);
  if (Number.isNaN(seen)) return "offline";
  return `offline — ${lastSeenLabel(seen, now)}`;
}

/** Store shape + actions for the Tailnet section. */
export interface TailnetState {
  /** Whether the tailnet is usable (binary + daemon + login). */
  available: boolean;
  /** Why not, when unavailable. */
  reason: string | null;
  /** The default login user from the last poll. */
  defaultUser: string;
  /** Live peers from the last poll (self excluded). */
  peers: TailscalePeer[];
  /** Whether polling has delivered at least once. */
  polled: boolean;

  /** Starts the 30s poll loop (idempotent); refreshes immediately. */
  start(): void;
  /** One immediate refresh. */
  refresh(): Promise<void>;
  /** Pauses/resumes polling on app visibility. */
  setVisible(visible: boolean): void;
  /** Warm the path to a peer (`tailscale ping`) and toast the outcome. */
  pingPeer(peer: TailscalePeer): Promise<void>;
}

/** The poll timer, module-level so start() stays idempotent. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Whether the app is visible (polling pauses hidden). */
let visible = true;

/** The tailnet store hook. */
export const useTailnet = create<TailnetState>((set, get) => ({
  available: false,
  reason: null,
  defaultUser: "",
  peers: [],
  polled: false,

  start(): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (visible) void get().refresh();
    }, POLL_INTERVAL_MS);
    void get().refresh();
  },

  async refresh(): Promise<void> {
    try {
      const result = await ipcInvoke("tailscale_peers", {});
      set({
        available: result.available,
        reason: result.reason ?? null,
        defaultUser: result.defaultUser,
        peers: result.peers,
        polled: true,
      });
    } catch (error) {
      // Infrastructure failure (not the graceful unavailable answer):
      // hide the section rather than show stale rows.
      set({ available: false, reason: String(error), peers: [], polled: true });
    }
  },

  setVisible(nowVisible: boolean): void {
    const wasHidden = !visible;
    visible = nowVisible;
    if (nowVisible && wasHidden) void get().refresh();
  },

  async pingPeer(peer: TailscalePeer): Promise<void> {
    const toast = useToast.getState();
    toast.show(`Pinging ${peer.hostName}…`);
    try {
      const { ok, summary } = await ipcInvoke("tailscale_ping", {
        target: peer.dnsName,
      });
      toast.show(summary, ok ? "success" : "error");
    } catch (error) {
      toast.show(String(error), "error");
    }
  },
}));

/**
 * App-mount wiring (F9): starts the 30 s poll loop and pauses it while
 * the window is hidden — peers are display data; a hidden app doesn't
 * need them fresh.
 */
export function initTailnet(): void {
  useTailnet.getState().start();
  document.addEventListener("visibilitychange", () => {
    useTailnet.getState().setVisible(document.visibilityState === "visible");
  });
}

/** Test-only reset (mirrors the other stores' reset helpers). */
export function resetTailnetForTests(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  visible = true;
  useTailnet.setState({
    available: false,
    reason: null,
    defaultUser: "",
    peers: [],
    polled: false,
  });
}
