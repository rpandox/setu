/**
 * The IPC contract between the WebView and the Rust core — the canonical,
 * typed surface of every Tauri command Setu can invoke and every event the
 * core emits.
 *
 * This file is one third of a triplet that always changes together, in the
 * same commit (CLAUDE.md):
 *
 * 1. `src/ipc/contract.ts` — this file, the frontend types.
 * 2. `src-tauri/src/ipc.rs` — the Rust mirror.
 * 3. `docs/dev/ipc.md` — the human-readable reference.
 *
 * Conventions:
 * - Commands map a name to `{ payload, result }` types; events map a name to
 *   their payload type. Command names are `snake_case` to match the Rust
 *   side; payload keys are `camelCase` (Tauri converts to Rust `snake_case`).
 *   Exception: {@link Host} fields are snake_case because the record mirrors
 *   the `hosts.toml` schema (PLAN.md §4) verbatim on both sides.
 * - Session-scoped events embed the id in the channel name,
 *   e.g. `pty:data:{sessionId}`.
 */

/**
 * What kind of process a PTY session drives.
 *
 * Phase 2 implements `"local"` ($SHELL as a login shell) and `"ssh"`
 * (system `ssh -tt` to a known host). `"mosh"` arrives in Phase 7 — the
 * contract types exactly what exists, nothing speculative.
 */
export type PtyKind = "local" | "ssh";

/**
 * Payload for `pty_spawn` — a discriminated union on `kind`.
 *
 * SSH sessions name their host by id: the Rust core resolves the record
 * (from `hosts.toml`, or a live `~/.ssh/config` parse for `sshcfg:` ids)
 * and builds the argv itself — argv never crosses IPC.
 */
export type PtySpawnPayload =
  | {
      /** A local login shell. */
      kind: "local";
      /** Initial terminal width, in columns. */
      cols: number;
      /** Initial terminal height, in rows. */
      rows: number;
    }
  | {
      /** System `ssh -tt` with keepalive flags (F3). */
      kind: "ssh";
      /** Id of the host to connect to (`Host.id`). */
      hostId: string;
      /** Initial terminal width, in columns. */
      cols: number;
      /** Initial terminal height, in rows. */
      rows: number;
    };

/** Result of a successful `pty_spawn`. */
export interface PtySpawnResult {
  /** Unique id for the new session; keys all later commands and events. */
  sessionId: string;
}

/** Payload for `pty_write`. */
export interface PtyWritePayload {
  /** The session to write to. */
  sessionId: string;
  /** UTF-8 text to feed the child's stdin (keystrokes, pastes). */
  data: string;
}

/** Payload for `pty_resize`. */
export interface PtyResizePayload {
  /** The session to resize. */
  sessionId: string;
  /** New width, in columns. */
  cols: number;
  /** New height, in rows. */
  rows: number;
}

/** Payload for `pty_kill`. */
export interface PtyKillPayload {
  /** The session to terminate. Unknown ids are a no-op (idempotent close). */
  sessionId: string;
}

/** Payload of a `pty:exit:{sessionId}` event. */
export interface PtyExitEvent {
  /**
   * The child's exit code, or `null` when it died from a signal (including
   * `pty_kill`) and no code is available.
   */
  code: number | null;
}

/**
 * Where a host record came from (PLAN.md §4 `source`).
 *
 * - `"setu"` — created in Setu, persisted in `hosts.toml`.
 * - `"ssh_config"` — parsed live from `~/.ssh/config`; read-only until
 *   adopted; connects via its bare alias so system ssh applies the real
 *   config (ProxyJump included).
 * - `"tailscale"` — discovered tailnet peer (Phase 7; typed now because the
 *   Rust enum carries it, never returned before then).
 */
export type HostSource = "setu" | "ssh_config" | "tailscale";

/** A saved port-forward definition (F7; stored in Phase 2, used in Phase 6). */
export interface HostForward {
  /** Forward type: `"L"` (local), `"R"` (remote), or `"D"` (dynamic). */
  type: "L" | "R" | "D";
  /** The `ssh -L/-R/-D` spec, e.g. `"8080:localhost:8080"`. */
  spec: string;
  /** Whether the forward starts automatically with the session. */
  auto: boolean;
}

