/**
 * Snippet state (F6) — the Zustand store behind the SnippetDrawer (⌘J),
 * the palette's Snippets section, and the run dialog. Wraps the
 * `snippet_*` IPC family; every mutation refetches `snippet_list` so the
 * store mirrors `snippets.toml` exactly (the hosts-store pattern).
 *
 * Running is orchestrated here too: {@link SnippetsState.runSnippet} takes
 * a resolved variable set and a target — the focused pane, the armed
 * broadcast set, or a new tab per selected host — and writes the command
 * through `pty_write`, never through the paste path (the run dialog is the
 * explicit confirmation; the paste guard stays for pastes).
 */

import Fuse, { type IFuseOptions } from "fuse.js";
import { create } from "zustand";
import { ipcInvoke } from "../ipc/client";
import type {
  FrecencyEntry,
  Host,
  Snippet,
  SnippetFieldError,
  SnippetImportResult,
} from "../ipc/contract";
import { resolveCommand } from "../features/snippets/variables";
import { resolvePtyWriteTargets } from "./broadcast";
import { frecencyScore, snippetSubject } from "./frecency";
import { useHosts } from "./hosts";
import { activeSessionOf, useSessions } from "./sessions";
import { useToast } from "./toast";

/**
 * What the drawer's editor pane is doing: closed, creating, or editing the
 * snippet with the given id.
 */
export type SnippetEditorTarget = null | "new" | string;

/** Where a snippet run sends its command (F6 targets). */
export type SnippetRunTarget = "current-pane" | "broadcast" | "new-tabs";

/** Everything {@link SnippetsState.runSnippet} needs besides the snippet. */
export interface SnippetRunContext {
  /** The chosen target. */
  target: SnippetRunTarget;
  /** Hosts to open (one new tab each); `"new-tabs"` only. */
  hostIds?: string[];
  /** Resolved variable values keyed by name (empty for var-free snippets). */
  values: Record<string, string>;
}

/** Store shape + actions for snippets, the drawer, and the run dialog. */
export interface SnippetsState {
  /** All snippets, in `snippets.toml` order. */
  snippets: Snippet[];
  /** Error from the last `snippet_list` (e.g. a corrupt `snippets.toml`). */
  loadError: string | null;
  /** Whether the SnippetDrawer is open (⌘J). */
  drawerOpen: boolean;
  /** What the drawer's editor pane is showing. */
  editorTarget: SnippetEditorTarget;
  /** The snippet awaiting the run dialog, or `null`. */
  pendingRun: Snippet | null;
  /** Loads (or reloads) the snippet list from the core. */
  load(): Promise<void>;
  /** Toggles the SnippetDrawer (⌘J); closing also closes the editor pane. */
  toggleDrawer(): void;
  /** Opens the editor pane to create (`"new"`) or edit (a snippet id). */
  openEditor(target: Exclude<SnippetEditorTarget, null>): void;
  /** Closes the editor pane (the drawer stays). */
  closeEditor(): void;
  /**
   * Validates and saves a draft. On success the editor closes and the list
   * reloads; on validation failure the errors come back for inline display.
   */
  saveSnippet(draft: Snippet): Promise<SnippetFieldError[]>;
  /** Deletes a snippet (idempotent) and reloads the list. */
  deleteSnippet(snippetId: string): Promise<void>;
  /** Opens the run dialog for a snippet (palette ⏎, drawer Run). */
  requestRun(snippet: Snippet): void;
  /** Closes the run dialog without running. */
  cancelRun(): void;
  /**
   * Resolves the command and writes it (with a trailing newline) to the
   * target. Aborts with a toast — before anything executes — when a
   * variable is unresolved (F6 edge case), the focused pane is missing or
   * exited, or a target host is unknown.
   */
  runSnippet(snippet: Snippet, context: SnippetRunContext): Promise<void>;
  /**
   * Imports a pack from a dialog-picked path and reloads. Returns the
   * import counters; read/parse/validation failures reject with the
   * backend's message (the caller toasts it).
   */
  importPack(
    path: string,
    mergeStrategy: "replace" | "keep",
  ): Promise<SnippetImportResult>;
  /** Exports snippets as a pack file at a dialog-picked path. */
  exportPack(ids: string[], path: string): Promise<void>;
}

/**
 * The snippets store hook. Select narrowly in components
 * (`useSnippets((s) => s.snippets)`) to keep re-renders scoped.
 */
