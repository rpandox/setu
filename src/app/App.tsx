import { useEffect, useState } from "react";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { TabBar } from "../components/TabBar";
import { TerminalArea } from "../components/TerminalArea";
import { HostEditor } from "../features/hosts/HostEditor";
import { QuickConnect } from "../features/palette/QuickConnect";
import { PasteGuardDialog } from "../features/broadcast/PasteGuardDialog";
import { Toast } from "../components/Toast";
import { useBroadcast, wireBroadcastHousekeeping } from "../state/broadcast";
import { useHosts } from "../state/hosts";
import { initReach } from "../state/reach";
import { activeSessionOf, useSessions } from "../state/sessions";
import type { FocusDirection } from "../state/splits";
import { initUiState } from "../state/uiState";
import "./App.css";

/** ⌥⌘-arrow keys → pane focus directions (F4). */
const ARROW_DIRECTIONS: Record<string, FocusDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * The application shell: LED sidebar on the left; tab bar, terminal area, and
 * status bar stacked on the right (PLAN.md §7 wireframe), with the HostEditor
 * drawer and ⌘T quick connect floating above.
 *
 * Owns the global keyboard map (PLAN.md §8): ⌘/ sidebar, ⌘T quick connect,
 * ⌘N new local tab, ⌘D/⇧⌘D split right/down, ⌥⌘-arrows move pane focus,
 * ⌘W close pane, ⌘1–9 go to tab, ⌃Tab cycle tabs, ⇧⌘F find, and plain ⏎
 * to reconnect an exited SSH pane (F3). The listener runs in the capture
 * phase so shortcuts work while the terminal has focus; overlays (palette,
 * editor) suppress the ⏎ shortcut.
 *
 * @returns The root layout element.
 */
export function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);

  useEffect(() => {
    // Hosts feed the sidebar and ⌘T; load once at startup.
    void useHosts.getState().load();
    // Broadcast follows tab lifecycle: auto-disarm on switch, prune closed
    // panes (F4). Wired lazily to avoid a module-evaluation cycle.
    wireBroadcastHousekeeping();
    // state.json: hydrate prefs, wire persistence, and — when opted in —
    // restore the saved layout (F4).
    void initUiState();
    // The LED board: start the prober, wire reach:update, follow host CRUD
    // and window visibility (F1, Phase 4).
    initReach();
  }, []);

  useEffect(() => {
    /**
     * Dispatches the §8 keyboard map (Phase 2 subset).
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
      // ⌥⌘-arrows move pane focus (F4) — checked before the plain-⌘ guard
      // below, which rejects the alt modifier.
      if (event.metaKey && event.altKey && !event.ctrlKey) {
        const direction = ARROW_DIRECTIONS[event.key];
        if (direction) {
          event.preventDefault();
          sessions.movePaneFocus(direction);
        }
        return;
      }
      if (!event.metaKey || event.ctrlKey || event.altKey) {
        // Plain ⏎ reconnects the active exited SSH pane (F3) — unless an
        // overlay owns the keyboard right now.
        if (
          event.key === "Enter" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          !quickConnectOpen &&
          useHosts.getState().editorTarget === null &&
          useBroadcast.getState().pendingPaste === null
        ) {
          const active = activeSessionOf(sessions);
          if (
            active &&
            active.status === "exited" &&
            active.kind === "ssh" &&
            !active.orphaned
          ) {
            event.preventDefault();
            void sessions.reconnect(active.sessionId);
          }
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "/") {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      } else if (key === "t" && !event.shiftKey) {
        event.preventDefault();
        setQuickConnectOpen((open) => !open);
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        void sessions.openLocalTab();
      } else if (key === "d") {
        // ⌘D splits right, ⇧⌘D splits down (F4).
        event.preventDefault();
        void sessions.splitPane(event.shiftKey ? "col" : "row");
      } else if (key === "w" && !event.shiftKey) {
        // ⌘W closes the active pane; a tab's last pane closes the tab (§8).
        event.preventDefault();
        sessions.closePane();
      } else if (key === "b" && event.shiftKey) {
        // ⇧⌘B arms/disarms broadcast for the active tab (F4).
        event.preventDefault();
        useBroadcast.getState().toggleBroadcast();
      } else if (key === "f" && event.shiftKey) {
        event.preventDefault();
        sessions.openFind();
      } else if (/^[1-9]$/.test(event.key) && !event.shiftKey) {
        event.preventDefault();
        sessions.activateByIndex(Number(event.key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [quickConnectOpen]);

  return (
    <div className={`app${sidebarCollapsed ? " app--sidebar-collapsed" : ""}`}>
      <Sidebar collapsed={sidebarCollapsed} />
      <div className="app-main">
        <TabBar trafficLightInset={sidebarCollapsed} />
        <TerminalArea />
        <StatusBar />
      </div>
      <HostEditor />
      {quickConnectOpen && <QuickConnect onClose={() => setQuickConnectOpen(false)} />}
      <PasteGuardDialog />
      <Toast />
    </div>
  );
}