/** Per-host fleet-health settings (F13; stored in Phase 2, used in Phase 12). */
export interface HostHealth {
  /** Whether batched health probing is enabled for this host. */
  enabled: boolean;
  /** Seconds between health probes. */
  interval_s: number;
}

/**
 * One host record — the full PLAN.md §4 `[[host]]` schema.
 *
 * Unlike command payload wrappers (camelCase), `Host` fields are snake_case:
 * the record mirrors the `hosts.toml` schema verbatim on both sides of IPC,
 * so the TOML file, the Rust struct, and this type never drift apart.
 */
export interface Host {
  /** Stable UUID (`sshcfg:<alias>` for imported rows). Empty on a create draft. */
  id: string;
  /** Display label, the row's primary identity (e.g. `"hermes"`). */
  label: string;
  /** Sidebar section this host lives under; empty = ungrouped. */
  group: string;
  /** Free-form tag chips (F1). */
  tags: string[];
  /** Identity accent hue, 0–7, used on tabs and the terminal cursor (§7). */
  hue: number;
  /** Hostname or IP. Empty only on `ssh_config` alias-only rows. */
  hostname: string;
  /** Login user; empty lets system ssh decide. */
  user: string;
  /** SSH port (1–65535). */
  port: number;
  /** `"agent"` or a path to a private key file. */
  identity: string;
  /** Prefer mosh over ssh (Phase 7; stored, not yet honored). */
  use_mosh: boolean;
  /** Command appended after `--` on connect; empty = none. */
  startup: string;
  /** OpenSSH ControlMaster multiplexing (Phase 11; stored, not yet honored). */
  control_master: boolean;
  /** Whether the reachability prober may touch this host (Phase 4). */
  reachability: boolean;
  /** Saved port forwards (Phase 6; stored, not yet honored). */
  forwards: HostForward[];
  /** Fleet-health settings (Phase 12; stored, not yet honored). */
  health: HostHealth;
  /** Free-form notes. */
  notes: string;
  /** Pinned to the Favorites section at the top of the sidebar. */
  favorite: boolean;
  /** Where this record came from; only `"setu"` rows persist. */
  source: HostSource;
}

/** One field-level validation failure from `host_upsert`. */
export interface HostFieldError {
  /** The {@link Host} field the message belongs to, e.g. `"hostname"`. */
  field: string;
  /** Human-readable problem statement, shown inline in the HostEditor. */
  message: string;
}

/** Payload for `host_upsert`: the full record (empty `id` = create). */
export interface HostUpsertPayload {
  /** The draft to validate and save. */
  host: Host;
}

/**
 * Result of `host_upsert` — exactly one side is present: `host` when the
 * draft was saved, `errors` when validation rejected it (an expected editor
 * outcome, not a command failure).
 */
export interface HostUpsertResult {
  /** The saved record, with its assigned id. */
  host?: Host;
  /** Field-level validation failures. */
  errors?: HostFieldError[];
}

/** Payload for `host_delete` and `host_adopt`. */
export interface HostIdPayload {
  /** The host to act on (`Host.id`). */
  hostId: string;
}

/**
 * A node in a saved split tree (`state.json`, F4 session restore).
 *
 * Leaves carry a connection target, not live session ids: `hostId` names a
 * host to reconnect on restore, `null` means a fresh local shell. Pane and
 * session ids are minted anew when the layout is rebuilt.
 */
export type SavedSplitNode =
  | {
      /** One pane. */
      kind: "leaf";
      /** The host to reconnect (`Host.id`), or `null` for a local shell. */
      hostId: string | null;
    }
  | {
      /** Two children sharing the rectangle at `ratio`. */
      kind: "split";
      /** Orientation: `"row"` = side by side, `"col"` = stacked. */
      dir: "row" | "col";
      /** Share of the rectangle given to `a` (0–1). */
      ratio: number;
      /** First child: left (`row`) or top (`col`). */
      a: SavedSplitNode;
      /** Second child: right (`row`) or bottom (`col`). */
      b: SavedSplitNode;
    };

