import "./StatusBar.css";
import { useState } from "react";
import { ForwardsPopover } from "../features/forwards/ForwardsPopover";
import { countBroadcastTargets, useBroadcast } from "../state/broadcast";
import { activeForwardCount, useForwards } from "../state/forwards";
import { useHosts } from "../state/hosts";
import { useReach } from "../state/reach";
import { sessionSemantics, useSemantic } from "../state/semantic";
import { useSettings } from "../state/settings";
import { activeTabOf, tabSessionOf, useSessions } from "../state/sessions";
import { useSync } from "../state/sync";

/**
 * The 24px status bar (PLAN.md §7 wireframe): quiet mono chips showing only
 * real data — the focused pane's host (or `local`), its live latency from
 * the reachability prober, the F7 forwards chip (`⇌ N fwd`, click opens the
 * ForwardsPopover) whenever any host has rules, the F10 sync chip (visible
 * once a remote is configured — the wireframe's `sync ✓`, real since
 * Phase 8) — plus the F4 broadcast badge in warning red whenever the
 * active tab is broadcasting — and, with the semantic flag on, the F12 cwd
 * chip from OSC 7 (click opens the shell-integration installer; while no
 * integration has been seen on the focused pane the chip offers the
 * install instead, so the bar never shows a guess).
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
  const semanticOn = useSettings((s) => s.doc.flags.semantic_terminal === true);
  const semantics = useSemantic(sessionSemantics(focused?.sessionId));
  const openInstaller = useSemantic((s) => s.openInstaller);
  const syncStatus = useSync((s) => s.status);
  const syncing = useSync((s) => s.syncing);

  // Display-only mirror of the sidebar footer's dot; shown once a remote
  // exists (or a conflict demands attention) so "local mode" stays quiet.
  // Falsy check on purpose: an absent remote must hide the chip whichever
  // way the payload spells "none".
  const syncChip =
    syncStatus === null || (!syncStatus.remoteUrl && syncStatus.state !== "conflict")
      ? null
      : syncing
        ? "sync …"
        : syncStatus.state === "clean"
          ? "sync ✓"
          : syncStatus.state === "ahead"
            ? `sync ↑${syncStatus.ahead > 0 ? syncStatus.ahead : ""}`
            : syncStatus.state === "behind"
              ? `sync ↓${syncStatus.behind}`
              : syncStatus.state === "conflict"
                ? "sync ✕"
                : "sync local";

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
      {semanticOn && focused !== undefined && (
        <button
          className="statusbar-chip statusbar-chip--button statusbar-chip--cwd"
          type="button"
          title={
            semantics?.integration
              ? "Working directory (OSC 7) — click for shell integration options"
              : "No shell integration on this shell yet — click to install"
          }
          aria-label={
            semantics?.cwd !== undefined
              ? `Working directory ${semantics.cwd}`
              : "Install shell integration"
          }
          onClick={() =>
            openInstaller(
              focused.kind === "ssh" && focused.hostId !== undefined
                ? {
                    kind: "remote",
                    hostId: focused.hostId,
                    hostLabel: focused.hostLabel ?? focused.title,
                  }
                : { kind: "local" },
            )
          }
        >
          {semantics?.cwd !== undefined
            ? shortenHome(semantics.cwd)
            : "⌂ integrate shell"}
        </button>
      )}
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
      {syncChip !== null && (
        <span
          className={`statusbar-chip${syncStatus?.state === "conflict" ? " statusbar-chip--alert" : ""}`}
        >
          {syncChip}
        </span>
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

/**
 * Shortens a home-rooted path for the chip (`/Users/me/x` → `~/x`),
 * keeping the last three segments when it runs long.
 *
 * @param cwd - An absolute path.
 * @returns The display form.
 */
function shortenHome(cwd: string): string {
  const home = /^\/(?:Users|home)\/[^/]+/.exec(cwd);
  let out = home ? `~${cwd.slice(home[0].length)}` : cwd;
  if (out === "~" || out === "") return "~";
  const parts = out.split("/");
  if (parts.length > 4) out = `…/${parts.slice(-3).join("/")}`;
  return out;
}
