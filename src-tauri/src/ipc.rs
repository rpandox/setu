//! The Tauri IPC command surface.
//!
//! Every `#[tauri::command]` Setu exposes is declared here, and every one of
//! them is mirrored by a typed entry in `src/ipc/contract.ts` on the frontend.
//! The two files plus `docs/dev/ipc.md` form a triplet that changes in the
//! same commit or not at all (`CLAUDE.md`).
//!
//! Phase 1 shipped the `pty_*` family for local shell tabs; Phase 2 widens
//! `pty_spawn` to SSH sessions and adds the `hosts_*` family over the
//! `hosts.toml` store and the `~/.ssh/config` import; Phase 4 adds the
//! `reach_*` family driving the LED board; Phase 5 adds the `sftp_*` family
//! (dual-pane browser + transfers) and `hostkey_trust`. This module also
//! hosts the event bridges — [`TauriPtyEvents`] for `pty:data:{sessionId}` /
//! `pty:exit:{sessionId}`, [`TauriReachEvents`] for `reach:update`, and
//! [`TauriSftpEvents`] for `hostkey:prompt` / `sftp:progress:{transferId}` —
//! plus [`AppTargetSource`], the prober's view of the host list.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::pty::{PtyEvents, PtyManager};
use crate::reach::{ProbeTarget, ReachEvents, ReachProber, ReachState, TargetSource};
use crate::settings::SettingsStore;
use crate::sftp::{HostTarget, SftpEntry, SftpEvents, SftpManager};
use crate::store::{FieldError, Host, HostsStore, UpsertOutcome};
use crate::ui_state::{UiState, UiStateStore};
use crate::{connect, reach, sftp, ssh_config};

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

/// Payload of a `reach:update` event (mirrors `ReachUpdate` in
/// `contract.ts`). One event per completed probe, all hosts on one channel
/// — the reach store is the single consumer (PLAN.md §5, Phase 4 row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReachUpdatePayload {
    /// The probed host (`Host.id`).
    host_id: String,
    /// `"up"` or `"down"`.
    state: &'static str,
    /// Connect latency in ms; present only when `state` is `"up"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    rtt_ms: Option<u32>,
}

/// [`ReachEvents`] sink that forwards probe results to the WebView as
/// `reach:update` events. Constructed once at app setup and handed to the
/// [`ReachProber`].
pub struct TauriReachEvents {
    /// Handle used to emit events to all windows.
    app: AppHandle,
}

impl TauriReachEvents {
    /// Creates a sink emitting through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ReachEvents for TauriReachEvents {
    fn on_update(&self, host_id: &str, state: ReachState, rtt_ms: Option<u32>) {
        let _ = self.app.emit(
            "reach:update",
            ReachUpdatePayload {
                host_id: host_id.to_string(),
                state: match state {
                    ReachState::Up => "up",
                    ReachState::Down => "down",
                },
                rtt_ms,
            },
        );
    }
}

/// Payload of a `hostkey:prompt` event (mirrors `HostkeyPromptEvent` in
/// `contract.ts`) — an unknown host key awaiting the user's verdict in the
/// FingerprintDialog (F5).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostkeyPromptPayload {
    /// The host being connected (`Host.id`) — echoes back in `hostkey_trust`.
    host_id: String,
    /// Display label for the dialog title.
    host_label: String,
    /// Key algorithm, e.g. `"ssh-ed25519"`.
    algorithm: String,
    /// OpenSSH-format `SHA256:<base64>` fingerprint.
    fingerprint: String,
}

/// Payload of a `sftp:progress:{transferId}` event (mirrors
/// `SftpProgressEvent` in `contract.ts`). `state` is `"running"` for the
/// throttled mid-flight stream and exactly one terminal value —
/// `"done"` / `"failed"` / `"cancelled"` — closes the channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpProgressPayload {
    /// Bytes moved so far.
    bytes: u64,
    /// Total bytes expected; `0` when the size is unknown.
    total: u64,
    /// `"running"`, `"done"`, `"failed"`, or `"cancelled"`.
    state: &'static str,
    /// The failure message, on `"failed"` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Whether an auto-retry is worth attempting, on `"failed"` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    retryable: Option<bool>,
}