/** One saved tab in `state.json`. */
export interface SavedTab {
  /** The tab's split tree. */
  layout: SavedSplitNode;
}

/** Sidebar view state persisted in `state.json`. */
export interface SidebarUiState {
  /** Collapsed section keys (`"favorites"`, `"group:<name>"`, …). */
  collapsedSections: string[];
}

/**
 * One frecency record (F11, Phase 4): how often and how recently a palette
 * subject was used. Keys are `host:<id>` (connects) and `action:<id>`
 * (palette runs); scoring lives in `src/state/frecency.ts`.
 */
export interface FrecencyEntry {
  /** Total recorded uses. */
  uses: number;
  /** Epoch milliseconds of the most recent use. */
  lastUsedAt: number;
}

/**
 * The `state.json` document (PLAN.md §4) — device-local UI state, outside
 * the `~/.config/setu` sync unit: it describes this machine's windows, not
 * the user's fleet. Mirrored by `UiState` in `ui_state.rs`; both sides use
 * camelCase, matching the JSON file verbatim.
 */
export interface UiState {
  /** Schema version; currently `1`. */
  version: number;
  /** Sidebar view state (migrated out of localStorage in Phase 3). */
  sidebar: SidebarUiState;
  /** Disarm broadcast when the active tab changes (F4 safety, default on). */
  broadcastAutoDisarm: boolean;
  /** Reopen the saved layout on launch (F4 session restore, default off). */
  restoreOnLaunch: boolean;
  /** The saved tab/split layout, kept current as tabs change. */
  savedLayout: SavedTab[];
  /** Palette frecency records keyed by subject (Phase 4, F11). */
  frecency: Record<string, FrecencyEntry>;
}

/** Payload for `ui_state_set`: the full document (no partial updates). */
export interface UiStateSetPayload {
  /** The state to write. */
  state: UiState;
}

/**
 * Result of `reach_start` — `started: false` means the global kill switch
 * (`settings.reachability.enabled` in `settings.toml`) is off: an expected
 * outcome the frontend treats as "LEDs stay hollow", not an error.
 */
export interface ReachStartResult {
  /** Whether the prober is (now) running. */
  started: boolean;
}

/** Payload for `reach_set_visible`. */
export interface ReachSetVisiblePayload {
  /** `true` when the app is visible, `false` when hidden/minimized. */
  visible: boolean;
}

/**
 * Payload of a `reach:update` event — one per completed probe (F1).
 *
 * All hosts share the one channel; the reach store is the event's single
 * consumer (PLAN.md §5, Phase 4 row). A host that answers TCP but refuses
 * ssh logins still reports `"up"` — the LED shows reachability, not auth.
 */
export interface ReachUpdate {
  /** The probed host (`Host.id`, including `sshcfg:` ids). */
  hostId: string;
  /** `"up"` = TCP connect succeeded; `"down"` = refused or timed out. */
  state: "up" | "down";
  /** Connect latency in milliseconds; present only when `state` is `"up"`. */
  rttMs?: number;
}

/**
 * One row in an SFTP pane listing — the same shape for both panes (remote
 * via russh-sftp, local via Rust `std::fs`), so sorting, columns, and drag
 * payloads are pane-agnostic (F5).
 *
 * Symlink rows describe the **link itself** (`isDir: false`, `linkTarget`
 * set); following happens explicitly via `sftp_stat` / `sftp_local_stat`
 * on double-click.
 */
export interface SftpEntry {
  /** File name (final path component). */
  name: string;
  /** Size in bytes; `0` for directories and when the server omits it. */
  size: number;
  /** Modification time in epoch milliseconds; `0` when unknown. */
  mtimeMs: number;
  /** Unix permission bits (lower 12 bits; render as octal / rwx). */
  mode: number;
  /** Whether the entry is a directory (never true for symlinks). */
  isDir: boolean;
  /** Whether the entry is a symbolic link. */
  isSymlink: boolean;
  /** The symlink's raw target, when the entry is one and it was readable. */
  linkTarget?: string;
}

