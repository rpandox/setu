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
 * Invokable commands, keyed by command name.
 *
 * Phase 1 shipped the `pty_*` family; Phase 2 adds SSH spawning and the
 * `hosts_*` family over `hosts.toml` and the `~/.ssh/config` import;
 * Phase 3 adds the `ui_state_*` pair over `state.json`; Phase 4 adds the
 * `reach_*` family driving the LED board.
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
}

/**
 * Events emitted by the Rust core, keyed by event channel name.
 *
 * - `pty:data:{sessionId}` — a base64-encoded chunk of raw PTY output.
 * - `pty:exit:{sessionId}` — the session's child exited; final event for
 *   that session.
 * - `reach:update` — one probe result; all hosts share the channel (the
 *   payload carries the host id).
 */
export interface IpcEvents {
  [channel: `pty:data:${string}`]: string;
  [channel: `pty:exit:${string}`]: PtyExitEvent;
  "reach:update": ReachUpdate;
}
