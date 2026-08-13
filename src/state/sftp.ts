/**
 * SFTP panel state (F5): the connection lifecycle, both pane listings,
 * the transfer queue, and the host-key prompt.
 *
 * Shape of the feature (PLAN.md §5, Phase 5 rows):
 * - ⇧⌘S toggles a full-size overlay for the focused SSH session's host.
 *   Hiding the panel does **not** disconnect — a running 200 MB upload must
 *   survive a peek at the terminal. The connection closes on host switch,
 *   spontaneous failure, or app exit (the Rust sweep).
 * - The **queue** lives here: at most {@link MAX_RUNNING} transfers run at
 *   once, the rest wait as `"queued"`; a transfer that fails with
 *   `retryable: true` (dropped connection, timeout) re-queues itself once.
 *   The backend moves single files and streams progress events; folders
 *   expand here into per-file transfers.
 * - An unknown host key parks `sftp_connect` while `hostkeyPrompt` drives
 *   the FingerprintDialog; the verdict goes back via `hostkey_trust`.
 * - A `needsSecret` connect result (F8) drives the SecretPromptDialog:
 *   the user types the password/passphrase, `keychain_set` stores it, and
 *   the connect retries. The secret never lives in this store.
 */

import { create } from "zustand";

import { ipcInvoke, localHomeDir, onHostkeyPrompt, onSftpProgress } from "../ipc/client";
import type { HostkeyPromptEvent, SftpEntry, SftpNeedsSecret } from "../ipc/contract";
import { joinPath, parentPath, splitForCompletion } from "../features/sftp/listing";
import type { SortKey, SortSpec } from "../features/sftp/listing";
import { cycleSort, DEFAULT_SORT } from "../features/sftp/listing";
import { useToast } from "./toast";

/** Which side of the dual-pane browser a value belongs to. */
export type PaneSide = "local" | "remote";

/** The SFTP connection lifecycle. */
export type SftpConnState = "idle" | "connecting" | "connected" | "error";

/** One pane's listing state. */
export interface PaneState {
  /** The directory being shown (absolute). */
  path: string;
  /** The full unfiltered listing (hidden filter and sort are view-side). */
  entries: SftpEntry[];
  /** Whether a listing is in flight. */
  loading: boolean;
  /** The last operation error for this pane, or `null`. */
  error: string | null;
  /** Selected entry names. */
  selected: string[];
}

/** A transfer's place in its lifecycle (the queue adds `"queued"`). */
export type TransferState = "queued" | "running" | "done" | "failed" | "cancelled";

/** One row of the transfer queue. */
export interface TransferItem {
  /** Stable UI key, minted here (the backend id arrives later). */
  clientId: string;
  /** The backend transfer id once running, else `null`. */
  transferId: string | null;
  /** Which way the bytes flow. */
  direction: "upload" | "download";
  /** Display name (the file's base name). */
  name: string;
  /** Absolute local path. */
  localPath: string;
  /** Absolute remote path. */
  remotePath: string;
  /** Lifecycle state. */
  state: TransferState;
  /** Bytes moved so far. */
  bytes: number;
  /** Total bytes expected; `0` when unknown. */
  total: number;
  /** Current rate, derived from successive progress events. */
  speedBps: number;
  /** The failure message, when `state` is `"failed"`. */
  error?: string;
  /** Whether the auto-retry already happened (retry ×1, F5). */
  retried: boolean;
}

/** Max transfers moving at once (F5: queue with concurrency 3). */
const MAX_RUNNING = 3;

/**
 * An in-flight pane⇄pane pointer drag. HTML5 drag-and-drop is unusable
 * here — Tauri's native drag layer (which Finder→app drops need) swallows
 * webview drops on macOS — so the panes drag with plain mouse events and
 * this bit of state (PLAN.md §5, Phase 5 review row).
 */
export interface DragState {
  /** The pane the drag started in. */
  from: PaneSide;
  /** How many entries ride the drag (the source selection's size). */
  count: number;
}

/** Max completion suggestions the path bar shows. */
const MAX_COMPLETIONS = 8;