/** Payload for `sftp_connect`. */
export interface SftpConnectPayload {
  /** The host to connect to (`Host.id`). */
  hostId: string;
}

/** Result of a successful `sftp_connect`. */
export interface SftpConnectResult {
  /** Keys every later SFTP command and its transfers. */
  sftpSessionId: string;
}

/** Payload for `hostkey_trust` — the FingerprintDialog verdict. */
export interface HostkeyTrustPayload {
  /** The host the pending prompt belongs to (`Host.id`). */
  hostId: string;
  /**
   * `true` appends the key to `~/.ssh/known_hosts` (append-only, the only
   * known_hosts write in the app) and resumes the connect; `false` fails it.
   */
  accept: boolean;
}

/** Payload for `sftp_disconnect`. */
export interface SftpSessionPayload {
  /** The session to act on. Unknown ids are a no-op (idempotent close). */
  sftpSessionId: string;
}

/** Payload for `sftp_list`, `sftp_stat`, and `sftp_mkdir`. */
export interface SftpPathPayload {
  /** The session to act on. */
  sftpSessionId: string;
  /** Absolute remote path (`/`-separated). */
  path: string;
}

/** Result of `sftp_list` / `sftp_local_list`. */
export interface SftpListResult {
  /** The directory's entries, name-sorted, `.`/`..` omitted. */
  entries: SftpEntry[];
}

/** Result of `sftp_realpath`. */
export interface SftpRealpathResult {
  /** The canonical absolute path. */
  path: string;
}

/** Payload for `sftp_rename`. */
export interface SftpRenamePayload {
  /** The session to act on. */
  sftpSessionId: string;
  /** Current absolute path. */
  from: string;
  /** New absolute path. */
  to: string;
}

/** Payload for `sftp_delete`. */
export interface SftpDeletePayload {
  /** The session to act on. */
  sftpSessionId: string;
  /** Absolute path to delete. */
  path: string;
  /** Whether the path is a directory (deleted recursively when so). */
  isDir: boolean;
}

/** Payload for `sftp_chmod`. */
export interface SftpChmodPayload {
  /** The session to act on. */
  sftpSessionId: string;
  /** Absolute path to modify. */
  path: string;
  /** Permission bits as a number (e.g. `0o755` — max `0o7777`). */
  mode: number;
}

/** Payload for `sftp_local_list`, `sftp_local_stat`, `sftp_local_mkdir`. */
export interface LocalPathPayload {
  /** Absolute local path. */
  path: string;
}

/** Payload for `sftp_local_rename`. */
export interface LocalRenamePayload {
  /** Current absolute path. */
  from: string;
  /** New absolute path. */
  to: string;
}

/** Payload for `sftp_local_delete`. */
export interface LocalDeletePayload {
  /** Absolute path to delete. */
  path: string;
  /** Whether the path is a directory (deleted recursively when so). */
  isDir: boolean;
}

/** Payload for `sftp_local_chmod`. */
export interface LocalChmodPayload {
  /** Absolute path to modify. */
  path: string;
  /** Permission bits as a number (max `0o7777`). */
  mode: number;
}

/** Payload for `sftp_upload` and `sftp_download`. */
export interface SftpTransferPayload {
  /** The session the transfer rides. */
  sftpSessionId: string;
  /** Absolute local file path (source for uploads, target for downloads). */
  localPath: string;
  /** Absolute remote file path (target for uploads, source for downloads). */
  remotePath: string;
  /**
   * Client-minted UUID keying the `sftp:progress:{transferId}` stream and
   * `sftp_cancel`. Minted before the command flies so the progress
   * listener already exists when the backend starts emitting — a fast
   * transfer's terminal event must never race the subscription. The
   * backend rejects an empty or in-flight id.
   */
  transferId: string;
}

/** Result of `sftp_upload` / `sftp_download`. */
export interface SftpTransferResult {
  /** Echo of the payload's `transferId`. */
  transferId: string;
}

/** Payload for `sftp_cancel`. */
export interface SftpCancelPayload {
  /** The transfer to cancel. Unknown ids are a no-op (can't race a finish). */
  transferId: string;
}

