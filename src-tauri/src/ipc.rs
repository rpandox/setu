//! The Tauri IPC command surface.
//!
//! Every `#[tauri::command]` Setu exposes is declared here, and every one of
//! them is mirrored by a typed entry in `src/ipc/contract.ts` on the frontend.
//! The two files plus `docs/dev/ipc.md` form a triplet that changes in the
//! same commit or not at all (`CLAUDE.md`).
//!
//! Phase 1 shipped the `pty_*` family for local shell tabs; Phase 2 widens
//! `pty_spawn` to SSH sessions and adds the `hosts_*` family over the
//! `hosts.toml` store and the `~/.ssh/config` import. This module also
//! hosts [`TauriPtyEvents`], the adapter that turns [`PtyEvents`] callbacks
//! into `pty:data:{sessionId}` / `pty:exit:{sessionId}` events on the
//! WebView side.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::pty::{PtyEvents, PtyManager};
use crate::store::{FieldError, Host, HostsStore, UpsertOutcome};
use crate::{connect, ssh_config};

/// What kind of process a PTY session drives.
///
/// Phase 2 implements `local` and `ssh`; `mosh` arrives in Phase 7
/// (mirrors `PtyKind` in `contract.ts`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyKind {
    /// `$SHELL` as a login shell on this machine.
    Local,
    /// System `ssh -tt` to a known host (`hostId` names it).
    Ssh,
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
/// **Payload:** `{ kind: "local", cols, rows }` or `{ kind: "ssh", hostId,
/// cols, rows }` · **Result:** `{ sessionId }` · **Emits:**
/// `pty:data:{sessionId}` (base64 chunks) from spawn onward, then one final
/// `pty:exit:{sessionId}`.
///
/// SSH sessions run system `ssh -tt` with keepalive flags (F3): imported
/// `sshcfg:` hosts connect via their bare alias, Setu hosts via explicit
/// flags — see [`connect::ssh_argv`]. First-connect host-key prompts appear
/// in the terminal itself.
///
/// # Errors
///
/// Fails when the PTY cannot be opened, the child cannot be spawned, `kind`
/// is `"ssh"` without a `hostId`, or the host id is unknown. No session is
/// created on failure.
#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    hosts: State<'_, HostsStore>,
    kind: PtyKind,
    cols: u16,
    rows: u16,
    host_id: Option<String>,
) -> Result<PtySpawnResult, String> {
    match kind {
        PtyKind::Local => manager
            .spawn_local(cols, rows)
            .map(|session_id| PtySpawnResult { session_id }),
        PtyKind::Ssh => {
            let host_id = host_id.ok_or("hostId is required for ssh sessions")?;
            let host = resolve_host(&hosts, &host_id)?;
            manager
                .spawn_command(connect::ssh_command(&host), cols, rows)
                .map(|session_id| PtySpawnResult { session_id })
        }
    }
}

/// Resolves a host id to its record: `sshcfg:` ids come from a fresh parse
/// of `~/.ssh/config`, everything else from the store.
fn resolve_host(hosts: &HostsStore, host_id: &str) -> Result<Host, String> {
    if let Some(alias) = host_id.strip_prefix(ssh_config::ID_PREFIX) {
        return ssh_config_rows()
            .into_iter()
            .find(|entry| entry.alias == alias)
            .map(|entry| ssh_config::to_host(&entry))
            .ok_or_else(|| format!("unknown ssh config alias: {alias}"));
    }
    hosts
        .get(host_id)?
        .ok_or_else(|| format!("unknown host: {host_id}"))
}

/// Parses `~/.ssh/config` fresh (stateless by design: no cache to
/// invalidate, and the file is small).
fn ssh_config_rows() -> Vec<ssh_config::ConfigEntry> {
    ssh_config::default_path()
        .map(|path| ssh_config::load(&path))
        .unwrap_or_default()
}

