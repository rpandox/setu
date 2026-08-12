import "./TabBar.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
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

/** A right-click context menu anchored to a tab. */
interface TabMenu {
  /** The session the menu acts on. */
  sessionId: string;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
}

/**
 * The 38px tab strip (PLAN.md §7 wireframe), rendering one tab per open
 * session. The whole bar is a window drag region; the active tab carries
 * the 2px underline with glow — one of the three legal uses of `--glow` —
 * colored by the host's identity hue for SSH tabs (F3), neon for local.
 * `+` (or ⌘N) opens a local shell tab; `×` (or ⌘W) closes one. Tabs whose
 * host was deleted append "(orphaned)" (F1).
 *
 * Right-click offers the F3 tab actions: Duplicate tab (SSH), Reconnect
 * (exited SSH), and Reconnect all (when anything is disconnected).
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
  const duplicateTab = useSessions((s) => s.duplicateTab);
  const reconnect = useSessions((s) => s.reconnect);
  const reconnectAll = useSessions((s) => s.reconnectAll);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLElement | null>(null);
  const [menu, setMenu] = useState<TabMenu | null>(null);

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

  const menuSession = menu
    ? sessions.find((s) => s.sessionId === menu.sessionId)
    : undefined;
  const anyExitedSsh = sessions.some((s) => s.status === "exited" && s.kind === "ssh");

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
        // Per-host identity hue drives the underline (F3); locals stay neon.
        const hueStyle =
          session.hue !== undefined
            ? ({ "--tab-hue": `var(--hue-${session.hue})` } as CSSProperties)
            : undefined;
        const title = session.orphaned ? `${session.title} (orphaned)` : session.title;
        return (
          <div
            key={session.sessionId}
            ref={active ? activeTabRef : undefined}
            className={classes}
            style={hueStyle}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActive(session.sessionId)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                sessionId: session.sessionId,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActive(session.sessionId);
              }
            }}
          >
            <span className="tab-title">{title}</span>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${title}`}
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
      {menu && menuSession && (
        <div
          className="tabmenu-scrim"
          onClick={() => setMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="tabmenu"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMenu(null);
            }}
          >
            {menuSession.kind === "ssh" && !menuSession.orphaned && (
              <button
                className="tabmenu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void duplicateTab(menuSession.sessionId);
                }}
              >
                Duplicate tab
              </button>
            )}
            {menuSession.kind === "ssh" && menuSession.status === "exited" && (
              <button
                className="tabmenu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void reconnect(menuSession.sessionId);
                }}
              >
                Reconnect
              </button>
            )}
            {anyExitedSsh && (
              <button
                className="tabmenu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  void reconnectAll();
                }}
              >
                Reconnect all
              </button>
            )}
            <button
              className="tabmenu-item"
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                closeTab(menuSession.sessionId);
              }}
            >
              Close tab
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
