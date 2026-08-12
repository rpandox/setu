//! The Tauri IPC command surface.
//!
//! Every `#[tauri::command]` Setu exposes is declared here, and every one of
//! them is mirrored by a typed entry in `src/ipc/contract.ts` on the frontend.
//! The two files plus `docs/dev/ipc.md` form a triplet that changes in the
//! same commit or not at all (`CLAUDE.md`).
//!
//! Phase 1 ships the `pty_*` family for local shell tabs. This module also
//! hosts [`TauriPtyEvents`], the adapter that turns [`PtyEvents`] callbacks
//! into `pty:data:{sessionId}` / `pty:exit:{sessionId}` events on the
//! WebView side.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::pty::{PtyEvents, PtyManager};

/// What kind of process a PTY session drives.
///
/// Phase 1 implements `local` only; the enum widens to `ssh`/`mosh` in
/// Phase 2 (mirrors `PtyKind` in `contract.ts`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyKind {
    /// `$SHELL` as a login shell on this machine.
    Local,
}

/// Result of a successful [`pty_spawn`] (mirrors `PtySpawnResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnResult {
    /// Unique id for the new session; keys all later commands and events.
    pub session_id: String,
}

/// Payload of a `pty:exit:{sessionId}` event (mirrors `PtyExitEvent`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    /// Exit code, or `None` when the child died from a signal.
    code: Option<i32>,
}

/// [`PtyEvents`] sink that forwards PTY output and exits to the WebView as
/// Tauri events. Constructed once at app setup and handed to the
/// [`PtyManager`].
pub struct TauriPtyEvents {
    /// Handle used to emit events to all windows.
    app: AppHandle,
}

impl TauriPtyEvents {
    /// Creates a sink emitting through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl PtyEvents for TauriPtyEvents {
    fn on_data(&self, session_id: &str, chunk_base64: &str) {
        // Emit failures (e.g. during teardown) are dropped by design: PTY
        // contents must never reach logs (CLAUDE.md hard rule).
        let _ = self
            .app
            .emit(&format!("pty:data:{session_id}"), chunk_base64);
    }

    fn on_exit(&self, session_id: &str, code: Option<i32>) {
        let _ = self
            .app
            .emit(&format!("pty:exit:{session_id}"), PtyExitPayload { code });
    }
}

/// Spawns a new PTY session and returns its id.
///
/// **Payload:** `{ kind: "local", cols, rows }` · **Result:**
/// `{ sessionId }` · **Emits:** `pty:data:{sessionId}` (base64 chunks) from
/// spawn onward, then one final `pty:exit:{sessionId}`.
///
/// # Errors
///
/// Fails when the PTY cannot be opened or the shell cannot be spawned
/// (missing `$SHELL` binary, resource exhaustion). No session is created on
/// failure.
#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    kind: PtyKind,
    cols: u16,
    rows: u16,
) -> Result<PtySpawnResult, String> {
    match kind {
        PtyKind::Local => manager
            .spawn_local(cols, rows)
            .map(|session_id| PtySpawnResult { session_id }),
    }
}

/// Writes input (keystrokes, paste text) to a session's stdin.
///
/// **Payload:** `{ sessionId, data }` · **Result:** `null` · **Emits:**
/// nothing directly (output comes back via `pty:data:{sessionId}`).
///
/// # Errors
///
/// Fails when the session id is unknown (already exited) or the underlying
/// write fails.
#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&session_id, &data)
}

/// Propagates a terminal resize to the PTY (the child sees `SIGWINCH`).
///
/// **Payload:** `{ sessionId, cols, rows }` · **Result:** `null` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the session id is unknown or the kernel rejects the resize.
#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows)
}

/// Terminates a session's child process. Cleanup and the final
/// `pty:exit:{sessionId}` event follow asynchronously, exactly as when the
/// child exits on its own.
///
/// **Payload:** `{ sessionId }` · **Result:** `null` · **Emits:**
/// `pty:exit:{sessionId}` (via the normal exit path).
///
/// # Errors
///
/// Never fails today — unknown ids are a documented no-op so closing a tab
/// can never race the child's own exit.
#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, session_id: String) -> Result<(), String> {
    manager.kill(&session_id)
}
