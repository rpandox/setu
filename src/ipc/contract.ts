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
 * - Session-scoped events embed the id in the channel name,
 *   e.g. `pty:data:{sessionId}`.
 */

/**
 * What kind of process a PTY session drives.
 *
 * Phase 1 implements `"local"` only ($SHELL as a login shell). The union
 * widens to `"ssh" | "mosh"` in Phase 2 — the contract types exactly what
 * exists, nothing speculative.
 */
export type PtyKind = "local";

/** Payload for `pty_spawn`. */
export interface PtySpawnPayload {
  /** The kind of session to start. Phase 1: `"local"` only. */
  kind: PtyKind;
  /** Initial terminal width, in columns. */
  cols: number;
  /** Initial terminal height, in rows. */
  rows: number;
}

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
 * Invokable commands, keyed by command name.
 *
 * Phase 1 ships the `pty_*` family for local shell tabs.
 */
export interface IpcCommands {
  /** Spawn a new PTY session running `$SHELL` as a login shell. */
  pty_spawn: { payload: PtySpawnPayload; result: PtySpawnResult };
  /** Write input to a running session. */
  pty_write: { payload: PtyWritePayload; result: null };
  /** Propagate a terminal resize to the PTY and its child. */
  pty_resize: { payload: PtyResizePayload; result: null };
  /** Terminate a session's child process; cleanup follows via `pty:exit`. */
  pty_kill: { payload: PtyKillPayload; result: null };
}

/**
 * Events emitted by the Rust core, keyed by event channel name.
 *
 * - `pty:data:{sessionId}` — a base64-encoded chunk of raw PTY output.
 * - `pty:exit:{sessionId}` — the session's child exited; final event for
 *   that session.
 */
export interface IpcEvents {
  [channel: `pty:data:${string}`]: string;
  [channel: `pty:exit:${string}`]: PtyExitEvent;
}
