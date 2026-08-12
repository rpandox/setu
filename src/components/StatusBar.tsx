import "./StatusBar.css";

/**
 * The 24px status bar (PLAN.md §7 wireframe): host, cwd, latency, forward
 * count, and sync state as quiet mono chips. All values are static
 * placeholders in Phase 0 — each chip lights up for real as its feature
 * lands (latency in Phase 4, forwards in Phase 6, sync in Phase 8).
 *
 * @returns The status bar element.
 */
export function StatusBar() {
  return (
    <footer className="statusbar">
      <span className="statusbar-chip">⌁ hermes</span>
      <span className="statusbar-chip">~/apps</span>
      <span className="statusbar-chip">12ms</span>
      <span className="statusbar-chip">2 fwd</span>
      <span className="statusbar-chip">sync ✓</span>
    </footer>
  );
}
