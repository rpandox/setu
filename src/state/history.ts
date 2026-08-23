/**
 * Command-history store (F12, Phase 10): the palette's History section
 * over `history_query`. Search runs core-side (SQLite, newest first); this
 * store debounces the palette's keystrokes, keeps the latest answer, and
 * drops stale answers that arrive out of order.
 *
 * Rows are reusable, never auto-run: `pasteIntoPane` writes the command to
 * the focused PTY **without** a carriage return (F12: "⏎ pastes into
 * current pane, never auto-runs").
 */

import { create } from "zustand";
import { ipcInvoke } from "../ipc/client";
import type { HistoryEntry } from "../ipc/contract";

/** Rows the palette shows. */
export const MAX_HISTORY_ROWS = 8;

/** Keystroke debounce before a query flies (ms). */
export const HISTORY_DEBOUNCE_MS = 80;

/** The store's state and actions. */
export interface HistoryState {
  /** The latest answer for the latest query. */
  rows: HistoryEntry[];
  /** Whether a query is in flight. */
  loading: boolean;
  /**
   * Searches (debounced). An empty query lists the newest commands.
   *
   * @param query - The palette text.
   */
  search(query: string): void;
  /** Clears rows (palette closed). */
  reset(): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

/** The history store hook. */
export const useHistory = create<HistoryState>((set) => ({
  rows: [],
  loading: false,
  search(query: string): void {
    if (timer !== undefined) clearTimeout(timer);
    const mine = ++generation;
    set({ loading: true });
    timer = setTimeout(() => {
      void ipcInvoke("history_query", { params: { query, limit: MAX_HISTORY_ROWS } })
        .then((result) => {
          if (mine === generation) set({ rows: result.entries, loading: false });
        })
        .catch(() => {
          if (mine === generation) set({ rows: [], loading: false });
        });
    }, HISTORY_DEBOUNCE_MS);
  },
  reset(): void {
    if (timer !== undefined) clearTimeout(timer);
    generation += 1;
    set({ rows: [], loading: false });
  },
}));

/**
 * Pastes a history row's command into a pane — insert only, no Enter.
 *
 * @param sessionId - The focused pane's session.
 * @param cmd - The command text.
 */
export function pasteIntoPane(sessionId: string, cmd: string): void {
  void ipcInvoke("pty_write", { sessionId, data: cmd }).catch(() => undefined);
}

/**
 * A compact relative time for history rows.
 *
 * @param ts - The row's timestamp (ms).
 * @param now - The current time (ms); injectable for tests.
 * @returns `"just now"`, `"5m ago"`, `"3h ago"`, `"yesterday"`, `"4d ago"`,
 * or an ISO date for anything older than a month.
 * @example
 * ```ts
 * relativeTime(now - 90_000, now); // "1m ago"
 * ```
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 31) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
