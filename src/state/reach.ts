/**
 * Reachability state (F1, Phase 4) — the Zustand store behind the LED
 * board. One `reach:update` listener feeds per-host probe results; the
 * sidebar, palette, and status bar derive LED treatments and latency chips
 * from here via {@link ledInfoOf}.
 *
 * The store never probes anything itself: the Rust prober owns sweeps and
 * their pacing (`docs/dev/ipc.md`), the frontend just (re)starts it —
 * on boot and after host CRUD — and reports window visibility so probing
 * can pause while the app is hidden.
 */

import { create } from "zustand";
import { ipcInvoke, onReachUpdate } from "../ipc/client";
import type { Host, ReachUpdate } from "../ipc/contract";
import { useHosts } from "./hosts";
import type { SessionMeta } from "./sessions";

/** What the store knows about one host's reachability. */
export interface HostReach {
  /** Latest probe outcome; `"unknown"` until the first result arrives. */
  state: "unknown" | "up" | "down";
  /** Connect latency of the latest successful probe, in ms. */
  rttMs?: number;
  /** Epoch ms of the last `"up"` result — the red LED's "last seen". */
  lastUpAt?: number;
}

/** Store shape + actions for reachability results. */
export interface ReachState {
  /** Probe results keyed by host id. */
  byHost: Record<string, HostReach>;
  /**
   * Whether the prober is running. `false` before {@link initReach} and
   * when the global kill switch (`settings.reachability.enabled`) is off —
   * every LED stays hollow then.
   */
  probing: boolean;
  /** Applies one probe result (the `reach:update` handler). */
  apply(update: ReachUpdate, now?: number): void;
  /** Records whether the prober reported itself started. */
  setProbing(probing: boolean): void;
}

/**
 * The reachability store hook. Select narrowly in components
 * (`useReach((s) => s.byHost)`) to keep re-renders scoped.
 */
export const useReach = create<ReachState>((set) => ({
  byHost: {},
  probing: false,

  apply(update: ReachUpdate, now: number = Date.now()): void {
    set((state) => {
      const previous = state.byHost[update.hostId];
      const next: HostReach =
        update.state === "up"
          ? { state: "up", rttMs: update.rttMs, lastUpAt: now }
          : { state: "down", lastUpAt: previous?.lastUpAt };
      return { ...state, byHost: { ...state.byHost, [update.hostId]: next } };
    });
  },

  setProbing(probing: boolean): void {
    set((state) => (state.probing === probing ? state : { ...state, probing }));
  },
}));

/** The four LED treatments of the §7 board table. */
export type LedState = "hollow" | "up" | "down" | "pulsing";

/** Everything a component needs to render one host's LED + latency chip. */
export interface LedInfo {
  /** Which §7 treatment to draw. */
  state: LedState;
  /** Latency for the chip; present when the latest probe was `"up"`. */
  rttMs?: number;
  /** Epoch ms of the last successful probe (red-LED hover). */
  lastUpAt?: number;
  /** Why a hollow LED is hollow (tooltip); only set for `"hollow"`. */
  reason?: string;
}

/**
 * Derives a host's LED treatment (§7 table) from probe results and live
 * sessions. Pure — callers pass subscribed slices.
 *
 * Priority: a running session pulses (the probe result still feeds the
 * chip); otherwise probe state decides; hosts the prober never touches
 * (kill switches, alias-only imports) stay hollow with the reason.
 *
 * @param host - The host row being rendered.
 * @param byHost - The reach store's results map.
 * @param sessions - Open sessions (a running one on this host ⇒ pulse).
 * @param probing - Whether the prober is running at all.
 * @returns The LED treatment plus chip/tooltip data.
 */
export function ledInfoOf(
  host: Host,
  byHost: Record<string, HostReach>,
  sessions: SessionMeta[],
  probing: boolean,
): LedInfo {
  const reach = byHost[host.id];
  const live = sessions.some(
    (s) => s.hostId === host.id && s.status === "running" && !s.orphaned,
  );
  if (live) {
    return { state: "pulsing", rttMs: reach?.rttMs, lastUpAt: reach?.lastUpAt };
  }
  if (!probing) {
    return { state: "hollow", reason: "Reachability probing is off" };
  }
  if (!host.reachability) {
    return { state: "hollow", reason: "Reachability off for this host" };
  }
  if (host.hostname.trim() === "") {
    return { state: "hollow", reason: "Alias-only import — adopt to probe" };
  }
  if (reach === undefined || reach.state === "unknown") {
    return { state: "hollow", reason: "Probing…" };
  }
  if (reach.state === "up") {
    return { state: "up", rttMs: reach.rttMs, lastUpAt: reach.lastUpAt };
  }
  return { state: "down", lastUpAt: reach.lastUpAt };
}

/**
 * Human "last seen" label for the red LED's hover (F1).
 *
 * @param lastUpAt - Epoch ms of the last successful probe, if any.
 * @param now - Epoch ms of "now" (injectable for tests).
 * @returns e.g. `"last seen 5m ago"`, `"last seen just now"`, or
 * `"never seen up"` when the host has not answered since launch.
 */
export function lastSeenLabel(lastUpAt: number | undefined, now: number = Date.now()): string {
  if (lastUpAt === undefined) return "never seen up";
  const seconds = Math.max(0, Math.floor((now - lastUpAt) / 1000));
  if (seconds < 10) return "last seen just now";
  if (seconds < 60) return `last seen ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `last seen ${hours}h ago`;
}

let reachWired = false;

/**
 * (Re)starts the Rust prober and records whether it is running — invoked on
 * boot and again after host CRUD so a new host lights up without waiting a
 * full probe interval. A `started: false` result (global kill switch off)
 * is an expected outcome: LEDs simply stay hollow.
 */
export async function refreshReach(): Promise<void> {
  try {
    const { started } = await ipcInvoke("reach_start", {});
    useReach.getState().setProbing(started);
  } catch (error) {
    // A corrupt settings.toml must not break the app — the board stays
    // hollow and the console says why.
    useReach.getState().setProbing(false);
    console.error("reach_start failed:", error);
  }
}

/**
 * Wires the reachability pipeline once at app start: subscribes to
 * `reach:update`, starts the prober, restarts it whenever the host list
 * changes (CRUD reloads), and reports `document.visibilitychange` so
 * probing pauses while the app is hidden (F1).
 */
export function initReach(): void {
  if (reachWired) return;
  reachWired = true;

  void onReachUpdate((update) => {
    useReach.getState().apply(update);
  });

  // Host CRUD always ends in a hosts reload; a fresh sweep keeps the board
  // in step with the list. The backend re-derives targets itself, so this
  // is purely about sweeping *now* instead of at the next interval.
  let prevHosts = useHosts.getState().hosts;
  useHosts.subscribe((state) => {
    if (state.hosts !== prevHosts) {
      prevHosts = state.hosts;
      void refreshReach();
    }
  });

  document.addEventListener("visibilitychange", () => {
    void ipcInvoke("reach_set_visible", { visible: !document.hidden });
  });

  void refreshReach();
}