export const useSnippets = create<SnippetsState>((set, get) => ({
  snippets: [],
  loadError: null,
  drawerOpen: false,
  editorTarget: null,
  pendingRun: null,

  async load(): Promise<void> {
    try {
      const snippets = await ipcInvoke("snippet_list", {});
      set((state) => ({ ...state, snippets, loadError: null }));
    } catch (error) {
      set((state) => ({ ...state, loadError: String(error) }));
    }
  },

  toggleDrawer(): void {
    set((state) =>
      state.drawerOpen
        ? { ...state, drawerOpen: false, editorTarget: null }
        : { ...state, drawerOpen: true },
    );
  },

  openEditor(target: Exclude<SnippetEditorTarget, null>): void {
    set((state) => ({ ...state, editorTarget: target }));
  },

  closeEditor(): void {
    set((state) => ({ ...state, editorTarget: null }));
  },

  async saveSnippet(draft: Snippet): Promise<SnippetFieldError[]> {
    const result = await ipcInvoke("snippet_upsert", { snippet: draft });
    if (result.errors && result.errors.length > 0) {
      return result.errors;
    }
    set((state) => ({ ...state, editorTarget: null }));
    await get().load();
    return [];
  },

  async deleteSnippet(snippetId: string): Promise<void> {
    await ipcInvoke("snippet_delete", { snippetId });
    set((state) => ({
      ...state,
      editorTarget: state.editorTarget === snippetId ? null : state.editorTarget,
    }));
    await get().load();
  },

  requestRun(snippet: Snippet): void {
    set((state) => ({ ...state, pendingRun: snippet }));
  },

  cancelRun(): void {
    set((state) => (state.pendingRun === null ? state : { ...state, pendingRun: null }));
  },

  async runSnippet(snippet: Snippet, context: SnippetRunContext): Promise<void> {
    const toast = useToast.getState();
    const { command, missing } = resolveCommand(snippet.command, context.values);
    if (missing.length > 0) {
      // F6 edge case: an unresolved variable aborts before execution.
      toast.show(`Unresolved variable {{${missing[0]}}} — nothing was run`);
      return;
    }
    const data = `${command}\n`;

    if (context.target === "new-tabs") {
      const hostIds = context.hostIds ?? [];
      const known = new Map(
        useHosts.getState().hosts.map((host) => [host.id, host] as const),
      );
      const targets = hostIds
        .map((id) => known.get(id))
        .filter((host): host is Host => host !== undefined);
      if (targets.length === 0) {
        toast.show("No hosts selected — nothing was run");
        return;
      }
      // Sequential so tab order matches the picker; the ssh handshakes
      // themselves proceed concurrently inside each PTY child.
      for (const host of targets) {
        const sessionId = await useSessions.getState().openSshTab(host);
        // The write lands in the PTY's stdin buffer immediately; ssh hands
        // it to the remote shell once the session opens (PLAN.md §5).
        await ipcInvoke("pty_write", { sessionId, data });
      }
      return;
    }

    const focused = activeSessionOf(useSessions.getState());
    if (!focused || focused.status !== "running") {
      toast.show("Snippets need a running focused pane");
      return;
    }
    if (context.target === "current-pane") {
      await ipcInvoke("pty_write", { sessionId: focused.sessionId, data });
      return;
    }
    // Broadcast: fan out exactly like typed input would (dead panes are
    // skipped with the resolver's own toast).
    const targets = resolvePtyWriteTargets(focused.sessionId);
    await Promise.all(
      targets.map((sessionId) => ipcInvoke("pty_write", { sessionId, data })),
    );
  },

  async importPack(
    path: string,
    mergeStrategy: "replace" | "keep",
  ): Promise<SnippetImportResult> {
    const outcome = await ipcInvoke("snippet_import", { path, mergeStrategy });
    await get().load();
    return outcome;
  },

  async exportPack(ids: string[], path: string): Promise<void> {
    await ipcInvoke("snippet_export", { ids, path });
  },
}));

/**
 * The tuned fuse.js options for snippets: label \> tags \> command, same
 * threshold discipline as the hosts search (Phase 4).
 */
const FUSE_OPTIONS: IFuseOptions<Snippet> = {
  keys: [
    { name: "label", weight: 1 },
    { name: "tags", weight: 0.5 },
    { name: "command", weight: 0.3 },
  ],
  threshold: 0.35,
  ignoreLocation: true,
  includeScore: true,
};

/**
 * Palette snippet ranking (F6): fuzzy match blended with frecency, the
 * exact `rankHosts` recipe. With an empty query, snippets order by
 * frecency then label, so your working set floats up.
 *
 * @param snippets - The snippets to rank.
 * @param query - The palette query; may be empty.
 * @param frecency - Frecency records from `state.json` (F11).
 * @param now - Epoch ms of "now" (injectable for tests).
 * @returns Snippets, best first.
 */
export function rankSnippets(
  snippets: Snippet[],
  query: string,
  frecency: Record<string, FrecencyEntry>,
  now: number = Date.now(),
): Snippet[] {
  const boostOf = (snippet: Snippet): number =>
    frecencyScore(frecency[snippetSubject(snippet.id)], now);
  const trimmed = query.trim();
  if (trimmed === "") {
    return [...snippets].sort((a, b) => {
      const boost = boostOf(b) - boostOf(a);
      if (boost !== 0) return boost;
      return a.label.localeCompare(b.label);
    });
  }
  return new Fuse(snippets, FUSE_OPTIONS)
    .search(trimmed)
    .map((result) => ({
      snippet: result.item,
      score: (result.score ?? 0) / (1 + Math.log2(1 + boostOf(result.item))),
    }))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.snippet);
}
