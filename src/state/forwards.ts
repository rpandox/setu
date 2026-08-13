/**
 * Forward state (F7) — the Zustand store behind the ForwardsPopover and
 * the status-bar `⇌ N fwd` chip. Wraps `forward_start`/`forward_stop`,
 * mirrors every rule's health from the single `forward:update` channel,
 * and owns **auto-start**: rules saved with `auto = true` fire the moment
 * their host's first SSH session transitions to running (a sessions-store
 * subscription, so every connect path — tab, split, duplicate, restore —
 * triggers exactly once; PLAN.md §5, Phase 6 row).
 */

import { create } from "zustand";
import { ipcInvoke, onForwardUpdate } from "../ipc/client";
import type { ForwardStartResult, ForwardStatus, HostForward } from "../ipc/contract";
import { useHosts } from "./hosts";
import { useSessions } from "./sessions";
import { useToast } from "./toast";

/**
 * The stable key for a rule instance — must mirror `rule_key` in
 * `forwards.rs`: `{hostId}:{type}:{spec}`.
 *
 * @param hostId - The owning host's id.
 * @param rule - The rule.
 * @returns The registry key.
 */
export function ruleKeyOf(hostId: string, rule: HostForward): string {
  return `${hostId}:${rule.type}:${rule.spec}`;
}

/** Store shape + actions for forward rules. */
export interface ForwardsState {
  /**
   * Every rule the backend has reported on, keyed by rule key. Running
   * rules live here from `starting` on; a rule whose child died stays
   * with `state: "red"` (and its reason) until toggled off.
   */
  byRuleKey: Record<string, ForwardStatus>;
  /**
   * Starts a rule. Returns the raw result so the popover can render the
   * port-conflict helper (`error.suggestedPort`) inline.
   */
  start(hostId: string, rule: HostForward): Promise<ForwardStartResult>;
  /** Stops a rule (idempotent) and drops its status. */
  stop(ruleKey: string): Promise<void>;
  /** Applies one `forward:update` transition. */
  apply(status: ForwardStatus): void;
}

/**
 * The forwards store hook. Select narrowly in components
 * (`useForwards((s) => s.byRuleKey)`) to keep re-renders scoped.
 */
export const useForwards = create<ForwardsState>((set) => ({
  byRuleKey: {},

  async start(hostId: string, rule: HostForward): Promise<ForwardStartResult> {
    return ipcInvoke("forward_start", { hostId, rule });
  },

  async stop(ruleKey: string): Promise<void> {
    await ipcInvoke("forward_stop", { ruleKey });
    set((state) => {
      if (!(ruleKey in state.byRuleKey)) return state;
      const byRuleKey = { ...state.byRuleKey };
      delete byRuleKey[ruleKey];
      return { ...state, byRuleKey };
    });
  },

  apply(status: ForwardStatus): void {
    set((state) => ({
      ...state,
      byRuleKey: { ...state.byRuleKey, [status.ruleKey]: status },
    }));
  },
}));

/**
 * Counts the rules currently counted by the status-bar chip: everything
 * running or coming up — red rules are excluded (the popover shows them).
 *
 * @param byRuleKey - The store's status map.
 * @returns Active (starting/amber/green) rule count.
 */
export function activeForwardCount(byRuleKey: Record<string, ForwardStatus>): number {
  return Object.values(byRuleKey).filter((s) => s.state !== "red").length;
}

/**
 * A copy of `rule` with its bind port replaced — the popover's "Use N"
 * one-shot retry after a port conflict (never persisted; PLAN.md §5).
 * Handles the optional `bind-addr:` prefix on every kind.
 *
 * @param rule - The conflicting rule.
 * @param port - The suggested free port.
 * @returns The rewritten rule, marked `auto: false`.
 */
export function withBindPort(rule: HostForward, port: number): HostForward {
  const parts = rule.spec.split(":");
  // The bind port's position: D is [bind:]port (last-1 or last), L/R are
  // [bind:]port:host:port (index 1 with a bind prefix, 0 without).
  const index = rule.type === "D" ? parts.length - 1 : parts.length === 4 ? 1 : 0;
  parts[index] = String(port);
  return { type: rule.type, spec: parts.join(":"), auto: false };
}

/**
 * Splits a rule key back into its rule half — `{hostId}:{kind}:{spec}`
 * with the host id known (ids may contain `:`, e.g. `sshcfg:hermes`, so
 * the caller supplies it rather than parsing blind).
 *
 * @param ruleKey - The registry key.
 * @param hostId - The owning host's id (from the status payload).
 * @returns The reconstructed rule, or `null` for a foreign key.
 */
export function ruleFromKey(ruleKey: string, hostId: string): HostForward | null {
  const prefix = `${hostId}:`;
  if (!ruleKey.startsWith(prefix)) return null;
  const rest = ruleKey.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator === -1) return null;
  const type = rest.slice(0, separator);
  if (type !== "L" && type !== "R" && type !== "D") return null;
  return { type, spec: rest.slice(separator + 1), auto: false };
}

let wired = false;

/**
 * Wires the forwards machinery once (App calls it on mount): subscribes
 * the store to `forward:update`, and watches the sessions store for hosts
 * transitioning to "has a running SSH session" to fire their `auto` rules
 * — deduped against rules already live, so splits and duplicate tabs
 * never double-start. Auto-start failures surface as toasts.
 */
export function wireForwards(): void {
  if (wired) return;
  wired = true;
  void onForwardUpdate((status) => useForwards.getState().apply(status));

  let previouslyRunning = runningHostIds();
  useSessions.subscribe(() => {
    const running = runningHostIds();
    for (const hostId of running) {
      if (!previouslyRunning.has(hostId)) {
        autoStartFor(hostId);
      }
    }
    previouslyRunning = running;
  });
}

/** Host ids with at least one running, non-orphaned SSH session. */
function runningHostIds(): Set<string> {
  return new Set(
    useSessions
      .getState()
      .sessions.filter(
        (s) =>
          s.kind === "ssh" &&
          s.status === "running" &&
          s.hostId !== undefined &&
          !s.orphaned,
      )
      .map((s) => s.hostId as string),
  );
}

/**
 * Fires a host's `auto: true` rules that aren't already live (F7
 * auto-start). Failures — port conflicts included — surface as toasts;
 * the popover shows the full detail.
 *
 * @param hostId - The host that just gained a running session.
 */
function autoStartFor(hostId: string): void {
  const host = useHosts.getState().hosts.find((h) => h.id === hostId);
  if (!host) return;
  const live = useForwards.getState().byRuleKey;
  for (const rule of host.forwards) {
    if (!rule.auto) continue;
    const key = ruleKeyOf(hostId, rule);
    if (key in live && live[key].state !== "red") continue;
    void useForwards
      .getState()
      .start(hostId, rule)
      .then((result) => {
        if (!result.started && result.error) {
          useToast
            .getState()
            .show(`Forward ${rule.type} ${rule.spec}: ${result.error.message}`);
        }
      })
      .catch((error: unknown) => {
        useToast
          .getState()
          .show(`Forward ${rule.type} ${rule.spec} failed: ${String(error)}`);
      });
  }
}
