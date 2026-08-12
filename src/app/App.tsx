import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { TabBar } from "../components/TabBar";
import { TerminalArea } from "../components/TerminalArea";
import { useSessions } from "../state/sessions";
import "./App.css";

/**
 * The application shell: LED sidebar on the left; tab bar, terminal area, and
 * status bar stacked on the right (PLAN.md §7 wireframe).
 *
 * Owns the global keyboard map (PLAN.md §8) for Phase 1: ⌘/ sidebar,
 * ⌘N new local tab, ⌘W close tab, ⌘1–9 go to tab, ⌃Tab cycle tabs,
 * ⇧⌘F find. The listener runs in the capture phase so shortcuts work while
 * the terminal has focus.
 *
 * @returns The root layout element.
 */
export function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    /**
     * Dispatches the §8 keyboard map (Phase 1 subset).
     *
     * @param event - The keydown event from the window (capture phase).
     */
    const onKeyDown = (event: KeyboardEvent) => {
      const sessions = useSessions.getState();
      if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        event.preventDefault();
        sessions.cycleActive(event.shiftKey ? -1 : 1);
        return;
      }
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "/") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        void sessions.openLocalTab();
      } else if (key === "w" && !event.shiftKey) {
        if (sessions.activeSessionId) {
          event.preventDefault();
          sessions.closeTab(sessions.activeSessionId);
        }
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        sessions.toggleFind();
      } else if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
        event.preventDefault();
        sessions.activateByIndex(Number(event.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}`}>
      <Sidebar collapsed={sidebarCollapsed} />
      <div className="app-main">
        <TabBar trafficLightInset={sidebarCollapsed} />
        <TerminalArea />
        <StatusBar />
      </div>
    </div>
  );
}
