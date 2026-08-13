import "./StatusBar.css";
import { useState } from "react";
import { ForwardsPopover } from "../features/forwards/ForwardsPopover";
import { countBroadcastTargets, useBroadcast } from "../state/broadcast";
import { activeForwardCount, useForwards } from "../state/forwards";
import { useHosts } from "../state/hosts";
import { useReach } from "../state/reach";
import { activeTabOf, tabSessionOf, useSessions } from "../state/sessions";

/**
 * The 24px status bar (PLAN.md §7 wireframe): quiet mono chips showing only
 * real data — the focused pane's host (or `local`), its live latency from
 * the reachability prober, the F7 forwards chip (`⇌ N fwd`, click opens the
 * ForwardsPopover) whenever any host has rules — plus the F4 broadcast
 * badge in warning red whenever the active tab is broadcasting. Chips for
 * features that haven't landed (cwd → Phase 10, sync → Phase 8) return
 * with their phases instead of showing placeholders (PLAN.md §5, Phase 4
 * row).
 *
 * @returns The status bar element.
 */
export function StatusBar() {
  const activeTab = useSessions(activeTabOf);
  const sessions = useSessions((s) => s.sessions);
  const focused = activeTab ? tabSessionOf(sessions, activeTab) : undefined;
  const rttMs = useReach((s) =>
    focused?.hostId !== undefined ? s.byHost[focused.hostId]?.rttMs : undefined,
  );
  const broadcastArmed = useBroadcast((s) =>
    activeTab ? (s.active[activeTab.tabId] ?? false) : false,
  );
  const selectedPanes = useBroadcast((s) =>
    activeTab ? s.selected[activeTab.tabId] : undefined,
  );
  const broadcastCount =
    activeTab && broadcastArmed
      ? countBroadcastTargets(activeTab, sessions, selectedPanes ?? [])
      : 0;
  const byRuleKey = useForwards((s) => s.byRuleKey);
  const anyRulesConfigured = useHosts((s) =>
    s.hosts.some((host) => host.forwards.length > 0),
  );
  const forwardCount = activeForwardCount(byRuleKey);
  const [forwardsOpen, setForwardsOpen] = useState(false);

  const hostChip =
    focused === undefined
      ? null
      : focused.kind === "ssh"
        ? `⌁ ${focused.hostLabel ?? focused.title}${focused.orphaned ? " (orphaned)" : ""}`
        : "⌁ local";

  return (
    <footer className="statusbar">
      {hostChip !== null && <span className="statusbar-chip">{hostChip}</span>}
      {rttMs !== undefined && <span className="statusbar-chip">{rttMs}ms</span>}
      {(anyRulesConfigured || Object.keys(byRuleKey).length > 0) && (
        <button
          className="statusbar-chip statusbar-chip--button"
          type="button"
          aria-label={`Port forwards: ${forwardCount} active`}
          aria-expanded={forwardsOpen}
          onClick={() => setForwardsOpen((open) => !open)}
        >
          ⇌ {forwardCount} fwd
        </button>
      )}
      {broadcastCount > 0 && (
        <span className="statusbar-chip statusbar-chip--broadcast" role="status">
          ⇉ Broadcasting to {broadcastCount}
        </span>
      )}
      {forwardsOpen && <ForwardsPopover onClose={() => setForwardsOpen(false)} />}
    </footer>
  );
}
