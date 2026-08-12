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
 * Conventions (applied from Phase 1 on):
 * - Commands map a name to `{ payload, result }` types; events map a name to
 *   their payload type. Names are `snake_case` to match the Rust side.
 * - Session-scoped events embed the id in the channel name,
 *   e.g. `pty:data:{sessionId}`.
 */

/**
 * Invokable commands, keyed by command name.
 *
 * Empty in Phase 0 — no commands exist yet. Phase 1 adds the `pty_*` family
 * (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`).
 */
export type IpcCommands = Record<string, never>;

/**
 * Events emitted by the Rust core, keyed by event channel name.
 *
 * Empty in Phase 0 — no events exist yet. Phase 1 adds
 * `pty:data:{sessionId}` and `pty:exit:{sessionId}`.
 */
export type IpcEvents = Record<string, never>;
