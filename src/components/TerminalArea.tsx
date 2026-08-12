import "./TerminalArea.css";
import { FindBar } from "../features/terminal/FindBar";
import { TerminalPane } from "../features/terminal/TerminalPane";
import { useSessions } from "../state/sessions";

/**
 * The terminal viewport. With no sessions it shows the empty state — an
 * invitation, not an error (PLAN.md §7 interface writing). With sessions it
 * stacks one {@link TerminalPane} per tab: all panes stay mounted (xterm
 * state survives tab switches) and inactive ones are hidden with
 * `visibility` — never `display: none`, which would zero their measurements
 * and break fitting.
 *
 * @returns The terminal area element.
 */
export function TerminalArea() {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const findOpen = useSessions((s) => s.findOpen);
  const findFocusSeq = useSessions((s) => s.findFocusSeq);
  const closeFind = useSessions((s) => s.closeFind);
  const reconnect = useSessions((s) => s.reconnect);

  if (sessions.length === 0) {
    return (
      <main className="terminal-area terminal-area--empty">
        <div className="terminal-empty">
          <h1 className="terminal-empty-title">No hosts yet</h1>
          <p className="terminal-empty-hint">
            Press <kbd>⌘T</kbd> to connect, or <kbd>⌘N</kbd> for a local shell
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="terminal-area">
      {sessions.map((session) => {
        const active = session.sessionId === activeSessionId;
        const reconnectable =
          session.status === "exited" && session.kind === "ssh" && !session.orphaned;
        return (
          <div
            key={session.sessionId}
            className={`terminal-host${active ? "" : " terminal-host--hidden"}`}
          >
            <TerminalPane sessionId={session.sessionId} active={active} />
            {session.status === "exited" && (
              <div className="terminal-exit-notice" role="status">
                {session.kind === "ssh" ? "connection closed" : "exited"}
                {session.exitCode !== null ? ` (code ${session.exitCode})` : ""}
                {reconnectable && (
                  <>
                    {" — "}
                    <button
                      className="terminal-reconnect"
                      type="button"
                      onClick={() => void reconnect(session.sessionId)}
                    >
                      Reconnect
                    </button>{" "}
                    <kbd>⏎</kbd>
                  </>
                )}
                {" — "}
                <kbd>⌘W</kbd> to close
              </div>
            )}
          </div>
        );
      })}
      {findOpen && activeSessionId && (
        <FindBar
          sessionId={activeSessionId}
          focusSeq={findFocusSeq}
          onClose={closeFind}
        />
      )}
    </main>
  );
}