/** Store shape + actions for the SFTP panel. */
export interface SftpState {
  /** Whether the overlay is visible. */
  open: boolean;
  /** The host the panel (and connection) belongs to, or `null`. */
  hostId: string | null;
  /** The host's display label. */
  hostLabel: string;
  /** The live session id, or `null` before/after a connection. */
  sftpSessionId: string | null;
  /** Connection lifecycle. */
  connState: SftpConnState;
  /** Why the connection failed, when `connState` is `"error"`. */
  connError: string | null;
  /** The hidden-file toggle (both panes). */
  showHidden: boolean;
  /** Per-pane sort state. */
  sorts: Record<PaneSide, SortSpec>;
  /** Per-pane listing state. */
  panes: Record<PaneSide, PaneState>;
  /** The transfer queue, newest last. */
  transfers: TransferItem[];
  /** The pending host-key prompt driving the FingerprintDialog. */
  hostkeyPrompt: HostkeyPromptEvent | null;
  /** The pending needs-secret stop driving the SecretPromptDialog (F8). */
  secretPrompt: SftpNeedsSecret | null;
  /** The in-flight pane⇄pane drag, or `null`. */
  drag: DragState | null;
  /** The pane the pointer is over mid-drag (the drop target), or `null`. */
  dragOver: PaneSide | null;

  /** ⇧⌘S: shows the panel for a host (connecting as needed) or hides it. */
  toggleForHost(hostId: string, hostLabel: string): void;
  /** Re-runs the connect flow after a failure (the error state's Retry). */
  retryConnect(): void;
  /** Hides the overlay; the connection and transfers keep running. */
  hide(): void;
  /** Answers the FingerprintDialog. */
  respondHostkey(accept: boolean): void;
  /**
   * Answers the SecretPromptDialog: stores the secret in the Keychain and
   * retries the connect. The secret passes straight through to
   * `keychain_set` — it is never kept here.
   */
  submitSecret(secret: string): Promise<void>;
  /** Dismisses the SecretPromptDialog; the connect fails with its detail. */
  cancelSecret(): void;
  /** Navigates a pane to an absolute path. */
  navigate(pane: PaneSide, path: string): Promise<void>;
  /** Re-lists a pane's current directory. */
  refresh(pane: PaneSide): Promise<void>;
  /** Navigates a pane to its parent directory. */
  up(pane: PaneSide): Promise<void>;
  /** Double-click: enters directories, follows symlinks, transfers files. */
  openEntry(pane: PaneSide, entry: SftpEntry): Promise<void>;
  /** Cycles a pane's sort on a column click. */
  setSort(pane: PaneSide, key: SortKey): void;
  /** Flips the hidden-file toggle. */
  toggleHidden(): void;
  /** Replaces a pane's selection (the view computes modifier semantics). */
  setSelection(pane: PaneSide, selected: string[]): void;
  /** Creates a directory in a pane's cwd. */
  mkdir(pane: PaneSide, name: string): Promise<void>;
  /** Renames a pane's single selected entry. */
  renameSelected(pane: PaneSide, newName: string): Promise<void>;
  /** Deletes a pane's selected entries (the dialog confirmed already). */
  deleteSelected(pane: PaneSide): Promise<void>;
  /** Applies permission bits to a pane's selected entries. */
  chmodSelected(pane: PaneSide, mode: number): Promise<void>;
  /** Queues the local pane's selection for upload to the remote cwd. */
  sendLocalSelection(): Promise<void>;
  /** Queues the remote pane's selection for download to the local cwd. */
  sendRemoteSelection(): Promise<void>;
  /** Queues OS-dropped local paths for upload to the remote cwd. */
  uploadDroppedPaths(paths: string[]): Promise<void>;
  /** Cancels a queued or running transfer. */
  cancelTransfer(clientId: string): void;
  /** Manually retries a failed transfer. */
  retryTransfer(clientId: string): void;
  /** Drops finished (done/failed/cancelled) rows from the queue. */
  clearFinished(): void;
  /** Path-bar completion: subdirectories of the draft's parent. */
  completePath(pane: PaneSide, draft: string): Promise<string[]>;
  /** Starts a pointer drag from a pane's selection (no-op when empty). */
  beginDrag(from: PaneSide): void;
  /** Tracks which pane the pointer is over mid-drag. */
  setDragOver(pane: PaneSide | null): void;
  /** Ends the drag: a cross-pane drop transfers, anything else cancels. */
  endDrag(): void;
  /** Abandons the drag without dropping (Esc). */
  cancelDrag(): void;
}

