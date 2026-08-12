import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { TabBar } from "../components/TabBar";
import { TerminalArea } from "../components/TerminalArea";
import "./App.css";

/**
 * The application shell: LED sidebar on the left; tab bar, terminal area, and
 * status bar stacked on the right (PLAN.md §7 wireframe).
 *
 * Phase 0 renders static placeholder content. The single piece of behavior is
 * the ⌘/ sidebar collapse required by the Phase 0 acceptance checklist.
 *
 * @returns The root layout element.
 */
export function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    /**
     * Toggles the sidebar on ⌘/ (PLAN.md §8 keyboard map).
     *
     * @param event - The keydown event from the window.
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === "/") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
