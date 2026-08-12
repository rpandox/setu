import "./TerminalArea.css";

/**
 * The terminal viewport. Phase 0 shows only the empty state — an invitation,
 * not an error (PLAN.md §7 interface writing). xterm.js panes land in
 * Phase 1 (F2).
 *
 * @returns The terminal area element.
 */
export function TerminalArea() {
  return (
    <main className="terminal-area">
      <div className="terminal-empty">
        <h1 className="terminal-empty-title">No hosts yet</h1>
        <p className="terminal-empty-hint">
          Import from ~/.ssh/config or press <kbd>⌘T</kbd>
        </p>
      </div>
    </main>
  );
}
