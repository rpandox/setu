import "./TabBar.css";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { tabSessionOf, useSessions } from "../state/sessions";

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
  /** The tab the menu acts on. */
  tabId: string;
  /** Viewport coordinates of the click. */
  x: number;
  y: number;
}

/**
 * The 38px tab strip (PLAN.md §7 wireframe), rendering one tab per open
 * tab — since Phase 3 a tab may hold several split panes; its title, hue,
 * and exit state follow the tab's *active pane*. The whole bar is a window
 * drag region; the active tab carries the 2px underline with glow — one of
 * the three legal uses of `--glow` — colored by the host's identity hue for
 * SSH panes (F3), neon for local. `+` (or ⌘N) opens a local shell tab; `×`
 * closes the whole tab (every pane; ⌘W closes just the active pane, F4).
 * Tabs whose host was deleted append "(orphaned)" (F1).
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
  const tabs = useSessions((s) => s.tabs);
  const activeTabId = useSessions((s) => s.activeTabId);
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
  }, [activeTabId]);

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

  const menuTab = menu ? tabs.find((t) => t.tabId === menu.tabId) : undefined;
  const menuSession = menuTab ? tabSessionOf(sessions, menuTab) : undefined;
  const anyExitedSsh = sessions.some((s) => s.status === "exited" && s.kind === "ssh");

  return (
    <header
      ref={stripRef}
      className={`tabbar${trafficLightInset ? " tabbar--inset" : ""}`}
      data-tauri-drag-region
      role="tablist"
    >
      {tabs.map((tab) => {
        const meta = tabSessionOf(sessions, tab);
        if (!meta) return null;
        const active = tab.tabId === activeTabId;
        const classes = [
          "tab",
          active ? "tab--active" : "",
          meta.status === "exited" ? "tab--exited" : "",
        ]
          .filter(Boolean)
          .join(" ");
        // Per-host identity hue drives the underline (F3); locals stay neon.
        const hueStyle =
          meta.hue !== undefined
            ? ({ "--tab-hue": `var(--hue-${meta.hue})` } as CSSProperties)
            : undefined;
        const title = meta.orphaned ? `${meta.title} (orphaned)` : meta.title;
        return (
          <div
            key={tab.tabId}
            ref={active ? activeTabRef : undefined}
            className={classes}
            style={hueStyle}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActive(tab.tabId)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActive(tab.tabId);
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
                closeTab(tab.tabId);
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
      {menu && menuTab && menuSession && (
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
                  void duplicateTab(menuTab.tabId);
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
                closeTab(menuTab.tabId);
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
