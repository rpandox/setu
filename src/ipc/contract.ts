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
 * `"local"` runs $SHELL as a login shell; `"ssh"` runs system `ssh -tt`
 * to a known host; `"mosh"` (Phase 7) runs system `mosh` — the host's
 * `use_mosh` toggle routes here after a `binary_check` preflight.
 */
export type PtyKind = "local" | "ssh" | "mosh";

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
    }
  | {
      /** System `mosh` — UDP roaming, survives network changes (Phase 7). */
      kind: "mosh";
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
 * One `{{var}}` declaration on a snippet (F6). `default` pre-fills the run
 * prompt; `choices` turns it into a select (a `default` alongside `choices`
 * must be one of them).
 */
export interface SnippetVariable {
  /** The token name as it appears inside `{{…}}` — `[A-Za-z_][A-Za-z0-9_]*`. */
  name: string;
  /** Pre-filled value for the run prompt; absent means an empty input. */
  default?: string;
  /** Fixed values rendered as a select instead of a free text input. */
  choices?: string[];
}

/**
 * One snippet record — the PLAN.md §4 `[[snippet]]` schema, mirrored
 * verbatim from `snippets.toml` on both sides of IPC (like {@link Host}).
 */
export interface Snippet {
  /** Stable UUID. Empty on a create draft. */
  id: string;
  /** Display label, the row's identity in the drawer and palette. */
  label: string;
  /** The command template; may contain `{{var}}` tokens. */
  command: string;
  /** Free-form tag chips (searchable in the drawer and palette). */
  tags: string[];
  /** Variable declarations — one per distinct `{{var}}` token. */
  variables: SnippetVariable[];
}

/** One field-level validation failure from `snippet_upsert`. */
export interface SnippetFieldError {
  /** The {@link Snippet} field the message belongs to, e.g. `"command"`. */
  field: string;
  /** Human-readable problem statement, shown inline in the SnippetDrawer. */
  message: string;
}

/** Payload for `snippet_upsert`: the full record (empty `id` = create). */
export interface SnippetUpsertPayload {
  /** The draft to validate and save. */
  snippet: Snippet;
}

/**
 * Result of `snippet_upsert` — exactly one side is present: `snippet` when
 * the draft was saved, `errors` when validation rejected it (an expected
 * editor outcome, not a command failure).
 */
export interface SnippetUpsertResult {
  /** The saved record, with its assigned id. */
  snippet?: Snippet;
  /** Field-level validation failures. */
  errors?: SnippetFieldError[];
}

/** Payload for `snippet_delete`. */
export interface SnippetDeletePayload {
  /** The snippet to delete (`Snippet.id`). Unknown ids are a no-op. */
  snippetId: string;
}

/**
 * Payload for `snippet_import` — the pack file's path from the native open
 * dialog (explicit user consent; the Rust core does the read). Merging is
 * by id: `"replace"` overwrites an existing record, `"keep"` skips the
 * incoming row; pack rows without an id always import under a fresh UUID.
 */
export interface SnippetImportPayload {
  /** Absolute path of the pack file (`[[snippet]]` TOML). */
  path: string;
  /** What to do when an incoming id already exists. */
  mergeStrategy: "replace" | "keep";
}

/** Result of `snippet_import`. */
export interface SnippetImportResult {
  /** Rows written (created or overwritten, per the merge strategy). */
  imported: number;
  /** Rows skipped because their id already existed (strategy `"keep"`). */
  skipped: number;
}

/** Payload for `snippet_export`. */
export interface SnippetExportPayload {
  /** The snippets to export (`Snippet.id`s); unknown ids are ignored. */
  ids: string[];
  /** Where to write the pack — from the native save dialog. */
  path: string;
}

/** A forward rule's health, as reported over `forward:update` (F7). */
export type ForwardHealthState = "starting" | "amber" | "green" | "red";

/**
 * Payload of a `forward:update` event — one health transition for one
 * rule. All rules share the channel; the payload carries the rule key
 * (PLAN.md §5, the `reach:update` precedent).
 */
export interface ForwardStatus {
  /** The rule's registry key: `{hostId}:{type}:{spec}`. */
  ruleKey: string;
  /** The owning host's id. */
  hostId: string;
  /** Current health. */
  state: ForwardHealthState;
  /** Why the rule is red (exit status + stderr tail); red only. */
  reason?: string;
  /** The copyable SOCKS string for `D` rules, e.g. `socks5://localhost:1080`. */
  proxyString?: string;
}

/** Payload for `forward_start`. */
export interface ForwardStartPayload {
  /** The owning host (`Host.id`, `sshcfg:` ids included). */
  hostId: string;
  /** The rule to start (usually one of `Host.forwards`). */
  rule: HostForward;
}

/** The expected-failure half of {@link ForwardStartResult}. */
export interface ForwardStartError {
  /** What went wrong. */
  kind: "port_in_use" | "spawn_failed";
  /** Human-readable message (names the owning process when known). */
  message: string;
  /** The next free local port, for the "Use N" one-shot retry. */
  suggestedPort?: number;
}

/**
 * Result of `forward_start` — expected failures (port in use, spawn
 * failure) ride the result, hosts-family style; only infrastructure
 * errors reject the promise.
 */
export interface ForwardStartResult {
  /** Whether the child is (now) running. */
  started: boolean;
  /** The rule's registry key, when started. */
  ruleKey?: string;
  /** The expected failure, when not. */
  error?: ForwardStartError;
}

/** Payload for `forward_stop`. */
export interface ForwardStopPayload {
  /** The rule to stop. Unknown keys are a no-op (idempotent toggle-off). */
  ruleKey: string;
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

/**
 * The needs-secret half of `SftpConnectResult` (F8): the auth ladder
 * stopped at a Keychain gap. Store the secret (`keychain_set` — password
 * keyed by the host id, passphrase keyed by `keyPath`) and call
 * `sftp_connect` again. Never carries a secret itself.
 */
export interface SftpNeedsSecret {
  /** Which secret is missing. */
  kind: "password" | "passphrase";
  /** The key path needing a passphrase (as configured on the host). */
  keyPath?: string;
  /** One plain sentence for the prompt dialog. */
  detail: string;
}

/**
 * Result of `sftp_connect` — a session, or the expected needs-secret stop
 * (result-side, hosts-family style; PLAN.md §5, Phase 7 row).
 */
export type SftpConnectResult =
  | {
      /** Keys every later SFTP command and its transfers. */
      sftpSessionId: string;
      /** Never present alongside a session. */
      needsSecret?: undefined;
    }
  | {
      /** Never present on a needs-secret stop. */
      sftpSessionId?: undefined;
      /** The secret the user must store, then retry. */
      needsSecret: SftpNeedsSecret;
    };

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
 * Which Keychain entry a `keychain_*` command addresses (F8, Phase 7).
 *
 * Secrets live under the Keychain service `dev.pandox.setu`, at
 * deterministic accounts — `password:{hostId}` for a host's SFTP password,
 * `passphrase:{keyPath}` for a key file's passphrase (the core
 * tilde-expands the path, so hosts sharing a key share one entry).
 */
export type KeychainSecretRef =
  | {
      /** A host's SFTP password. */
      kind: "password";
      /** The owning host (`Host.id`). */
      hostId: string;
    }
  | {
      /** A private key's passphrase. */
      kind: "passphrase";
      /** Path to the key file (`~` allowed). */
      keyPath: string;
    };

/**
 * Payload for `keychain_set` — the address plus the secret itself. The
 * secret is write-only: it crosses IPC toward the core exactly once, and
 * no command ever returns it (PLAN.md §5, Phase 7 row).
 */
export type KeychainSetPayload = KeychainSecretRef & {
  /** The secret to store; replaces any existing entry at the address. */
  secret: string;
};

/** Result of `keychain_has`. */
export interface KeychainHasResult {
  /** Whether an entry exists at the address. */
  exists: boolean;
}

/** Payload for `keys_generate` (F8). */
export interface KeysGeneratePayload {
  /** Where the private key goes (`~` allowed); `.pub` lands beside it. */
  path: string;
  /**
   * Optional passphrase. Typed into ssh-keygen's prompts through a hidden
   * PTY — never argv — and stored in the Keychain (`passphrase:{path}`).
   */
  passphrase?: string;
  /** Optional key comment (`-C`). */
  comment?: string;
}

/** The expected-refusal half of `KeysGenerateResult`. */
export interface KeysGenerateError {
  /** `"file_exists"` (keys are never overwritten) or `"no_parent"`. */
  kind: "file_exists" | "no_parent";
  /** One plain sentence naming the path. */
  message: string;
}

/** Result of `keys_generate` — the public key, or an expected refusal. */
export interface KeysGenerateResult {
  /** The new `.pub` line, for the clipboard and ssh-copy-id. */
  publicKey?: string;
  /** The expected refusal, when nothing was written. */
  error?: KeysGenerateError;
}

/** One ssh-agent identity, as `ssh-add -l` reports it (F8). */
export interface AgentKey {
  /** Key algorithm, e.g. `"ED25519"` or `"ED25519-SK"` (hardware). */
  algorithm: string;
  /** OpenSSH `SHA256:<base64>` fingerprint. */
  fingerprint: string;
  /** The key's comment — usually a path or `user@host`. */
  comment: string;
}

/** Result of `agent_list`. */
export interface AgentListResult {
  /** Whether an ssh-agent is reachable at all. */
  available: boolean;
  /** Loaded identities (empty is normal for a fresh agent). */
  keys: AgentKey[];
  /** One plain sentence for the guidance banner, when something's off. */
  note?: string;
}

/** Payload for `binary_check` (Phase 7). */
export interface BinaryCheckPayload {
  /** The tool to look for — allow-listed: "mosh", "tailscale", "claude". */
  name: "mosh" | "tailscale" | "claude";
}

/** Result of `binary_check`. */
export interface BinaryCheckResult {
  /** Whether the tool is installed (PATH or a well-known location). */
  found: boolean;
  /** The resolved absolute path, when found. */
  path?: string;
}

/**
 * One tailnet peer (F9, Phase 7). Ephemeral: peers are never persisted —
 * `id` (`ts:{nodeId}`) feeds `pty_spawn` / `sftp_connect` / `host_adopt`
 * like any host id, resolved by a fresh `tailscale status --json` core-side.
 */
export interface TailscalePeer {
  /** Stable host id, `ts:{nodeId}`. */
  id: string;
  /** MagicDNS name without the trailing dot. */
  dnsName: string;
  /** The device's short hostname — the row label. */
  hostName: string;
  /** OS as Tailscale reports it (`linux`, `macOS`, `windows`, …). */
  os: string;
  /** Tailscale's own online state — the LED, never a TCP probe (§3). */
  online: boolean;
  /** RFC 3339 last-seen for dimmed offline rows, when known. */
  lastSeen?: string;
  /** ACL tags (`tag:prod`, …). */
  tags: string[];
  /** Whether the peer runs Tailscale SSH (key-free connect badge). */
  tsSsh: boolean;
}

/** Result of `tailscale_peers`. */
export interface TailscalePeersResult {
  /** Whether the Tailnet section should exist at all. */
  available: boolean;
  /** One plain sentence when unavailable ("not installed", "logged out"…). */
  reason?: string;
  /** The default login user for one-click connects (`[tailnet]` setting). */
  defaultUser: string;
  /** Live peers, self excluded. */
  peers: TailscalePeer[];
}

/** Payload for `vault_export` (F8). */
export interface VaultExportPayload {
  /** Where the `.tar.age` file goes (from the save dialog). */
  destPath: string;
  /** The age passphrase. Crosses IPC once; never stored or logged. */
  passphrase: string;
  /**
   * The second, explicit toggle (F8): bundle known Keychain entries as
   * `keychain-secrets.toml` inside the encrypted tarball. Default-off.
   */
  includeSecrets: boolean;
}

/** Result of `vault_export`. */
export interface VaultExportResult {
  /** Size of the encrypted vault file, in bytes. */
  bytes: number;
  /** How many Keychain entries rode along (0 without the toggle). */
  secretsIncluded: number;
}

/** Payload for `tailscale_ping` — F9's "ping to wake path". */
export interface TailscalePingPayload {
  /** The peer's MagicDNS name. */
  target: string;
}

/** Result of `tailscale_ping`. */
export interface TailscalePingResult {
  /** Whether a pong arrived within the budget. */
  ok: boolean;
  /** The command's last output line, for the toast. */
  summary: string;
}

/**
 * The `[reachability]` table of `settings.toml` (PLAN.md §4). Fields are
 * snake_case: the record mirrors the TOML schema verbatim (Host precedent).
 */
export interface ReachabilitySettings {
  /** Global kill switch for the prober. */
  enabled: boolean;
  /** Seconds between probe sweeps (5–3600). */
  interval_s: number;
  /** Per-probe TCP connect timeout in ms (100–60000). */
  timeout_ms: number;
  /** Maximum probes in flight at once (1–64). */
  max_concurrent: number;
}

/** The `[tailnet]` table (F9). */
export interface TailnetSettings {
  /** Login user for one-click tailnet connects; empty falls back to $USER. */
  default_user: string;
}

/** The `[terminal]` table (Phase 8) — hot-applied to open terminals. */
export interface TerminalSettings {
  /** Terminal font size in pixels (8–32). */
  font_size: number;
  /** Scrollback lines kept per terminal (≤ 1 000 000). */
  scrollback_lines: number;
}

/**
 * The `[sync]` table (F10). The sync *remote* is deliberately absent —
 * it lives in the config repo's own `.git/config`, because this file is
 * itself synced (PLAN.md §5).
 */
export interface SyncSettings {
  /** Run a capped sync when the app quits. */
  auto_sync_on_quit: boolean;
}

/** The `[snapshots]` table (F10). */
export interface SnapshotSettings {
  /** Whether scheduled snapshots run at all. */
  enabled: boolean;
  /** Days between scheduled snapshots (1–365; default weekly). */
  interval_days: number;
  /** How many archives to keep (1–100; default 10). */
  keep: number;
}

/**
 * The whole `settings.toml` document — what `settings_get` returns,
 * `settings_set` saves, and the `settings:changed` event carries.
 *
 * Unknown top-level tables from newer app versions ride along untyped
 * (and survive a save), so two machines on different versions can share
 * the synced file.
 */
export interface SettingsDocument {
  /** The `[reachability]` table. */
  reachability: ReachabilitySettings;
  /** The `[tailnet]` table. */
  tailnet: TailnetSettings;
  /** The `[terminal]` table. */
  terminal: TerminalSettings;
  /** The `[sync]` table. */
  sync: SyncSettings;
  /** The `[snapshots]` table. */
  snapshots: SnapshotSettings;
  /**
   * Advanced-track feature flags (`[flags]`, default-off). Keys are
   * defined by the phases that ship the features; the Settings window
   * renders known ones and preserves the rest.
   */
  flags: Record<string, boolean>;
}

/** Payload for `settings_set`: the full document (no partial updates). */
export interface SettingsSetPayload {
  /** The document to validate and save. */
  document: SettingsDocument;
}

/** One field the settings validator rejected. */
export interface SettingsFieldError {
  /** The TOML key path, e.g. `"terminal.font_size"`. */
  field: string;
  /** Human-readable problem statement. */
  message: string;
}

/** Result of `settings_set` — saved document or per-field errors. */
export interface SettingsSetResult {
  /** The document as saved, when validation passed. */
  settings?: SettingsDocument;
  /** What was wrong otherwise (empty on success). */
  errors: SettingsFieldError[];
}

/** The sync dot's five states (F10). */
export type SyncStateKind = "clean" | "ahead" | "behind" | "conflict" | "local";

/** Result of `git_sync_status` and payload of `sync:update`. */
export interface GitSyncStatus {
  /** The dot state. */
  state: SyncStateKind;
  /** The `origin` URL, when configured. */
  remoteUrl?: string;
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
  /** Local commits the remote doesn't have (0 when unknown). */
  ahead: number;
  /** Remote commits not yet rebased onto, as of the last fetch. */
  behind: number;
  /** Files with unresolved conflict markers while `state` is `conflict`. */
  conflictFiles: string[];
  /** Unix time of the newest local commit, when any exists. */
  lastCommitTs?: number;
}

/** Which secrets-lint heuristic matched (F10). */
export type LintRuleKind = "secret_assignment" | "pem_private_key" | "base64_run";

/** One line the secrets lint refused to commit. */
export interface LintBlockedLine {
  /** Path relative to the config dir. */
  file: string;
  /** 1-based line number. */
  lineNo: number;
  /** The offending line (excerpted). */
  line: string;
  /** The heuristic that matched. */
  rule: LintRuleKind;
}

/**
 * Result of `git_sync_run`. Expected failures ride result-side: a lint
 * block fills `blocked` (nothing was staged), a conflicted rebase fills
 * `conflictFiles` (left in progress — never auto-resolved), network/auth
 * trouble fills `message`.
 */
export interface GitSyncRunResult {
  /** Whether the sync completed (push, or commit-only without a remote). */
  ok: boolean;
  /** Fresh status after whatever happened. */
  status: GitSyncStatus;
  /** Lines the secrets lint refused. */
  blocked: LintBlockedLine[];
  /** Conflicted files when the rebase stopped. */
  conflictFiles: string[];
  /** Human-readable failure description for everything else. */
  message?: string;
}

/** Payload for `git_sync_set_remote`. */
export interface SetRemotePayload {
  /** The remote URL; empty removes the remote (back to `local`). */
  url: string;
}

/** Result of `git_sync_set_remote`. */
export interface SetRemoteResult {
  /** Whether the remote was updated. */
  ok: boolean;
  /** Fresh status after the change, when it succeeded. */
  status?: GitSyncStatus;
  /** What was wrong with the URL (or git's own words) otherwise. */
  message?: string;
}

/** Result of `snapshot_now`. */
export interface SnapshotNowResult {
  /** Absolute path of the new archive. */
  path: string;
}

/**
 * Invokable commands, keyed by command name.
 *
 * Phase 1 shipped the `pty_*` family; Phase 2 adds SSH spawning and the
 * `hosts_*` family over `hosts.toml` and the `~/.ssh/config` import;
 * Phase 3 adds the `ui_state_*` pair over `state.json`; Phase 4 adds the
 * `reach_*` family driving the LED board; Phase 5 adds the `sftp_*` family
 * (dual-pane browser + transfers) and the `hostkey_trust` half of the
 * fingerprint trust flow; Phase 6 adds the `snippet_*` family over
 * `snippets.toml` (CRUD + TOML packs); Phase 7 adds the `keychain_*`
 * family (set / delete / has — never get, F8).
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
  /** List every snippet in `snippets.toml`, in file order (F6). */
  snippet_list: { payload: Record<string, never>; result: Snippet[] };
  /** Create (empty `id`) or update a snippet; validates before writing. */
  snippet_upsert: { payload: SnippetUpsertPayload; result: SnippetUpsertResult };
  /** Delete a snippet. Unknown ids are a no-op. */
  snippet_delete: { payload: SnippetDeletePayload; result: null };
  /**
   * Import a snippet pack from a picked file, merging by id per
   * `mergeStrategy`. Atomic: a pack with any invalid snippet imports nothing.
   */
  snippet_import: { payload: SnippetImportPayload; result: SnippetImportResult };
  /** Export snippets as a pack file at a picked path, in store order. */
  snippet_export: { payload: SnippetExportPayload; result: null };
  /**
   * Start a forward rule's managed `ssh -N` child (F7). `L`/`D` rules
   * pre-flight their local port — a conflict comes back result-side with
   * the owning process and the next free port.
   */
  forward_start: { payload: ForwardStartPayload; result: ForwardStartResult };
  /** Stop a rule: SIGTERM its process group. Unknown keys are a no-op. */
  forward_stop: { payload: ForwardStopPayload; result: null };
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
  /**
   * Store (or replace) a secret in the macOS Keychain (F8). Write-only:
   * no command ever returns a stored secret — the core reads it inside
   * the SFTP auth ladder only.
   */
  keychain_set: { payload: KeychainSetPayload; result: null };
  /** Delete a Keychain secret. Missing entries are a no-op. */
  keychain_delete: { payload: KeychainSecretRef; result: null };
  /** Whether a Keychain entry exists — existence only, never the secret. */
  keychain_has: { payload: KeychainSecretRef; result: KeychainHasResult };
  /**
   * Generate an ed25519 keypair with ssh-keygen (F8). Passphrases go
   * through a hidden PTY into the Keychain — never argv, never disk.
   * Existing files are never overwritten (expected `error` instead).
   */
  keys_generate: { payload: KeysGeneratePayload; result: KeysGenerateResult };
  /** List the ssh-agent's identities (`ssh-add -l`) for the Keys panel. */
  agent_list: { payload: Record<string, never>; result: AgentListResult };
  /**
   * Whether an optional system tool is installed (mosh preflight,
   * tailscale detection, Phase 13 claude). Allow-listed names only.
   */
  binary_check: { payload: BinaryCheckPayload; result: BinaryCheckResult };
  /**
   * List tailnet peers (F9). Pull model: the tailnet store polls every
   * 30s, pausing while the app is hidden. Unavailable states hide the
   * sidebar section — they are answers, not errors.
   */
  tailscale_peers: { payload: Record<string, never>; result: TailscalePeersResult };
  /** Warm the path to a dozing peer (`tailscale ping`) — toast the result. */
  tailscale_ping: { payload: TailscalePingPayload; result: TailscalePingResult };
  /**
   * Export `~/.config/setu` as an age-encrypted tarball (F8). Secrets
   * stay out unless the explicit `includeSecrets` toggle is on.
   */
  vault_export: { payload: VaultExportPayload; result: VaultExportResult };
  /** Read the whole `settings.toml`, fresh-parsed (hand edits included). */
  settings_get: { payload: Record<string, never>; result: SettingsDocument };
  /**
   * Validate and save the whole `settings.toml` atomically; on success
   * every window gets `settings:changed` and hot-applies (Phase 8).
   */
  settings_set: { payload: SettingsSetPayload; result: SettingsSetResult };
  /** Open (or focus) the Settings window — ⌘, and the palette land here. */
  settings_window_open: { payload: Record<string, never>; result: null };
  /** Read the sync dot's state (F10). Local-only; never fetches. */
  git_sync_status: { payload: Record<string, never>; result: GitSyncStatus };
  /**
   * "Sync now" (F10): lint → add → commit → fetch → rebase → push. Lint
   * blocks and conflicts come back result-side; conflicted rebases are
   * left in progress (never auto-resolved).
   */
  git_sync_run: { payload: Record<string, never>; result: GitSyncRunResult };
  /**
   * Point the config repo's `origin` at a URL (empty removes it). The
   * remote lives in `.git/config`, never in the synced settings.toml.
   */
  git_sync_set_remote: { payload: SetRemotePayload; result: SetRemoteResult };
  /** Abort the paused rebase — the one-click escape from `conflict`. */
  git_sync_abort: { payload: Record<string, never>; result: GitSyncStatus };
  /** Open the config dir in Finder (the F10 conflict path). */
  sync_open_dir: { payload: Record<string, never>; result: null };
  /** Take a config-dir snapshot right now (tar.gz into the state dir). */
  snapshot_now: { payload: Record<string, never>; result: SnapshotNowResult };
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
 * - `forward:update` — one health transition per event, every rule on the
 *   one channel (the payload carries the rule key; F7).
 * - `settings:changed` — the document as just saved; the cross-window
 *   propagation channel (the Settings window saves, the main window
 *   hot-applies; Phase 8).
 * - `sync:update` — a fresh sync status after any mutating sync command;
 *   keeps the footer dot live from either window (F10).
 */
export interface IpcEvents {
  [channel: `pty:data:${string}`]: string;
  [channel: `pty:exit:${string}`]: PtyExitEvent;
  [channel: `sftp:progress:${string}`]: SftpProgressEvent;
  "reach:update": ReachUpdate;
  "hostkey:prompt": HostkeyPromptEvent;
  "forward:update": ForwardStatus;
  "settings:changed": SettingsDocument;
  "sync:update": GitSyncStatus;
}
