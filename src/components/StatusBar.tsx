import "./StatusBar.css";
import { countBroadcastTargets, useBroadcast } from "../state/broadcast";
import { activeTabOf, useSessions } from "../state/sessions";

/**
 * The 24px status bar (PLAN.md §7 wireframe): host, cwd, latency, forward
 * count, and sync state as quiet mono chips — plus the F4 broadcast badge,
 * which appears (in warning red, like the pane hairlines) whenever the
 * active tab is broadcasting. Most chips are static placeholders until
 * their feature lands (latency in Phase 4, forwards in Phase 6, sync in
 * Phase 8).
 *
 * @returns The status bar element.
 */
export function StatusBar() {
  const activeTab = useSessions(activeTabOf);
  const sessions = useSessions((s) => s.sessions);
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

  return (
    <footer className="statusbar">
      <span className="statusbar-chip">⌁ hermes</span>
      <span className="statusbar-chip">~/apps</span>
      <span className="statusbar-chip">12ms</span>
      <span className="statusbar-chip">2 fwd</span>
      <span className="statusbar-chip">sync ✓</span>
      {broadcastCount > 0 && (
        <span className="statusbar-chip statusbar-chip--broadcast" role="status">
          ⇉ Broadcasting to {broadcastCount}
        </span>
      )}
    </footer>
  );
}
