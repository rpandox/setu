/**
 * Settings store (Phase 8): the frontend's view of `settings.toml`.
 *
 * Both windows create their own instance of this store (the Settings
 * window is a separate webview — PLAN.md §5, settings-window-mechanics
 * row), so cross-window agreement rides the `settings:changed` event:
 * whoever saves, the core re-broadcasts the saved document and every
 * window's store converges on it. Hot-apply (fonts onto live terminals,
 * prober re-tune) is wired separately in the main window by
 * `wireSettingsHotApply` — this module stays free of terminal imports so
 * the dependency graph stays a tree.
 */

import { create } from "zustand";
import { ipcInvoke, onSettingsChanged } from "../ipc/client";
import type { SettingsDocument, SettingsFieldError } from "../ipc/contract";

/**
 * The built-in defaults, mirrored from the Rust side (`settings.rs`) so
 * the UI can render before the first load answers — and in tests.
 *
 * @returns A fresh default document (safe to mutate).
 */
export function defaultSettings(): SettingsDocument {
  return {
    reachability: { enabled: true, interval_s: 60, timeout_ms: 1500, max_concurrent: 6 },
    tailnet: { default_user: "" },
    terminal: { font_size: 13, scrollback_lines: 10_000 },
    sync: { auto_sync_on_quit: false },
    snapshots: { enabled: true, interval_days: 7, keep: 10 },
    flags: {},
  };
}

/** The settings store's state and actions. */
export interface SettingsState {
  /** The current document; defaults until the first load answers. */
  doc: SettingsDocument;
  /** Whether the first `settings_get` has answered. */
  loaded: boolean;
  /** Per-field errors from the last save attempt (empty when clean). */
  errors: SettingsFieldError[];
  /** Whether a save is in flight (disables the Save button). */
  saving: boolean;
  /** Load failure text, when `settings.toml` is unreadable/corrupt. */
  loadError: string | null;
  /** Loads the document from the core (fresh-parsed, hand edits included). */
  load(): Promise<void>;
  /**
   * Validates and saves `next`. On success the store updates immediately
   * (the `settings:changed` event confirms it in every window); on
   * validation failure `errors` fills and the document stays put.
   *
   * @param next - The full document to save.
   * @returns True when the save landed.
   */
  save(next: SettingsDocument): Promise<boolean>;
  /** Records a document broadcast by `settings:changed`. */
  recordChanged(doc: SettingsDocument): void;
}

/**
 * The settings store hook.
 *
 * @example
 * ```ts
 * const fontSize = useSettings((s) => s.doc.terminal.font_size);
 * ```
 */
export const useSettings = create<SettingsState>((set) => ({
  doc: defaultSettings(),
  loaded: false,
  errors: [],
  saving: false,
  loadError: null,

  async load(): Promise<void> {
    try {
      const doc = await ipcInvoke("settings_get", {});
      set({ doc, loaded: true, loadError: null });
    } catch (error) {
      set({ loaded: true, loadError: String(error) });
    }
  },

  async save(next: SettingsDocument): Promise<boolean> {
    set({ saving: true });
    try {
      const result = await ipcInvoke("settings_set", { document: next });
      if (result.settings) {
        set({ doc: result.settings, errors: [], saving: false });
        return true;
      }
      set({ errors: result.errors, saving: false });
      return false;
    } catch (error) {
      set({
        errors: [{ field: "", message: String(error) }],
        saving: false,
      });
      return false;
    }
  },

  recordChanged(doc: SettingsDocument): void {
    set({ doc, loaded: true, errors: [], loadError: null });
  },
}));

/**
 * Loads the document and wires the `settings:changed` listener — call
 * once per window at startup. Safe in both windows: the listener only
 * converges this window's store on whatever was saved anywhere.
 */
export async function initSettings(): Promise<void> {
  await onSettingsChanged((doc) => {
    useSettings.getState().recordChanged(doc);
  });
  await useSettings.getState().load();
}

/**
 * Opens (or focuses) the Settings window — ⌘, and the palette's "Open
 * settings" (§8). The window itself is built Rust-side
 * (`settings_window_open`), one place for its size and label.
 */
export async function openSettingsWindow(): Promise<void> {
  await ipcInvoke("settings_window_open", {});
}
