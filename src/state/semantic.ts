/**
 * Semantic-terminal store (F12, Phase 10): what the UI needs to know per
 * session from the shell integration — the live cwd (status bar chip, SFTP
 * follow-mode), whether the integration has been seen (every dependent
 * feature hides until then, F12 edge case), and the last completed command
 * (re-run, palette). The marks themselves stay in the terminal layer
 * (`features/terminal/semanticAttach.ts`) — they hold xterm markers, not
 * serializable state.
 *
 * Everything here is gated by `flags.semantic_terminal` (PLAN.md §5,
 * semantic-flag row): {@link semanticEnabled} is the one switch the
 * terminal layer and the actions consult.
 */

import { create } from "zustand";
import { useSettings } from "./settings";

/** Per-session semantic facts. */
export interface SessionSemantics {
  /** Whether any integration sequence has arrived on this session. */
  integration: boolean;
  /** The working directory from the last OSC 7, when known. */
  cwd?: string;
  /** The last completed command's text. */
  lastCmd?: string;
  /** The last completed command's exit status (`null` = none reported). */
  lastExit?: number | null;
  /** The last completed command's duration, ms. */
  lastDurationMs?: number;
  /** Completed-command count this session (the gutter's mark count). */
  completed: number;
}

/** Where the F12 installer dialog is pointed. */
export type InstallerTarget =
  | { kind: "local" }
  | {
      kind: "remote";
      /** The host to install on (`Host.id`). */
      hostId: string;
      /** The host's display label. */
      hostLabel: string;
    };

/** The store's state and actions. */
export interface SemanticState {
  /** Facts by session id. */
  bySession: Record<string, SessionSemantics>;
  /** The open installer dialog's target, or `null` when closed. */
  installer: InstallerTarget | null;
  /** Opens the installer dialog for a target. */
  openInstaller(target: InstallerTarget): void;
  /** Closes the installer dialog. */
  closeInstaller(): void;
  /** Merges facts for a session (creating the entry). */
  patch(sessionId: string, facts: Partial<SessionSemantics>): void;
  /** Forgets a closed session. */
  forget(sessionId: string): void;
}

/** The semantic store hook. */
export const useSemantic = create<SemanticState>((set) => ({
  bySession: {},
  installer: null,
  openInstaller(target): void {
    set({ installer: target });
  },
  closeInstaller(): void {
    set({ installer: null });
  },
  patch(sessionId, facts): void {
    set((state) => {
      const prev = state.bySession[sessionId] ?? { integration: false, completed: 0 };
      return { bySession: { ...state.bySession, [sessionId]: { ...prev, ...facts } } };
    });
  },
  forget(sessionId): void {
    set((state) => {
      if (!(sessionId in state.bySession)) return state;
      const next = { ...state.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));

/**
 * Whether the semantic terminal is switched on (`flags.semantic_terminal`).
 * Read at event time, never cached, so the Settings toggle applies live.
 *
 * @returns True when the flag is set.
 */
export function semanticEnabled(): boolean {
  return useSettings.getState().doc.flags.semantic_terminal === true;
}

/**
 * Selector: the facts for one session, or `undefined` when nothing has
 * been seen (and therefore every F12 surface should hide).
 *
 * @param sessionId - The session.
 * @returns A selector for `useSemantic`.
 * @example
 * ```ts
 * const cwd = useSemantic(sessionSemantics(id))?.cwd;
 * ```
 */
export function sessionSemantics(
  sessionId: string | undefined,
): (state: SemanticState) => SessionSemantics | undefined {
  return (state) => (sessionId === undefined ? undefined : state.bySession[sessionId]);
}
