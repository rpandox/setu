/**
 * Session/tab state (F2, F3) — the Zustand store behind the tab bar and
 * terminal area. State shape maps to PLAN.md §9 F2/F3 (Phase 2 scope:
 * local shells and SSH sessions).
 *
 * Terminal instances themselves live in the terminal registry, not here:
 * store state stays serializable metadata, and xterm objects survive React
 * re-renders on their own terms.
 */

import { create } from "zustand";
import type { Host } from "../ipc/contract";
import { ipcInvoke, onPtyExit } from "../ipc/client";
import {
  createSessionTerminal,
  disposeSessionTerminal,
  getSessionTerminal,
  rebindSessionTerminal,
} from "../features/terminal/registry";

/** Metadata for one open session (one tab). */
export interface SessionMeta {
  /** The PTY session id from `pty_spawn`. */
  sessionId: string;
  /**
   * Tab title; seeded from the host label (or "local"), then follows the
   * child's OSC 0/2 title escapes (F3).
   */
  title: string;
  /** Session kind. */
  kind: "local" | "ssh";
  /** The connected host's id — `undefined` for local tabs. */
  hostId?: string;
  /** The host label at connect time (reconnect/duplicate reuse it). */
  hostLabel?: string;
  /** The host's identity hue 0–7 (tab underline); `undefined` for local. */
  hue?: number;
  /** Whether the child is still running. */
  status: "running" | "exited";
  /** Exit code once exited (`null` = signal death). */
  exitCode: number | null;
  /**
   * True when the session's host was deleted mid-session (F1: sessions
   * stay alive, tabs mark "(orphaned)").
   */
  orphaned?: boolean;
}