/// [`SftpEvents`] sink that forwards SFTP prompts and transfer progress to
/// the WebView as Tauri events. Constructed once at app setup and handed to
/// the [`SftpManager`].
pub struct TauriSftpEvents {
    /// Handle used to emit events to all windows.
    app: AppHandle,
}

impl TauriSftpEvents {
    /// Creates a sink emitting through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// Emits one progress payload for `transfer_id`.
    fn emit_progress(&self, transfer_id: &str, payload: SftpProgressPayload) {
        let _ = self
            .app
            .emit(&format!("sftp:progress:{transfer_id}"), payload);
    }
}

impl SftpEvents for TauriSftpEvents {
    fn on_hostkey_prompt(
        &self,
        host_id: &str,
        host_label: &str,
        algorithm: &str,
        fingerprint: &str,
    ) {
        let _ = self.app.emit(
            "hostkey:prompt",
            HostkeyPromptPayload {
                host_id: host_id.to_string(),
                host_label: host_label.to_string(),
                algorithm: algorithm.to_string(),
                fingerprint: fingerprint.to_string(),
            },
        );
    }

    fn on_progress(&self, transfer_id: &str, bytes: u64, total: u64) {
        self.emit_progress(
            transfer_id,
            SftpProgressPayload {
                bytes,
                total,
                state: "running",
                error: None,
                retryable: None,
            },
        );
    }

    fn on_done(&self, transfer_id: &str, bytes: u64, total: u64) {
        self.emit_progress(
            transfer_id,
            SftpProgressPayload {
                bytes,
                total,
                state: "done",
                error: None,
                retryable: None,
            },
        );
    }

    fn on_failed(&self, transfer_id: &str, error: &str, retryable: bool) {
        self.emit_progress(
            transfer_id,
            SftpProgressPayload {
                bytes: 0,
                total: 0,
                state: "failed",
                error: Some(error.to_string()),
                retryable: Some(retryable),
            },
        );
    }

    fn on_cancelled(&self, transfer_id: &str) {
        self.emit_progress(
            transfer_id,
            SftpProgressPayload {
                bytes: 0,
                total: 0,
                state: "cancelled",
                error: None,
                retryable: None,
            },
        );
    }
}

/// [`TargetSource`] over the app's managed [`HostsStore`]: every sweep
/// re-derives the same union `hosts_list` returns, so host CRUD since the
/// last sweep is always reflected.
pub struct AppTargetSource {
    /// Handle used to reach the managed [`HostsStore`].
    app: AppHandle,
}

