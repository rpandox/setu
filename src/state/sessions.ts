/**
 * Session/tab state (F2, F3) — the Zustand store behind the tab bar and
 * terminal area. State shape maps to PLAN.md §9 F2 (Phase 1 scope: local
 * tabs only).
 *
 * Terminal instances themselves live in the terminal registry, not here:
 * store state stays serializable metadata, and xterm objects survive React
 * re-renders on their own terms.
 */

import { create } from "zustand";
import { ipcInvoke, onPtyExit } from "../ipc/client";
import {
  createSessionTerminal,
  disposeSessionTerminal,
} from "../features/terminal/registry";

/** Metadata for one open session (one tab). */
export interface SessionMeta {
  /** The PTY session id from `pty_spawn`. */
  sessionId: string;
  /** Tab title; seeded "local", then follows the shell's title escapes. */
  title: string;
  /** Session kind. Phase 1: local shells only. */
  kind: "local";
  /** Whether the child is still running. */
  status: "running" | "exited";
  /** Exit code once exited (`null` = signal death). */
  exitCode: number | null;
}

/** Store shape + actions for sessions and tab UI state. */
export interface SessionsState {
  /** Open sessions, in tab order. */
  sessions: SessionMeta[];
  /** The focused session, or `null` when no tabs are open. */
  activeSessionId: string | null;
  /** Whether the find bar (⇧⌘F) is showing for the active tab. */
  findOpen: boolean;
  /** Spawns a local shell, wires its terminal, and focuses the new tab. */
  openLocalTab(): Promise<void>;
  /** Closes a tab: kills the PTY and removes the session immediately. */
  closeTab(sessionId: string): void;
  /** Focuses a tab by session id (no-op for unknown ids). */
  setActive(sessionId: string): void;
  /** Focuses a tab by position (⌘1–9); out-of-range is a no-op. */
  activateByIndex(index: number): void;
  /** Cycles the active tab (⌃Tab / ⌃⇧Tab). */
  cycleActive(direction: 1 | -1): void;
  /** Shows/hides the find bar. */
  toggleFind(): void;
}

/** Exit unsubscribers by session — imperative handles, kept out of state. */
const exitUnsubscribers = new Map<string, () => void>();

/**
 * The sessions store hook. Select narrowly in components
 * (`useSessions((s) => s.sessions)`) to keep re-renders scoped.
 */
export const useSessions = create<SessionsState>((set, get) => {
  /**
   * Removes a session from state and tears down its terminal + listeners.
   *
   * @param sessionId - The session to remove.
   */
  const removeSession = (sessionId: string): void => {
    exitUnsubscribers.get(sessionId)?.();
    exitUnsubscribers.delete(sessionId);
    disposeSessionTerminal(sessionId);
    set((state) => {
      const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
      if (index === -1) return state;
      const sessions = state.sessions.filter((s) => s.sessionId !== sessionId);
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === sessionId) {
        // Prefer the tab that slid into this slot, else the new last tab.
        const next = sessions[index] ?? sessions[sessions.length - 1];
        activeSessionId = next ? next.sessionId : null;
      }
      return { ...state, sessions, activeSessionId };
    });
  };

  /**
   * Applies a child exit: clean exits close the tab, failures keep it.
   *
   * @param sessionId - The session whose child exited.
   * @param code - Exit code, or `null` for a signal death.
   */
  const handleExit = (sessionId: string, code: number | null): void => {
    if (!get().sessions.some((s) => s.sessionId === sessionId)) return;
    if (code === 0) {
      removeSession(sessionId);
      return;
    }
    // Non-zero (or signal) exit: keep the tab so output stays inspectable;
    // the terminal area shows an exit notice and ⌘W closes.
    set((state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, status: "exited" as const, exitCode: code }
          : s,
      ),
    }));
  };

  return {
    sessions: [],
    activeSessionId: null,
    findOpen: false,

    async openLocalTab(): Promise<void> {
      // 80×24 is a placeholder; the pane fits and resizes right after open.
      const { sessionId } = await ipcInvoke("pty_spawn", {
        kind: "local",
        cols: 80,
        rows: 24,
      });
      const handle = await createSessionTerminal(sessionId);
      handle.term.onTitleChange((title) => {
        set((state) => ({
          ...state,
          sessions: state.sessions.map((s) =>
            s.sessionId === sessionId ? { ...s, title } : s,
          ),
        }));
      });
      const unlisten = await onPtyExit(sessionId, ({ code }) => {
        handleExit(sessionId, code);
      });
      exitUnsubscribers.set(sessionId, unlisten);
      set((state) => ({
        ...state,
        sessions: [
          ...state.sessions,
          {
            sessionId,
            title: "local",
            kind: "local",
            status: "running",
            exitCode: null,
          },
        ],
        activeSessionId: sessionId,
      }));
    },

    closeTab(sessionId: string): void {
      // Remove the UI immediately; the backend kill is idempotent, so this
      // can never race the child's own exit.
      void ipcInvoke("pty_kill", { sessionId }).catch(() => undefined);
      removeSession(sessionId);
    },

    setActive(sessionId: string): void {
      if (get().sessions.some((s) => s.sessionId === sessionId)) {
        set((state) => ({ ...state, activeSessionId: sessionId }));
      }
    },

    activateByIndex(index: number): void {
      const session = get().sessions[index];
      if (session) {
        set((state) => ({ ...state, activeSessionId: session.sessionId }));
      }
    },

    cycleActive(direction: 1 | -1): void {
      const { sessions, activeSessionId } = get();
      if (sessions.length === 0) return;
      const current = sessions.findIndex((s) => s.sessionId === activeSessionId);
      const next = (current + direction + sessions.length) % sessions.length;
      set((state) => ({ ...state, activeSessionId: sessions[next].sessionId }));
    },

    toggleFind(): void {
      set((state) => ({ ...state, findOpen: !state.findOpen }));
    },
  };
});