/**
 * Payload of a `hostkey:prompt` event — an unknown host key awaiting the
 * user's verdict in the FingerprintDialog (F5). Answered via
 * `hostkey_trust`; the pending `sftp_connect` stays parked until then.
 */
export interface HostkeyPromptEvent {
  /** The host being connected (`Host.id`) — echo back in `hostkey_trust`. */
  hostId: string;
  /** Display label for the dialog title. */
  hostLabel: string;
  /** Key algorithm, e.g. `"ssh-ed25519"`. */
  algorithm: string;
  /** OpenSSH-format `SHA256:<base64>` fingerprint. */
  fingerprint: string;
}

/** Lifecycle of one transfer as reported by `sftp:progress:{transferId}`. */
export type SftpTransferState = "running" | "done" | "failed" | "cancelled";

/**
 * Payload of a `sftp:progress:{transferId}` event. `"running"` events are
 * throttled (~10/s); exactly one terminal event — `"done"`, `"failed"`, or
 * `"cancelled"` — closes the channel. Speed and ETA are derived in the
 * store from successive `bytes` readings.
 */
export interface SftpProgressEvent {
  /** Bytes moved so far (`0` on `"failed"`/`"cancelled"` terminals). */
  bytes: number;
  /** Total bytes expected; `0` when the size is unknown. */
  total: number;
  /** Transfer lifecycle state. */
  state: SftpTransferState;
  /** The failure message, on `"failed"` only. */
  error?: string;
  /** Whether an auto-retry is worth attempting, on `"failed"` only (F5: the queue retries once). */
  retryable?: boolean;
}

/**
 * Invokable commands, keyed by command name.
 *
 * Phase 1 shipped the `pty_*` family; Phase 2 adds SSH spawning and the
 * `hosts_*` family over `hosts.toml` and the `~/.ssh/config` import;
 * Phase 3 adds the `ui_state_*` pair over `state.json`; Phase 4 adds the
 * `reach_*` family driving the LED board; Phase 5 adds the `sftp_*` family
 * (dual-pane browser + transfers) and the `hostkey_trust` half of the
 * fingerprint trust flow.
 */
