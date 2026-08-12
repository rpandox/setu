import "./TabBar.css";
import { useSessions } from "../state/sessions";

/**
 * Props for the {@link TabBar} component.
 */
export interface TabBarProps {
  /**
   * When true, pad the left edge so tabs clear the macOS traffic lights —
   * needed while the sidebar (which normally sits under them) is collapsed.
   */
  trafficLightInset: boolean;
}

/**
 * The 38px tab strip (PLAN.md §7 wireframe), rendering one tab per open
 * session. The whole bar is a window drag region; the active tab carries
 * the 2px neon underline with glow — one of the three legal uses of
 * `--glow`. `+` (or ⌘N) opens a local shell tab; `×` (or ⌘W) closes one.
 *
 * @param props - {@link TabBarProps}
 * @returns The tab bar element.
 */
export function TabBar({ trafficLightInset }: TabBarProps) {
  const sessions = useSessions((s) => s.sessions);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const setActive = useSessions((s) => s.setActive);
  const closeTab = useSessions((s) => s.closeTab);
  const openLocalTab = useSessions((s) => s.openLocalTab);

  return (
    <header
      className={`tabbar${trafficLightInset ? " tabbar--inset" : ""}`}
      data-tauri-drag-region
      role="tablist"
    >
      {sessions.map((session) => {
        const active = session.sessionId === activeSessionId;
        const classes = [
          "tab",
          active ? "tab--active" : "",
          session.status === "exited" ? "tab--exited" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={session.sessionId}
            className={classes}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActive(session.sessionId)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActive(session.sessionId);
              }
            }}
          >
            <span className="tab-title">{session.title}</span>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${session.title}`}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(session.sessionId);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        className="tab-new"
        type="button"
        aria-label="New local shell tab (⌘N)"
        onClick={() => void openLocalTab()}
      >
        +
      </button>
    </header>
  );
}