impl AppTargetSource {
    /// Creates a source reading through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl TargetSource for AppTargetSource {
    fn targets(&self) -> Vec<ProbeTarget> {
        match all_hosts(&self.app.state::<HostsStore>()) {
            Ok(hosts) => reach::probe_targets(&hosts),
            Err(e) => {
                // A corrupt hosts.toml already surfaces in the sidebar; the
                // prober just has nothing to probe until it is fixed.
                eprintln!("[reach] cannot list hosts: {e}");
                Vec::new()
            }
        }
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
    all_hosts(&hosts)
}

/// The full host union behind [`hosts_list`] — persisted records plus live
/// `~/.ssh/config` rows — shared with the prober's [`AppTargetSource`] so
/// the LED board and the sidebar always see the same list.
fn all_hosts(hosts: &HostsStore) -> Result<Vec<Host>, String> {
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

/// Result of [`reach_start`] (mirrors `ReachStartResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReachStartResult {
    /// `false` when the global kill switch (`settings.reachability.enabled`)
    /// is off — an expected outcome, not an error.
    pub started: bool,
}

/// Starts (or refreshes) the reachability prober behind the LED board (F1).
///
/// **Payload:** none · **Result:** `{ started }` · **Emits:** one
/// `reach:update` per probed host, every sweep, until stopped.
///
/// The first call spawns the sweep loop and probes immediately; later calls
/// re-read `settings.toml` and trigger an immediate fresh sweep (the
/// frontend re-invokes after host CRUD so new hosts light up right away).
/// Returns `{ started: false }` without probing when the global kill switch
/// is off — the per-host switch is `Host.reachability`.
///
/// # Errors
///
/// Fails when `settings.toml` exists but cannot be read or parsed.
#[tauri::command]
pub fn reach_start(
    prober: State<'_, ReachProber>,
    settings: State<'_, SettingsStore>,
) -> Result<ReachStartResult, String> {
    let config = settings.reachability()?;
    if !config.enabled {
        eprintln!("[reach] disabled in settings.toml — not probing");
        return Ok(ReachStartResult { started: false });
    }
    prober.start(config);
    Ok(ReachStartResult { started: true })
}

/// Stops the reachability prober; in-flight probes finish within their
/// timeout and no further `reach:update` events are emitted.
///
/// **Payload:** none · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Never fails — stopping an idle prober is a no-op.
#[tauri::command]
pub fn reach_stop(prober: State<'_, ReachProber>) -> Result<(), String> {
    prober.stop();
    Ok(())
}

/// Reports app visibility so probing can pause when hidden (F1): the
/// frontend calls this on every `document.visibilitychange`. Hidden longer
/// than 60s pauses sweeping; becoming visible after such a pause triggers
/// an immediate sweep.
///
/// **Payload:** `{ visible }` · **Result:** `null` · **Emits:** nothing
/// directly (the resume sweep emits `reach:update` as usual).
///
/// # Errors
///
/// Never fails.
#[tauri::command]
pub fn reach_set_visible(prober: State<'_, ReachProber>, visible: bool) -> Result<(), String> {
    prober.set_visible(visible);
    Ok(())
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
pub fn host_upsert(hosts: State<'_, HostsStore>, host: Host) -> Result<HostUpsertResult, String> {
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

/// Returns the device-local UI state from `state.json` (PLAN.md §4).
///
/// **Payload:** none · **Result:** the full `UiState` (camelCase) ·
/// **Emits:** nothing.
///
/// A missing file is the default state — first launch needs no setup. The
/// frontend hydrates the sidebar collapse set, the broadcast auto-disarm
/// flag, and (when `restoreOnLaunch` is set) the saved tab layout from it.
///
/// # Errors
///
/// Fails when `state.json` exists but cannot be read or parsed. The
/// frontend treats that as defaults and disables persistence for the run,
/// so a corrupt file is never overwritten.
#[tauri::command]
pub fn ui_state_get(ui: State<'_, UiStateStore>) -> Result<UiState, String> {
    ui.get()
}

/// Replaces `state.json` with the given state (atomic write).
///
/// **Payload:** `{ state: UiState }` · **Result:** `null` · **Emits:**
/// nothing.
///
/// The frontend debounces layout/preference changes into whole-document
/// writes; there is no partial update.
///
/// # Errors
///
/// Fails when the existing file cannot be read or parsed (corrupt files
/// are never overwritten) or the write fails.
#[tauri::command]
pub fn ui_state_set(ui: State<'_, UiStateStore>, state: UiState) -> Result<(), String> {
    ui.set(state)
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

/// Result of a successful [`sftp_connect`] (mirrors `SftpConnectResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectResult {
    /// Keys every later SFTP command and its transfers.
    pub sftp_session_id: String,
}

/// Result of [`sftp_list`] / [`sftp_local_list`] (mirrors `SftpListResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListResult {
    /// The directory's entries, name-sorted, `.`/`..` omitted.
    pub entries: Vec<SftpEntry>,
}

/// Result of [`sftp_upload`] / [`sftp_download`] (mirrors
/// `SftpTransferResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResult {
    /// Keys the `sftp:progress:{transferId}` stream and [`sftp_cancel`].
    pub transfer_id: String,
}

/// Opens an SFTP session to a host (F5) — russh + agent/key auth, never a
/// password (Phase 7).
///
/// **Payload:** `{ hostId }` · **Result:** `{ sftpSessionId }` · **Emits:**
/// one `hostkey:prompt` when the host key is unknown, then blocks until
/// [`hostkey_trust`] resolves it.
///
/// Host-key policy (CLAUDE.md): a known key connects silently; an unknown
/// key prompts; a mismatched or revoked key fails hard — never a prompt.
/// Trusting appends one line to `~/.ssh/known_hosts`.
///
/// # Errors
///
/// Fails when the host id is unknown, the record has no hostname, the host
/// is unreachable, the key is mismatched/revoked/declined, every auth
/// method is exhausted, or the sftp subsystem can't start. No session
/// exists after a failure.
#[tauri::command]
pub async fn sftp_connect(
    manager: State<'_, SftpManager>,
    hosts: State<'_, HostsStore>,
    host_id: String,
) -> Result<SftpConnectResult, String> {
    let host = resolve_host(&hosts, &host_id)?;
    let target = HostTarget::from_host(&host)?;
    manager
        .connect(target)
        .await
        .map(|sftp_session_id| SftpConnectResult { sftp_session_id })
}

/// Delivers the FingerprintDialog verdict for a pending `hostkey:prompt`.
///
/// **Payload:** `{ hostId, accept }` · **Result:** `null` · **Emits:**
/// nothing (the parked [`sftp_connect`] resumes or fails).
///
/// `accept: true` appends the key to `~/.ssh/known_hosts` (the only
/// known_hosts write in the app, append-only); `false` fails the connect.
///
/// # Errors
///
/// Fails when no prompt is pending for the host (already resolved, or the
/// connect died while the dialog was open).
#[tauri::command]
pub fn hostkey_trust(
    manager: State<'_, SftpManager>,
    host_id: String,
    accept: bool,
) -> Result<(), String> {
    manager.resolve_trust(&host_id, accept)
}

/// Closes an SFTP session and cancels its running transfers.
///
/// **Payload:** `{ sftpSessionId }` · **Result:** `null` · **Emits:** one
/// terminal `sftp:progress:{transferId}` per cancelled transfer.
///
/// # Errors
///
/// Never fails — unknown ids are a no-op (idempotent close).
#[tauri::command]
pub async fn sftp_disconnect(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
) -> Result<(), String> {
    manager.disconnect(&sftp_session_id).await;
    Ok(())
}

/// Lists a remote directory (one round-trip, whole listing).
///
/// **Payload:** `{ sftpSessionId, path }` · **Result:** `{ entries }` ·
/// **Emits:** nothing.
///
/// Symlink entries describe the link (`isDir: false`, `linkTarget` set);
/// following happens via [`sftp_stat`] on double-click. Hidden-file
/// filtering is a frontend view concern — the listing is complete.
///
/// # Errors
///
/// Fails when the session is unknown or the server refuses (permission
/// denied surfaces verbatim, F5).
#[tauri::command]
pub async fn sftp_list(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
) -> Result<SftpListResult, String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_list(&session, &path)
        .await
        .map(|entries| SftpListResult { entries })
}

