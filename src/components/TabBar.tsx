import "./TabBar.css";
import { useEffect, useRef } from "react";
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
 * Overflowing tabs scroll horizontally (trackpad swipe, or a plain mouse
 * wheel mapped sideways); activating a tab always scrolls it into view.
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
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Keep the active tab visible however it was reached (⌘1–9, ⌃Tab, click).
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSessionId]);

  useEffect(() => {
    // Mice only scroll vertically; steer that motion along the strip. A
    // native non-passive listener because React's delegated wheel handlers
    // are passive — preventDefault there is a no-op, and without it the
    // gesture would also feed whatever scrollable picks it up beneath.
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <header
      ref={stripRef}
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
            ref={active ? activeTabRef : undefined}
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
