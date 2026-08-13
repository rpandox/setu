import { useEffect } from "react";
import { Sidebar } from "../components/Sidebar";
import { StatusBar } from "../components/StatusBar";
import { TabBar } from "../components/TabBar";
import { TerminalArea } from "../components/TerminalArea";
import { HostEditor } from "../features/hosts/HostEditor";
import { KeysPanel } from "../features/keys/KeysPanel";
import { CommandPalette } from "../features/palette/CommandPalette";
import { PasteGuardDialog } from "../features/broadcast/PasteGuardDialog";
import { SnippetDrawer } from "../features/snippets/SnippetDrawer";
import { SnippetRunDialog } from "../features/snippets/SnippetRunDialog";
import { Toast } from "../components/Toast";
import { dispatchShortcut } from "../state/actions";
import { useBroadcast, wireBroadcastHousekeeping } from "../state/broadcast";
import { wireForwards } from "../state/forwards";
import { useHosts } from "../state/hosts";
import { initReach } from "../state/reach";
import { activeSessionOf, useSessions } from "../state/sessions";
import { useSnippets } from "../state/snippets";
import { useUiChrome } from "../state/ui";
import { initUiState } from "../state/uiState";
import "./App.css";

/**
 * The application shell: LED sidebar on the left; tab bar, terminal area,
 * and status bar stacked on the right (PLAN.md §7 wireframe), with the
 * HostEditor drawer and the ⌘K/⌘T command palette floating above.
 *
 * The global keyboard map (PLAN.md §8) lives in the action registry
 * (`src/state/actions.ts`) — the keydown handler here just dispatches
 * through it in the capture phase, so shortcuts work while the terminal
 * has focus and can never drift from what the palette lists. The one
 * contextual exception stays local: plain ⏎ reconnects an exited SSH pane
 * (F3) unless an overlay owns the keyboard.
 *
 * @returns The root layout element.
 */
export function App() {
  const sidebarCollapsed = useUiChrome((s) => s.sidebarCollapsed);

  useEffect(() => {
    // Hosts feed the sidebar and the palette; load once at startup.
    void useHosts.getState().load();
    // Snippets feed the palette's Snippets section and the ⌘J drawer (F6).
    void useSnippets.getState().load();
    // Broadcast follows tab lifecycle: auto-disarm on switch, prune closed
    // panes (F4). Wired lazily to avoid a module-evaluation cycle.
    wireBroadcastHousekeeping();
    // state.json: hydrate prefs, wire persistence, and — when opted in —
    // restore the saved layout (F4).
    void initUiState();
    // The LED board: start the prober, wire reach:update, follow host CRUD
    // and window visibility (F1, Phase 4).
    initReach();
    // Forwards: wire forward:update and the auto-start-on-connect
    // subscription (F7, Phase 6).
    wireForwards();
  }, []);

  useEffect(() => {
    /**
     * Dispatches the §8 keyboard map through the action registry, then the
     * contextual plain-⏎ reconnect (F3).
     *
     * @param event - The keydown event from the window (capture phase).
     */
    const onKeyDown = (event: KeyboardEvent) => {
      if (dispatchShortcut(event)) {
        event.preventDefault();
        return;
      }
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        useUiChrome.getState().paletteMode === null &&
        useHosts.getState().editorTarget === null &&
        useBroadcast.getState().pendingPaste === null &&
        !useSnippets.getState().drawerOpen &&
        useSnippets.getState().pendingRun === null
      ) {
        const sessions = useSessions.getState();
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
      <HostEditor />
      <KeysPanel />
      <SnippetDrawer />
      <SnippetRunDialog />
      <CommandPalette />
      <PasteGuardDialog />
      <Toast />
    </div>
  );
}
