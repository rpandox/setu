/**
 * Toast state (Phase 3, restyled in Phase 4's polish sweep — §5 decision
 * log). One message at a time with a semantic variant; the Toast component
 * auto-dismisses it.
 */

import { create } from "zustand";

/** Toast register: quiet info (default), success, or error. */
export type ToastVariant = "info" | "success" | "error";

/** Store shape + actions for the single app toast. */
export interface ToastState {
  /** The visible message, or `null` when no toast is showing. */
  message: string | null;
  /** The visible message's variant. */
  variant: ToastVariant;
  /** Bumped per show — re-arms the auto-dismiss timer for repeat messages. */
  seq: number;
  /** Shows a toast (replacing any current one). Default variant: info. */
  show(message: string, variant?: ToastVariant): void;
  /** Hides the toast. */
  clear(): void;
}

/** The toast store hook. */
export const useToast = create<ToastState>((set) => ({
  message: null,
  variant: "info",
  seq: 0,
  show(message: string, variant: ToastVariant = "info"): void {
    set((state) => ({ ...state, message, variant, seq: state.seq + 1 }));
  },
  clear(): void {
    set((state) => ({ ...state, message: null }));
  },
}));