/** A fresh, empty pane. */
function emptyPane(): PaneState {
  return { path: "/", entries: [], loading: false, error: null, selected: [] };
}

/** Progress listeners by client id (imperative handles, not state). */
const unlistenByClient = new Map<string, () => void>();

/** Last progress reading per client id, for speed derivation. */
const lastTick = new Map<string, { bytes: number; at: number }>();

/** Monotonic client-id source. */
let nextClientId = 1;

/** Whether the module-level `hostkey:prompt` listener is wired. */
let hostkeyWired = false;

/** Wires the global host-key prompt listener once. */
function wireHostkeyPrompt(): void {
  if (hostkeyWired) return;
  hostkeyWired = true;
  void onHostkeyPrompt((prompt) => {
    useSftp.setState({ hostkeyPrompt: prompt });
  });
}

/**
 * Lists a directory on the right side of the connection.
 *
 * @param pane - Which pane the path belongs to.
 * @param sftpSessionId - The live session (remote pane only).
 * @param path - The absolute directory path.
 */
async function listDir(
  pane: PaneSide,
  sftpSessionId: string | null,
  path: string,
): Promise<SftpEntry[]> {
  if (pane === "local") {
    const { entries } = await ipcInvoke("sftp_local_list", { path });
    return entries;
  }
  if (!sftpSessionId) throw new Error("not connected");
  const { entries } = await ipcInvoke("sftp_list", { sftpSessionId, path });
  return entries;
}