/// Result of [`host_upsert`] (mirrors `HostUpsertResult`): exactly one of
/// `host` (saved) or `errors` (validation failed) is populated. Validation
/// failures are expected editor outcomes, not command errors.
#[derive(Debug, Serialize)]
pub struct HostUpsertResult {
    /// The saved record (with its assigned id), when validation passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<Host>,
    /// Field-level validation failures, when it did not.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<FieldError>,
}

/// Lists every known host: persisted `hosts.toml` records first, then rows
/// parsed live from `~/.ssh/config` (read-only until adopted).
///
/// **Payload:** none · **Result:** `Host[]` · **Emits:** nothing.
///
/// An imported alias is hidden once a persisted host carries the same label
/// (that's what "Adopt" creates), so adopted rows don't show up twice.
///
/// # Errors
///
/// Fails when `hosts.toml` exists but cannot be read or parsed. A missing
/// or unreadable `~/.ssh/config` contributes no rows and no error.
#[tauri::command]
pub fn hosts_list(hosts: State<'_, HostsStore>) -> Result<Vec<Host>, String> {
    let mut all = hosts.list()?;
    let labels: HashSet<String> = all.iter().map(|h| h.label.clone()).collect();
    all.extend(
        ssh_config_rows()
            .iter()
            .filter(|entry| !labels.contains(&entry.alias))
            .map(ssh_config::to_host),
    );
    Ok(all)
}

/// Creates or updates a host in `hosts.toml` (empty `id` = create).
///
/// **Payload:** `{ host }` (snake_case `Host` fields) · **Result:**
/// `{ host }` on success, `{ errors: [{field, message}] }` on validation
/// failure · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the store cannot be read or written, or when a non-empty `id`
/// matches no record. Validation failures are returned in the result, not
/// as an error.
#[tauri::command]
pub fn host_upsert(
    hosts: State<'_, HostsStore>,
    host: Host,
) -> Result<HostUpsertResult, String> {
    Ok(match hosts.upsert(host)? {
        UpsertOutcome::Saved(host) => HostUpsertResult {
            host: Some(*host),
            errors: Vec::new(),
        },
        UpsertOutcome::Invalid(errors) => HostUpsertResult { host: None, errors },
    })
}

/// Deletes a host from `hosts.toml`. Unknown ids are a no-op; live sessions
/// to the host keep running (the frontend marks their tabs "(orphaned)").
///
/// **Payload:** `{ hostId }` · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the store cannot be read or written.
#[tauri::command]
pub fn host_delete(hosts: State<'_, HostsStore>, host_id: String) -> Result<(), String> {
    hosts.delete(&host_id)
}

/// Adopts an imported `~/.ssh/config` row: copies it into `hosts.toml` as
/// an editable `source = "setu"` record (F1). The original config file is
/// never touched.
///
/// **Payload:** `{ hostId }` (an `sshcfg:` id) · **Result:** the new
/// persisted `Host` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the id is not an `sshcfg:` id, the alias no longer exists in
/// the config, the copied record fails validation (e.g. its `IdentityFile`
/// is missing on disk), or the store cannot be written.
#[tauri::command]
pub fn host_adopt(hosts: State<'_, HostsStore>, host_id: String) -> Result<Host, String> {
    let alias = host_id
        .strip_prefix(ssh_config::ID_PREFIX)
        .ok_or_else(|| format!("not an ssh config host: {host_id}"))?;
    let entry = ssh_config_rows()
        .into_iter()
        .find(|entry| entry.alias == alias)
        .ok_or_else(|| format!("unknown ssh config alias: {alias}"))?;
    match hosts.upsert(ssh_config::to_adoptable_host(&entry))? {
        UpsertOutcome::Saved(host) => Ok(*host),
        UpsertOutcome::Invalid(errors) => Err(errors
            .first()
            .map(|e| format!("{}: {}", e.field, e.message))
            .unwrap_or_else(|| "validation failed".to_string())),
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