export interface IpcCommands {
  /** Spawn a new PTY session — a local login shell or `ssh` to a host. */
  pty_spawn: { payload: PtySpawnPayload; result: PtySpawnResult };
  /** Write input to a running session. */
  pty_write: { payload: PtyWritePayload; result: null };
  /** Propagate a terminal resize to the PTY and its child. */
  pty_resize: { payload: PtyResizePayload; result: null };
  /** Terminate a session's child process; cleanup follows via `pty:exit`. */
  pty_kill: { payload: PtyKillPayload; result: null };
  /**
   * List every known host: persisted records first, then live
   * `~/.ssh/config` rows (aliases already adopted — matched by label — are
   * hidden).
   */
  hosts_list: { payload: Record<string, never>; result: Host[] };
  /** Create (empty `id`) or update a host; validates before writing. */
  host_upsert: { payload: HostUpsertPayload; result: HostUpsertResult };
  /** Delete a host. Live sessions keep running (tabs mark "(orphaned)"). */
  host_delete: { payload: HostIdPayload; result: null };
  /** Copy an `sshcfg:` row into `hosts.toml` as an editable record. */
  host_adopt: { payload: HostIdPayload; result: Host };
  /**
   * Start (or refresh) the reachability prober: the first call spawns the
   * sweep loop and probes immediately; later calls trigger a fresh sweep
   * (invoked again after host CRUD so new hosts light up right away).
   */
  reach_start: { payload: Record<string, never>; result: ReachStartResult };
  /** Stop the prober; no further `reach:update` events follow. */
  reach_stop: { payload: Record<string, never>; result: null };
  /**
   * Report app visibility (`document.visibilitychange`): hidden for over
   * 60s pauses sweeping; becoming visible again sweeps immediately.
   */
  reach_set_visible: { payload: ReachSetVisiblePayload; result: null };
  /** Read `state.json` (a missing file is the default state). */
  ui_state_get: { payload: Record<string, never>; result: UiState };
  /** Replace `state.json` atomically (corrupt files are never overwritten). */
  ui_state_set: { payload: UiStateSetPayload; result: null };
  /**
   * Open an SFTP session (russh; agent → identity-file auth). May emit one
   * `hostkey:prompt` and block until `hostkey_trust` answers it. Mismatched
   * or revoked keys fail hard — never a prompt.
   */
  sftp_connect: { payload: SftpConnectPayload; result: SftpConnectResult };
  /** Answer a pending `hostkey:prompt` (the FingerprintDialog verdict). */
  hostkey_trust: { payload: HostkeyTrustPayload; result: null };
  /** Close a session and cancel its transfers; unknown ids are a no-op. */
  sftp_disconnect: { payload: SftpSessionPayload; result: null };
  /** List a remote directory (complete listing; hidden filter is a view concern). */
  sftp_list: { payload: SftpPathPayload; result: SftpListResult };
  /** Canonicalize a remote path (REALPATH) — `"."` → the home path. */
  sftp_realpath: { payload: SftpPathPayload; result: SftpRealpathResult };
  /** Stat a remote path, following symlinks (the double-click follow). */
  sftp_stat: { payload: SftpPathPayload; result: SftpEntry };
  /** Create a remote directory. */
  sftp_mkdir: { payload: SftpPathPayload; result: null };
  /** Rename (move) a remote file or directory. */
  sftp_rename: { payload: SftpRenamePayload; result: null };
  /** Delete a remote file, or a directory recursively (links never followed). */
  sftp_delete: { payload: SftpDeletePayload; result: null };
  /** Set a remote path's permission bits. */
  sftp_chmod: { payload: SftpChmodPayload; result: null };
  /** List a local directory for the local pane — same shape as `sftp_list`. */
  sftp_local_list: { payload: LocalPathPayload; result: SftpListResult };
  /** Stat a local path, following symlinks. */
  sftp_local_stat: { payload: LocalPathPayload; result: SftpEntry };
  /** Create a local directory. */
  sftp_local_mkdir: { payload: LocalPathPayload; result: null };
  /** Rename (move) a local file or directory. */
  sftp_local_rename: { payload: LocalRenamePayload; result: null };
  /** Delete a local file, or a directory recursively. */
  sftp_local_delete: { payload: LocalDeletePayload; result: null };
  /** Set a local path's permission bits. */
  sftp_local_chmod: { payload: LocalChmodPayload; result: null };
  /**
   * Start an upload; returns immediately, progress streams as
   * `sftp:progress:{transferId}`. The queue (concurrency 3, auto-retry ×1)
   * lives in the sftp store.
   */
  sftp_upload: { payload: SftpTransferPayload; result: SftpTransferResult };
  /** Start a download; the mirror of `sftp_upload`. */
  sftp_download: { payload: SftpTransferPayload; result: SftpTransferResult };
  /** Cancel a running transfer; partial destination files are removed. */
  sftp_cancel: { payload: SftpCancelPayload; result: null };
}

/**
 * Events emitted by the Rust core, keyed by event channel name.
 *
 * - `pty:data:{sessionId}` — a base64-encoded chunk of raw PTY output.
 * - `pty:exit:{sessionId}` — the session's child exited; final event for
 *   that session.
 * - `reach:update` — one probe result; all hosts share the channel (the
 *   payload carries the host id).
 * - `hostkey:prompt` — an unknown host key awaiting the FingerprintDialog
 *   verdict; one channel, the payload carries the host id (F5).
 * - `sftp:progress:{transferId}` — throttled transfer progress, closed by
 *   exactly one terminal `done`/`failed`/`cancelled` event (F5).
 */
export interface IpcEvents {
  [channel: `pty:data:${string}`]: string;
  [channel: `pty:exit:${string}`]: PtyExitEvent;
  [channel: `sftp:progress:${string}`]: SftpProgressEvent;
  "reach:update": ReachUpdate;
  "hostkey:prompt": HostkeyPromptEvent;
}
