import "./TerminalArea.css";
import { FindBar } from "../features/terminal/FindBar";
import { SplitContainer } from "../features/splits/SplitContainer";
import { activeSessionOf, useSessions } from "../state/sessions";

/**
 * The terminal viewport. With no tabs it shows the empty state — an
 * invitation, not an error (PLAN.md §7 interface writing). With tabs it
 * renders one {@link SplitContainer} per tab: all tabs (and every pane in
 * them) stay mounted so xterm state survives tab switches, and inactive
 * tabs hide with `visibility` — never `display: none`, which would zero
 * their measurements and break fitting.
 *
 * @returns The terminal area element.
 */
export function TerminalArea() {
  const tabs = useSessions((s) => s.tabs);
  const activeTabId = useSessions((s) => s.activeTabId);
  const findOpen = useSessions((s) => s.findOpen);
  const findFocusSeq = useSessions((s) => s.findFocusSeq);
  const closeFind = useSessions((s) => s.closeFind);
  const activeSession = useSessions(activeSessionOf);

  if (tabs.length === 0) {
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
      {tabs.map((tab) => (
        <SplitContainer key={tab.tabId} tab={tab} hidden={tab.tabId !== activeTabId} />
      ))}
      {findOpen && activeSession && (
        <FindBar
          sessionId={activeSession.sessionId}
          focusSeq={findFocusSeq}
          onClose={closeFind}
        />
      )}
    </main>
  );
}