/** The SFTP panel store hook. */
export const useSftp = create<SftpState>((set, get) => {
  /**
   * Patches one pane immutably.
   *
   * @param pane - The pane to act on.
   * @param patch - Fields to overwrite.
   */
  function patchPane(pane: PaneSide, patch: Partial<PaneState>): void {
    set((state) => ({
      panes: { ...state.panes, [pane]: { ...state.panes[pane], ...patch } },
    }));
  }

  /**
   * Patches one transfer row by client id.
   *
   * @param clientId - The transfer row's UI key.
   * @param patch - Fields to overwrite.
   */
  function patchTransfer(clientId: string, patch: Partial<TransferItem>): void {
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.clientId === clientId ? { ...t, ...patch } : t,
      ),
    }));
  }

  /**
   * Drops a transfer's imperative handles.
   *
   * @param clientId - The transfer row's UI key.
   */
  function dropHandles(clientId: string): void {
    unlistenByClient.get(clientId)?.();
    unlistenByClient.delete(clientId);
    lastTick.delete(clientId);
  }

  /** Starts queued transfers while under the concurrency cap. */
  function pump(): void {
    const { transfers } = get();
    const running = transfers.filter((t) => t.state === "running").length;
    const slots = MAX_RUNNING - running;
    if (slots <= 0) return;
    for (const item of transfers.filter((t) => t.state === "queued").slice(0, slots)) {
      void startTransfer(item);
    }
  }

  /**
   * Moves one queued item into flight and wires its progress stream.
   *
   * @param item - The queued row to start.
   */
  async function startTransfer(item: TransferItem): Promise<void> {
    const { sftpSessionId } = get();
    if (!sftpSessionId) {
      patchTransfer(item.clientId, { state: "failed", error: "not connected" });
      return;
    }
    // The id is minted HERE and the listener registered BEFORE the command
    // flies: a localhost transfer can finish in single-digit milliseconds,
    // and a terminal event emitted before the subscription exists would
    // strand the row as "running" forever (live-run find).
    const transferId = crypto.randomUUID();
    patchTransfer(item.clientId, {
      state: "running",
      bytes: 0,
      speedBps: 0,
      transferId,
    });
    const unlisten = await onSftpProgress(transferId, (progress) => {
      if (progress.state === "running") {
        const now = Date.now();
        const last = lastTick.get(item.clientId);
        const speedBps =
          last && now > last.at
            ? ((progress.bytes - last.bytes) / (now - last.at)) * 1000
            : 0;
        lastTick.set(item.clientId, { bytes: progress.bytes, at: now });
        patchTransfer(item.clientId, {
          bytes: progress.bytes,
          total: progress.total,
          speedBps,
        });
        return;
      }
      dropHandles(item.clientId);
      if (progress.state === "done") {
        patchTransfer(item.clientId, {
          state: "done",
          bytes: progress.bytes,
          total: progress.total,
          speedBps: 0,
        });
        // The destination pane gained a file — show it.
        void get().refresh(item.direction === "upload" ? "remote" : "local");
      } else if (progress.state === "cancelled") {
        patchTransfer(item.clientId, { state: "cancelled", speedBps: 0 });
      } else {
        const current = get().transfers.find((t) => t.clientId === item.clientId);
        if (progress.retryable && current && !current.retried) {
          // Auto-retry ×1 (F5): transient failures re-queue themselves.
          patchTransfer(item.clientId, {
            state: "queued",
            retried: true,
            transferId: null,
            bytes: 0,
            speedBps: 0,
          });
        } else {
          patchTransfer(item.clientId, {
            state: "failed",
            error: progress.error ?? "transfer failed",
            speedBps: 0,
          });
        }
      }
      pump();
    });
    unlistenByClient.set(item.clientId, unlisten);
    try {
      const command = item.direction === "upload" ? "sftp_upload" : "sftp_download";
      await ipcInvoke(command, {
        sftpSessionId,
        localPath: item.localPath,
        remotePath: item.remotePath,
        transferId,
      });
    } catch (error) {
      // The command itself refused (source unreadable, session gone).
      // Drop only OUR listener — a terminal event may have raced this
      // rejection and re-queued the row, whose next attempt owns the
      // map slot by now.
      unlisten();
      if (unlistenByClient.get(item.clientId) === unlisten) {
        unlistenByClient.delete(item.clientId);
        lastTick.delete(item.clientId);
      }
      const current = get().transfers.find((t) => t.clientId === item.clientId);
      if (current?.state === "running") {
        patchTransfer(item.clientId, {
          state: "failed",
          error: String(error),
          speedBps: 0,
        });
      }
      pump();
    }
  }

  /**
   * Appends transfers to the queue and pumps.
   *
   * @param items - The transfers to append.
   */
  function enqueue(
    items: Array<Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">>,
  ): void {
    if (items.length === 0) return;
    const rows: TransferItem[] = items.map((item) => ({
      ...item,
      clientId: `t${nextClientId++}`,
      transferId: null,
      state: "queued",
      bytes: 0,
      total: 0,
      speedBps: 0,
      retried: false,
    }));
    set((state) => ({ transfers: [...state.transfers, ...rows] }));
    pump();
  }

  /**
   * Expands one local entry into per-file transfers, creating remote
   * directories as it walks (the backend moves files, not folders).
   *
   * @param localPath - Absolute local path of the entry.
   * @param remotePath - Absolute remote path of the entry.
   * @param entry - The entry being expanded.
   * @param out - Accumulator receiving the per-file transfers.
   */
  async function expandUpload(
    localPath: string,
    remotePath: string,
    entry: Pick<SftpEntry, "name" | "isDir" | "isSymlink">,
    out: Array<Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">>,
  ): Promise<void> {
    if (!entry.isDir || entry.isSymlink) {
      out.push({ direction: "upload", name: entry.name, localPath, remotePath });
      return;
    }
    const { sftpSessionId } = get();
    if (!sftpSessionId) throw new Error("not connected");
    await ipcInvoke("sftp_mkdir", { sftpSessionId, path: remotePath }).catch(() => {
      // Exists already — the walk continues into it.
    });
    const { entries } = await ipcInvoke("sftp_local_list", { path: localPath });
    for (const child of entries) {
      await expandUpload(
        joinPath(localPath, child.name),
        joinPath(remotePath, child.name),
        child,
        out,
      );
    }
  }

  /**
   * The download mirror of {@link expandUpload}.
   *
   * @param remotePath - Absolute remote path of the entry.
   * @param localPath - Absolute local path of the entry.
   * @param entry - The entry being expanded.
   * @param out - Accumulator receiving the per-file transfers.
   */
  async function expandDownload(
    remotePath: string,
    localPath: string,
    entry: Pick<SftpEntry, "name" | "isDir" | "isSymlink">,
    out: Array<Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">>,
  ): Promise<void> {
    if (!entry.isDir || entry.isSymlink) {
      out.push({ direction: "download", name: entry.name, localPath, remotePath });
      return;
    }
    const { sftpSessionId } = get();
    if (!sftpSessionId) throw new Error("not connected");
    await ipcInvoke("sftp_local_mkdir", { path: localPath }).catch(() => {
      // Exists already.
    });
    const { entries } = await ipcInvoke("sftp_list", { sftpSessionId, path: remotePath });
    for (const child of entries) {
      await expandDownload(
        joinPath(remotePath, child.name),
        joinPath(localPath, child.name),
        child,
        out,
      );
    }
  }

  /**
   * Selected entries of a pane, in listing order.
   *
   * @param pane - The pane to act on.
   */
  function selectedEntries(pane: PaneSide): SftpEntry[] {
    const { panes } = get();
    const picked = new Set(panes[pane].selected);
    return panes[pane].entries.filter((entry) => picked.has(entry.name));
  }

  /**
   * Runs one pane op, refreshing after and toasting failures.
   *
   * @param pane - The pane to act on.
   * @param op - The operation to run.
   */
  async function paneOp(pane: PaneSide, op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (error) {
      useToast.getState().show(String(error), "error");
    }
    await get().refresh(pane);
  }

  /** Tears down the live connection (host switch / failure). */
  function disconnectCurrent(): void {
    const { sftpSessionId, transfers } = get();
    if (!sftpSessionId) return;
    const active = transfers.some((t) => t.state === "running" || t.state === "queued");
    if (active) {
      useToast.getState().show("Transfers were cancelled by the disconnect", "info");
    }
    void ipcInvoke("sftp_disconnect", { sftpSessionId }).catch(() => {
      // Idempotent by contract; nothing useful to report.
    });
  }

  /**
   * Tears down any current connection and starts a fresh one.
   *
   * @param hostId - The host to connect.
   * @param hostLabel - The host's display label.
   */
  function startConnection(hostId: string, hostLabel: string): void {
    wireHostkeyPrompt();
    disconnectCurrent();
    set({
      open: true,
      hostId,
      hostLabel,
      sftpSessionId: null,
      connState: "connecting",
      connError: null,
      panes: { local: emptyPane(), remote: emptyPane() },
      transfers: [],
      hostkeyPrompt: null,
      secretPrompt: null,
      // A drag can't survive a host switch — releasing over the new
      // host's pane must not transfer the old host's selection.
      drag: null,
      dragOver: null,
    });
    void (async () => {
      try {
        const home = await localHomeDir();
        await get().navigate("local", home);
      } catch (error) {
        patchPane("local", { error: String(error) });
      }
      try {
        const result = await ipcInvoke("sftp_connect", { hostId });
        // The user may have switched hosts while we connected.
        if (get().hostId !== hostId) {
          if (result.sftpSessionId !== undefined) {
            void ipcInvoke("sftp_disconnect", {
              sftpSessionId: result.sftpSessionId,
            }).catch(() => undefined);
          }
          return;
        }
        if (result.needsSecret !== undefined) {
          // The ladder stopped at a Keychain gap (F8): the dialog stores
          // the secret and retries; connState stays "connecting".
          set({ secretPrompt: result.needsSecret, hostkeyPrompt: null });
          return;
        }
        const sftpSessionId = result.sftpSessionId;
        set({ sftpSessionId, connState: "connected", hostkeyPrompt: null });
        const { path } = await ipcInvoke("sftp_realpath", { sftpSessionId, path: "." });
        await get().navigate("remote", path);
      } catch (error) {
        if (get().hostId !== hostId) return;
        set({ connState: "error", connError: String(error), hostkeyPrompt: null });
      }
    })();
  }

  return {
    open: false,
    hostId: null,
    hostLabel: "",
    sftpSessionId: null,
    connState: "idle",
    connError: null,
    showHidden: false,
    sorts: { local: DEFAULT_SORT, remote: DEFAULT_SORT },
    panes: { local: emptyPane(), remote: emptyPane() },
    transfers: [],
    hostkeyPrompt: null,
    secretPrompt: null,
    drag: null,
    dragOver: null,

    toggleForHost(hostId: string, hostLabel: string): void {
      const state = get();
      if (state.open && state.hostId === hostId) {
        set({ open: false });
        return;
      }
      if (state.hostId === hostId && state.connState === "connected") {
        set({ open: true });
        return;
      }
      // A different host (or a dead connection): tear down and reconnect.
      startConnection(hostId, hostLabel);
    },

    retryConnect(): void {
      const { hostId, hostLabel } = get();
      if (hostId !== null) startConnection(hostId, hostLabel);
    },

    hide(): void {
      set({ open: false });
    },

    respondHostkey(accept: boolean): void {
      const prompt = get().hostkeyPrompt;
      if (!prompt) return;
      set({ hostkeyPrompt: null });
      void ipcInvoke("hostkey_trust", { hostId: prompt.hostId, accept }).catch(
        (error) => {
          useToast.getState().show(String(error), "error");
        },
      );
    },

    async submitSecret(secret: string): Promise<void> {
      const { secretPrompt, hostId } = get();
      if (secretPrompt === null || hostId === null) return;
      set({ secretPrompt: null });
      try {
        await ipcInvoke(
          "keychain_set",
          secretPrompt.kind === "password"
            ? { kind: "password", hostId, secret }
            : { kind: "passphrase", keyPath: secretPrompt.keyPath ?? "", secret },
        );
      } catch (error) {
        set({ connState: "error", connError: String(error) });
        return;
      }
      get().retryConnect();
    },

    cancelSecret(): void {
      const prompt = get().secretPrompt;
      if (prompt === null) return;
      set({ secretPrompt: null, connState: "error", connError: prompt.detail });
    },

    async navigate(pane: PaneSide, path: string): Promise<void> {
      patchPane(pane, { loading: true, error: null });
      try {
        const entries = await listDir(pane, get().sftpSessionId, path);
        patchPane(pane, { path, entries, loading: false, selected: [] });
      } catch (error) {
        patchPane(pane, { loading: false, error: String(error) });
      }
    },

    async refresh(pane: PaneSide): Promise<void> {
      const { path, selected } = get().panes[pane];
      try {
        const entries = await listDir(pane, get().sftpSessionId, path);
        const names = new Set(entries.map((e) => e.name));
        patchPane(pane, {
          entries,
          error: null,
          selected: selected.filter((name) => names.has(name)),
        });
      } catch (error) {
        patchPane(pane, { error: String(error) });
      }
    },

    async up(pane: PaneSide): Promise<void> {
      await get().navigate(pane, parentPath(get().panes[pane].path));
    },

    async openEntry(pane: PaneSide, entry: SftpEntry): Promise<void> {
      const cwd = get().panes[pane].path;
      const full = joinPath(cwd, entry.name);
      if (entry.isDir) {
        await get().navigate(pane, full);
        return;
      }
      if (entry.isSymlink) {
        // Follow explicitly (F5): stat resolves the target's kind.
        try {
          const stat =
            pane === "local"
              ? await ipcInvoke("sftp_local_stat", { path: full })
              : await ipcInvoke("sftp_stat", {
                  sftpSessionId: get().sftpSessionId ?? "",
                  path: full,
                });
          if (stat.isDir) {
            await get().navigate(pane, full);
            return;
          }
        } catch (error) {
          useToast.getState().show(String(error), "error");
          return;
        }
      }
      // A plain file: double-click sends it to the other pane's cwd.
      const other: PaneSide = pane === "local" ? "remote" : "local";
      const target = joinPath(get().panes[other].path, entry.name);
      enqueue([
        pane === "local"
          ? { direction: "upload", name: entry.name, localPath: full, remotePath: target }
          : {
              direction: "download",
              name: entry.name,
              localPath: target,
              remotePath: full,
            },
      ]);
    },

    setSort(pane: PaneSide, key: SortKey): void {
      set((state) => ({
        sorts: { ...state.sorts, [pane]: cycleSort(state.sorts[pane], key) },
      }));
    },

    toggleHidden(): void {
      set((state) => ({ showHidden: !state.showHidden }));
    },

    setSelection(pane: PaneSide, selected: string[]): void {
      patchPane(pane, { selected });
    },

    async mkdir(pane: PaneSide, name: string): Promise<void> {
      const path = joinPath(get().panes[pane].path, name);
      await paneOp(pane, () =>
        pane === "local"
          ? ipcInvoke("sftp_local_mkdir", { path })
          : ipcInvoke("sftp_mkdir", { sftpSessionId: get().sftpSessionId ?? "", path }),
      );
    },

    async renameSelected(pane: PaneSide, newName: string): Promise<void> {
      const picked = selectedEntries(pane);
      if (picked.length !== 1) return;
      const cwd = get().panes[pane].path;
      const from = joinPath(cwd, picked[0].name);
      const to = joinPath(cwd, newName);
      await paneOp(pane, () =>
        pane === "local"
          ? ipcInvoke("sftp_local_rename", { from, to })
          : ipcInvoke("sftp_rename", {
              sftpSessionId: get().sftpSessionId ?? "",
              from,
              to,
            }),
      );
    },

    async deleteSelected(pane: PaneSide): Promise<void> {
      const picked = selectedEntries(pane);
      if (picked.length === 0) return;
      const cwd = get().panes[pane].path;
      await paneOp(pane, async () => {
        for (const entry of picked) {
          const path = joinPath(cwd, entry.name);
          const isDir = entry.isDir && !entry.isSymlink;
          if (pane === "local") {
            await ipcInvoke("sftp_local_delete", { path, isDir });
          } else {
            await ipcInvoke("sftp_delete", {
              sftpSessionId: get().sftpSessionId ?? "",
              path,
              isDir,
            });
          }
        }
      });
    },

    async chmodSelected(pane: PaneSide, mode: number): Promise<void> {
      const picked = selectedEntries(pane);
      if (picked.length === 0) return;
      const cwd = get().panes[pane].path;
      await paneOp(pane, async () => {
        for (const entry of picked) {
          const path = joinPath(cwd, entry.name);
          if (pane === "local") {
            await ipcInvoke("sftp_local_chmod", { path, mode });
          } else {
            await ipcInvoke("sftp_chmod", {
              sftpSessionId: get().sftpSessionId ?? "",
              path,
              mode,
            });
          }
        }
      });
    },

    async sendLocalSelection(): Promise<void> {
      const picked = selectedEntries("local");
      const { panes } = get();
      const out: Array<
        Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">
      > = [];
      try {
        for (const entry of picked) {
          await expandUpload(
            joinPath(panes.local.path, entry.name),
            joinPath(panes.remote.path, entry.name),
            entry,
            out,
          );
        }
      } catch (error) {
        useToast.getState().show(String(error), "error");
      }
      enqueue(out);
    },

    async sendRemoteSelection(): Promise<void> {
      const picked = selectedEntries("remote");
      const { panes } = get();
      const out: Array<
        Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">
      > = [];
      try {
        for (const entry of picked) {
          await expandDownload(
            joinPath(panes.remote.path, entry.name),
            joinPath(panes.local.path, entry.name),
            entry,
            out,
          );
        }
      } catch (error) {
        useToast.getState().show(String(error), "error");
      }
      enqueue(out);
    },

    async uploadDroppedPaths(paths: string[]): Promise<void> {
      const { panes, connState } = get();
      if (connState !== "connected") return;
      const out: Array<
        Pick<TransferItem, "direction" | "name" | "localPath" | "remotePath">
      > = [];
      try {
        for (const localPath of paths) {
          const stat = await ipcInvoke("sftp_local_stat", { path: localPath });
          await expandUpload(
            localPath,
            joinPath(panes.remote.path, stat.name),
            stat,
            out,
          );
        }
      } catch (error) {
        useToast.getState().show(String(error), "error");
      }
      enqueue(out);
    },

    cancelTransfer(clientId: string): void {
      const item = get().transfers.find((t) => t.clientId === clientId);
      if (!item) return;
      if (item.state === "queued") {
        dropHandles(clientId);
        set((state) => ({
          transfers: state.transfers.map((t) =>
            t.clientId === clientId ? { ...t, state: "cancelled" } : t,
          ),
        }));
        return;
      }
      if (item.state === "running" && item.transferId) {
        // The terminal "cancelled" event flips the row's state.
        void ipcInvoke("sftp_cancel", { transferId: item.transferId }).catch(
          () => undefined,
        );
      }
    },

    retryTransfer(clientId: string): void {
      const item = get().transfers.find((t) => t.clientId === clientId);
      if (!item || item.state !== "failed") return;
      set((state) => ({
        transfers: state.transfers.map((t) =>
          t.clientId === clientId
            ? {
                ...t,
                state: "queued",
                transferId: null,
                bytes: 0,
                speedBps: 0,
                error: undefined,
              }
            : t,
        ),
      }));
      pump();
    },

    clearFinished(): void {
      for (const item of get().transfers) {
        if (item.state !== "queued" && item.state !== "running") {
          dropHandles(item.clientId);
        }
      }
      set((state) => ({
        transfers: state.transfers.filter(
          (t) => t.state === "queued" || t.state === "running",
        ),
      }));
    },

    async completePath(pane: PaneSide, draft: string): Promise<string[]> {
      const { dir, prefix } = splitForCompletion(draft);
      try {
        const entries = await listDir(pane, get().sftpSessionId, dir);
        return entries
          .filter((entry) => entry.isDir && entry.name.startsWith(prefix))
          .slice(0, MAX_COMPLETIONS)
          .map((entry) => joinPath(dir, entry.name));
      } catch {
        return [];
      }
    },

    beginDrag(from: PaneSide): void {
      const count = get().panes[from].selected.length;
      if (count === 0) return;
      set({ drag: { from, count }, dragOver: null });
    },

    setDragOver(pane: PaneSide | null): void {
      if (get().drag === null) return;
      set({ dragOver: pane });
    },

    endDrag(): void {
      const { drag, dragOver } = get();
      set({ drag: null, dragOver: null });
      if (drag === null || dragOver === null || dragOver === drag.from) return;
      // The drop transfers the source pane's selection to the other side.
      if (drag.from === "local") void get().sendLocalSelection();
      else void get().sendRemoteSelection();
    },

    cancelDrag(): void {
      set({ drag: null, dragOver: null });
    },
  };
});

/**
 * Test-only reset: clears imperative listener handles and returns the
 * store to its initial shape (mirrors the other stores' reset helpers).
 */
export function resetSftpForTests(): void {
  for (const unlisten of unlistenByClient.values()) unlisten();
  unlistenByClient.clear();
  lastTick.clear();
  hostkeyWired = false;
  useSftp.setState({
    open: false,
    hostId: null,
    hostLabel: "",
    sftpSessionId: null,
    connState: "idle",
    connError: null,
    showHidden: false,
    sorts: { local: DEFAULT_SORT, remote: DEFAULT_SORT },
    panes: {
      local: { path: "/", entries: [], loading: false, error: null, selected: [] },
      remote: { path: "/", entries: [], loading: false, error: null, selected: [] },
    },
    transfers: [],
    hostkeyPrompt: null,
    secretPrompt: null,
    drag: null,
    dragOver: null,
  });
}
