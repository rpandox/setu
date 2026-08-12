/**
 * Minimal toast state (Phase 3, pulled forward for F4's dead-pane skip
 * notice — see the PLAN.md §5 decision log). One message at a time; the
 * Toast component auto-dismisses it. Phase 4's polish sweep restyles this
 * with the rest of the feedback states.
 */

import { create } from "zustand";

/** Store shape + actions for the single app toast. */
export interface ToastState {
  /** The visible message, or `null` when no toast is showing. */
  message: string | null;
  /** Bumped per show — re-arms the auto-dismiss timer for repeat messages. */
  seq: number;
  /** Shows a toast (replacing any current one). */
  show(message: string): void;
  /** Hides the toast. */
  clear(): void;
}

/** The toast store hook. */
export const useToast = create<ToastState>((set) => ({
  message: null,
  seq: 0,
  show(message: string): void {
    set((state) => ({ ...state, message, seq: state.seq + 1 }));
  },
  clear(): void {
    set((state) => ({ ...state, message: null }));
  },
}));
