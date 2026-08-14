/**
 * Sync store (F10, Phase 8): the frontend's view of the config repo —
 * the sidebar footer dot, its popover, and the Settings sync section all
 * read here. One `sync:update` listener keeps it live from either window
 * (every mutating sync command re-broadcasts its fresh status); a refresh
 * on window focus catches out-of-band `git` activity.
 */

import { create } from "zustand";
import { ipcInvoke, onSyncUpdate } from "../ipc/client";
import type {
  GitSyncRunResult,
  GitSyncStatus,
  LintBlockedLine,
  SetRemoteResult,
} from "../ipc/contract";

/** The sync store's state and actions. */
export interface SyncStoreState {
  /** The last known status; `null` until the first read answers. */
  status: GitSyncStatus | null;
  /** Whether a "Sync now" is in flight (spinner on the dot). */
  syncing: boolean;
  /** Human-readable failure from the last run (fetch/push trouble). */
  lastMessage: string | null;
  /** Lines the secrets lint refused on the last run (empty when clean). */
  lastBlocked: LintBlockedLine[];
  /** Reads a fresh status from the core (local git calls, no network). */
  refresh(): Promise<void>;
  /**
   * Runs "Sync now". Lint blocks and conflicts land in the store for the
   * popover; the result also returns for the caller's toast.
   *
   * @returns The run result, or `null` on an infrastructure failure.
   */
  syncNow(): Promise<GitSyncRunResult | null>;
  /**
   * Points the config repo's `origin` at `url` (empty removes it).
   *
   * @param url - The remote URL.
   * @returns The command's result (bad URLs come back `ok: false`).
   */
  setRemote(url: string): Promise<SetRemoteResult>;
  /** Aborts the paused rebase — "Cancel sync". */
  abortSync(): Promise<void>;
  /** Opens the config dir in Finder (the F10 conflict path). */
  openDir(): Promise<void>;
  /** Records a status broadcast by `sync:update`. */
  recordUpdate(status: GitSyncStatus): void;
}

/**
 * The sync store hook.
 *
 * @example
 * ```ts
 * const state = useSync((s) => s.status?.state ?? "local");
 * ```
 */
export const useSync = create<SyncStoreState>((set) => ({
  status: null,
  syncing: false,
  lastMessage: null,
  lastBlocked: [],

  async refresh(): Promise<void> {
    try {
      const status = await ipcInvoke("git_sync_status", {});
      set({ status });
    } catch (error) {
      set({ lastMessage: String(error) });
    }
  },

  async syncNow(): Promise<GitSyncRunResult | null> {
    set({ syncing: true });
    try {
      const result = await ipcInvoke("git_sync_run", {});
      set({
        status: result.status,
        syncing: false,
        lastMessage: result.message ?? null,
        lastBlocked: result.blocked,
      });
      return result;
    } catch (error) {
      set({ syncing: false, lastMessage: String(error) });
      return null;
    }
  },

  async setRemote(url: string): Promise<SetRemoteResult> {
    try {
      const result = await ipcInvoke("git_sync_set_remote", { url });
      if (result.ok && result.status) {
        set({ status: result.status, lastMessage: null });
      } else if (result.message) {
        set({ lastMessage: result.message });
      }
      return result;
    } catch (error) {
      const message = String(error);
      set({ lastMessage: message });
      return { ok: false, message };
    }
  },

  async abortSync(): Promise<void> {
    try {
      const status = await ipcInvoke("git_sync_abort", {});
      set({ status, lastMessage: null });
    } catch (error) {
      set({ lastMessage: String(error) });
    }
  },

  async openDir(): Promise<void> {
    try {
      await ipcInvoke("sync_open_dir", {});
    } catch (error) {
      set({ lastMessage: String(error) });
    }
  },

  recordUpdate(status: GitSyncStatus): void {
    set({ status });
  },
}));

/**
 * Wires the `sync:update` listener, reads the initial status, and
 * refreshes on window focus (out-of-band `git` activity in the config
 * dir shows up when the user comes back). Call once per window at
 * startup.
 */
export async function initSync(): Promise<void> {
  await onSyncUpdate((status) => {
    useSync.getState().recordUpdate(status);
  });
  window.addEventListener("focus", () => {
    void useSync.getState().refresh();
  });
  await useSync.getState().refresh();
}