/// Stats a remote path, following symlinks — the explicit follow half of
/// the F5 symlink behavior.
///
/// **Payload:** `{ sftpSessionId, path }` · **Result:** an `SftpEntry` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the session is unknown or the path doesn't resolve (broken
/// links included).
#[tauri::command]
pub async fn sftp_stat(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
) -> Result<SftpEntry, String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_stat(&session, &path).await
}

/// Creates a remote directory.
///
/// **Payload:** `{ sftpSessionId, path }` · **Result:** `null` · **Emits:**
/// nothing.
///
/// # Errors
///
/// Fails when the session is unknown or the server refuses (exists,
/// permission denied, …).
#[tauri::command]
pub async fn sftp_mkdir(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
) -> Result<(), String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_mkdir(&session, &path).await
}

/// Renames (moves) a remote file or directory.
///
/// **Payload:** `{ sftpSessionId, from, to }` · **Result:** `null` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the session is unknown or the server refuses (many servers
/// won't overwrite an existing target).
#[tauri::command]
pub async fn sftp_rename(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_rename(&session, &from, &to).await
}

/// Deletes a remote file, or a directory recursively (client-side walk;
/// symlinks are removed as links, never followed).
///
/// **Payload:** `{ sftpSessionId, path, isDir }` · **Result:** `null` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails on the first server refusal and stops there — a partial delete
/// leaves the remainder listed.
#[tauri::command]
pub async fn sftp_delete(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_delete(&session, &path, is_dir).await
}

/// Sets a remote path's permission bits (the chmod dialog).
///
/// **Payload:** `{ sftpSessionId, path, mode }` (numeric, e.g. `0o755` sent
/// as `493`) · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the session is unknown, `mode` exceeds `0o7777`, or the
/// server refuses.
#[tauri::command]
pub async fn sftp_chmod(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_chmod(&session, &path, mode).await
}