/** Store shape + actions for sessions and tab UI state. */
export interface SessionsState {
  /** Open sessions, in tab order. */
  sessions: SessionMeta[];
  /** The focused session, or `null` when no tabs are open. */
  activeSessionId: string | null;
  /** Whether the find bar (⇧⌘F) is showing for the active tab. */
  findOpen: boolean;
  /**
   * Bumped every time ⇧⌘F fires — including while the bar is already open,
   * where the bar refocuses and reselects instead of closing.
   */
  findFocusSeq: number;
  /** Spawns a local shell, wires its terminal, and focuses the new tab. */
  openLocalTab(): Promise<void>;
  /** Spawns `ssh` to a host, wires its terminal, and focuses the new tab. */
  openSshTab(host: Host): Promise<void>;
  /**
   * Reconnects an exited SSH tab in place: fresh PTY, same xterm (scrollback
   * survives). No-op for running tabs, local tabs, and unknown ids (F3).
   */
  reconnect(sessionId: string): Promise<void>;
  /** Reconnects every exited SSH tab ("Reconnect all", F3). */
  reconnectAll(): Promise<void>;
  /** Opens a second session to the same host ("Duplicate tab", F3). */
  duplicateTab(sessionId: string): Promise<void>;
  /** Flags every session on `hostId` as orphaned (its host was deleted). */
  markOrphaned(hostId: string): void;
  /** Closes a tab: kills the PTY and removes the session immediately. */
  closeTab(sessionId: string): void;
  /** Focuses a tab by session id (no-op for unknown ids). */
  setActive(sessionId: string): void;
  /** Focuses a tab by position (⌘1–9); out-of-range is a no-op. */
  activateByIndex(index: number): void;
  /** Cycles the active tab (⌃Tab / ⌃⇧Tab). */
  cycleActive(direction: 1 | -1): void;
  /** Opens the find bar — or, when already open, refocuses it (⇧⌘F). */
  openFind(): void;
  /** Closes the find bar (Esc or the ✕ button). */
  closeFind(): void;
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
    // the terminal area shows an exit notice — with Reconnect for SSH (F3).
    set((state) => ({
      ...state,
      sessions: state.sessions.map((s) =>
        s.sessionId === sessionId
          ? { ...s, status: "exited" as const, exitCode: code }
          : s,
      ),
    }));
  };

  /**
   * Shared tail of every spawn: create the terminal, follow title escapes,
   * subscribe to exit, and append + focus the new tab.
   *
   * @param meta - The new session's metadata (already spawned).
   */
  const wireSession = async (meta: SessionMeta): Promise<void> => {
    const { sessionId } = meta;
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
      sessions: [...state.sessions, meta],
      activeSessionId: sessionId,
    }));
  };

  /**
   * Spawns `ssh` to a host and opens its tab — the shared engine behind
   * {@link SessionsState.openSshTab} and {@link SessionsState.duplicateTab}.
   *
   * @param hostId - The host to connect to.
   * @param hostLabel - Label to seed the tab title with.
   * @param hue - The host's identity hue.
   */
  const openSsh = async (
    hostId: string,
    hostLabel: string,
    hue: number,
  ): Promise<void> => {
    // 80×24 is a placeholder; the pane fits and resizes right after open.
    const { sessionId } = await ipcInvoke("pty_spawn", {
      kind: "ssh",
      hostId,
      cols: 80,
      rows: 24,
    });
    await wireSession({
      sessionId,
      title: hostLabel,
      kind: "ssh",
      hostId,
      hostLabel,
      hue,
      status: "running",
      exitCode: null,
    });
  };

  return {
    sessions: [],
    activeSessionId: null,
    findOpen: false,
    findFocusSeq: 0,

    async openLocalTab(): Promise<void> {
      const { sessionId } = await ipcInvoke("pty_spawn", {
        kind: "local",
        cols: 80,
        rows: 24,
      });
      await wireSession({
        sessionId,
        title: "local",
        kind: "local",
        status: "running",
        exitCode: null,
      });
    },

    async openSshTab(host: Host): Promise<void> {
      await openSsh(host.id, host.label, host.hue);
    },

    async reconnect(sessionId: string): Promise<void> {
      const meta = get().sessions.find((s) => s.sessionId === sessionId);
      if (!meta || meta.status !== "exited" || meta.kind !== "ssh" || !meta.hostId) {
        return;
      }
      const handle = getSessionTerminal(sessionId);
      const { sessionId: newId } = await ipcInvoke("pty_spawn", {
        kind: "ssh",
        hostId: meta.hostId,
        // Reuse the terminal's real size; the pane refits right after anyway.
        cols: handle?.term.cols ?? 80,
        rows: handle?.term.rows ?? 24,
      });
      const rebound = await rebindSessionTerminal(sessionId, newId);
      if (!rebound) return;
      exitUnsubscribers.get(sessionId)?.();
      exitUnsubscribers.delete(sessionId);
      const unlisten = await onPtyExit(newId, ({ code }) => {
        handleExit(newId, code);
      });
      exitUnsubscribers.set(newId, unlisten);
      set((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.sessionId === sessionId
            ? {
                ...s,
                sessionId: newId,
                status: "running" as const,
                exitCode: null,
              }
            : s,
        ),
        activeSessionId:
          state.activeSessionId === sessionId ? newId : state.activeSessionId,
      }));
      rebound.term.focus();
    },

    async reconnectAll(): Promise<void> {
      const exited = get()
        .sessions.filter((s) => s.status === "exited" && s.kind === "ssh")
        .map((s) => s.sessionId);
      for (const sessionId of exited) {
        await get().reconnect(sessionId);
      }
    },

    async duplicateTab(sessionId: string): Promise<void> {
      const meta = get().sessions.find((s) => s.sessionId === sessionId);
      if (!meta || meta.kind !== "ssh" || !meta.hostId || meta.orphaned) return;
      await openSsh(meta.hostId, meta.hostLabel ?? meta.title, meta.hue ?? 0);
    },

    markOrphaned(hostId: string): void {
      set((state) => ({
        ...state,
        sessions: state.sessions.map((s) =>
          s.hostId === hostId ? { ...s, orphaned: true } : s,
        ),
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

    openFind(): void {
      // Always bump the sequence: a bar that is already open refocuses on
      // the change instead of toggling closed (matching every other find UI).
      set((state) => ({
        ...state,
        findOpen: true,
        findFocusSeq: state.findFocusSeq + 1,
      }));
    },

    closeFind(): void {
      set((state) => ({ ...state, findOpen: false }));
    },
  };
});