/// Lists a local directory for the local pane — same shape as
/// [`sftp_list`], via `std::fs`.
///
/// **Payload:** `{ path }` · **Result:** `{ entries }` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the directory can't be read (missing, permission denied, …).
#[tauri::command]
pub fn sftp_local_list(path: String) -> Result<SftpListResult, String> {
    sftp::local_list(std::path::Path::new(&path)).map(|entries| SftpListResult { entries })
}

/// Stats a local path, following symlinks.
///
/// **Payload:** `{ path }` · **Result:** an `SftpEntry` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the path doesn't resolve (broken links included).
#[tauri::command]
pub fn sftp_local_stat(path: String) -> Result<SftpEntry, String> {
    sftp::local_stat(std::path::Path::new(&path))
}

/// Creates a local directory.
///
/// **Payload:** `{ path }` · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the OS refuses (exists, permission denied, …).
#[tauri::command]
pub fn sftp_local_mkdir(path: String) -> Result<(), String> {
    sftp::local_mkdir(std::path::Path::new(&path))
}

/// Renames (moves) a local file or directory.
///
/// **Payload:** `{ from, to }` · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the OS refuses.
#[tauri::command]
pub fn sftp_local_rename(from: String, to: String) -> Result<(), String> {
    sftp::local_rename(std::path::Path::new(&from), std::path::Path::new(&to))
}

/// Deletes a local file, or a directory recursively.
///
/// **Payload:** `{ path, isDir }` · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the OS refuses.
#[tauri::command]
pub fn sftp_local_delete(path: String, is_dir: bool) -> Result<(), String> {
    sftp::local_delete(std::path::Path::new(&path), is_dir)
}

/// Sets a local path's permission bits (the chmod dialog works on both
/// panes).
///
/// **Payload:** `{ path, mode }` (numeric) · **Result:** `null` · **Emits:**
/// nothing.
///
/// # Errors
///
/// Fails when `mode` exceeds `0o7777` or the OS refuses.
#[tauri::command]
pub fn sftp_local_chmod(path: String, mode: u32) -> Result<(), String> {
    sftp::local_chmod(std::path::Path::new(&path), mode)
}

/// Starts an upload (local → remote) and returns immediately with its
/// transfer id; progress streams as events. The queue — concurrency 3,
/// auto-retry ×1 on retryable failures — lives in the frontend store.
///
/// **Payload:** `{ sftpSessionId, localPath, remotePath }` · **Result:**
/// `{ transferId }` · **Emits:** throttled
/// `sftp:progress:{transferId}` (`state: "running"`), then exactly one
/// terminal `"done"` / `"failed"` / `"cancelled"`.
///
/// Cancel and failure both clean up the partial remote file (best-effort).
///
/// # Errors
///
/// Fails when the session is unknown, the local file can't be read, or the
/// local path is a directory (the store expands folders into per-file
/// transfers). Failures mid-transfer arrive as events, not command errors.
#[tauri::command]
pub async fn sftp_upload(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<SftpTransferResult, String> {
    manager
        .upload(&sftp_session_id, &local_path, &remote_path)
        .await
        .map(|transfer_id| SftpTransferResult { transfer_id })
}

/// Starts a download (remote → local); see [`sftp_upload`] for the
/// event/queue contract. Cleanup covers the partial local file.
///
/// **Payload:** `{ sftpSessionId, remotePath, localPath }` · **Result:**
/// `{ transferId }` · **Emits:** as [`sftp_upload`].
///
/// # Errors
///
/// Fails when the session is unknown, the remote path can't be statted, or
/// it is a directory.
#[tauri::command]
pub async fn sftp_download(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<SftpTransferResult, String> {
    manager
        .download(&sftp_session_id, &remote_path, &local_path)
        .await
        .map(|transfer_id| SftpTransferResult { transfer_id })
}

/// Cancels a running transfer; the partial destination file is removed and
/// the terminal `"cancelled"` progress event follows.
///
/// **Payload:** `{ transferId }` · **Result:** `null` · **Emits:** one
/// terminal `sftp:progress:{transferId}`.
///
/// # Errors
///
/// Never fails — unknown ids are a no-op, so cancelling can't race a
/// transfer that just finished.
#[tauri::command]
pub fn sftp_cancel(manager: State<'_, SftpManager>, transfer_id: String) -> Result<(), String> {
    manager.cancel(&transfer_id);
    Ok(())
}
