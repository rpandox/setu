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
//! (dual-pane browser + transfers) and `hostkey_trust`; Phase 6 adds the
//! `snippet_*` family over `snippets.toml` (CRUD + packs); Phase 7 adds the
//! `keychain_*` family (set / delete / has — never get: secrets are read
//! only inside the core, F8), plus `keys_generate` and `agent_list` behind
//! the Keys panel. This module also
//! hosts the event bridges — [`TauriPtyEvents`] for `pty:data:{sessionId}` /
//! `pty:exit:{sessionId}`, [`TauriReachEvents`] for `reach:update`, and
//! [`TauriSftpEvents`] for `hostkey:prompt` / `sftp:progress:{transferId}` —
//! plus [`AppTargetSource`], the prober's view of the host list.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _, State};

use crate::forwards::{ForwardEvents, ForwardManager, ForwardUpdate, StartOutcome};
use crate::pty::{PtyEvents, PtyManager};
use crate::reach::{ProbeTarget, ReachEvents, ReachProber, ReachState, TargetSource};
use crate::settings::SettingsStore;
use crate::sftp::{HostTarget, SftpEntry, SftpEvents, SftpManager};
use crate::snippets::{ImportOutcome, Snippet, SnippetUpsertOutcome, SnippetsStore};
use crate::store::{FieldError, Forward, Host, HostSource, HostsStore, UpsertOutcome};
use crate::ui_state::{UiState, UiStateStore};
use crate::{
    agent, binaries, connect, keychain, keygen, reach, sftp, ssh_config, tailscale, vault,
};

/// What kind of process a PTY session drives (mirrors `PtyKind` in
/// `contract.ts`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyKind {
    /// `$SHELL` as a login shell on this machine.
    Local,
    /// System `ssh -tt` to a known host (`hostId` names it).
    Ssh,
    /// System `mosh` to a known host (Phase 7; the host's `use_mosh`
    /// toggle routes here, preflighted by [`binary_check`]).
    Mosh,
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

/// Payload of a `forward:update` event (mirrors `ForwardStatus` in
/// `contract.ts`). One channel for all rules; the payload carries the rule
/// key (PLAN.md §5, Phase 6 row — the `reach:update` precedent).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardUpdatePayload {
    /// The rule's registry key (`{hostId}:{kind}:{spec}`).
    rule_key: String,
    /// The owning host's id.
    host_id: String,
    /// `"starting"`, `"amber"`, `"green"`, or `"red"`.
    state: &'static str,
    /// Why the rule is red; red only.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    /// The copyable SOCKS string for `D` rules.
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_string: Option<String>,
}

/// [`ForwardEvents`] sink that forwards health transitions to the WebView
/// as `forward:update` events. Constructed once at app setup and handed to
/// the [`ForwardManager`].
pub struct TauriForwardEvents {
    /// Handle used to emit events to all windows.
    app: AppHandle,
}

impl TauriForwardEvents {
    /// Creates a sink emitting through `app`.
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ForwardEvents for TauriForwardEvents {
    fn on_update(&self, update: &ForwardUpdate) {
        let _ = self.app.emit(
            "forward:update",
            ForwardUpdatePayload {
                rule_key: update.rule_key.clone(),
                host_id: update.host_id.clone(),
                state: update.state.as_str(),
                reason: update.reason.clone(),
                proxy_string: update.proxy.clone(),
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
/// is `"ssh"`/`"mosh"` without a `hostId`, the host id is unknown, or mosh
/// isn't installed. No session is created on failure.
#[tauri::command]
pub async fn pty_spawn(
    manager: State<'_, PtyManager>,
    hosts: State<'_, HostsStore>,
    settings: State<'_, SettingsStore>,
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
            let host = resolve_host(&hosts, &settings, &host_id).await?;
            manager
                .spawn_command(connect::ssh_command(&host), cols, rows)
                .map(|session_id| PtySpawnResult { session_id })
        }
        PtyKind::Mosh => {
            let host_id = host_id.ok_or("hostId is required for mosh sessions")?;
            let host = resolve_host(&hosts, &settings, &host_id).await?;
            // The absolute path matters twice: a GUI app's minimal PATH
            // can't see Homebrew's mosh, for the check or the spawn.
            let mosh = binaries::find("mosh")
                .ok_or("mosh isn't installed — brew install mosh, or turn the toggle off")?;
            manager
                .spawn_command(
                    connect::mosh_command(&host, &mosh.to_string_lossy()),
                    cols,
                    rows,
                )
                .map(|session_id| PtySpawnResult { session_id })
        }
    }
}

/// Resolves a host id to its record: `sshcfg:` ids come from a fresh parse
/// of `~/.ssh/config`, `ts:` ids from a fresh `tailscale status --json`
/// (both stateless by design — PLAN.md §5), everything else from the store.
async fn resolve_host(
    hosts: &HostsStore,
    settings: &SettingsStore,
    host_id: &str,
) -> Result<Host, String> {
    if let Some(alias) = host_id.strip_prefix(ssh_config::ID_PREFIX) {
        return ssh_config_rows()
            .into_iter()
            .find(|entry| entry.alias == alias)
            .map(|entry| ssh_config::to_host(&entry))
            .ok_or_else(|| format!("unknown ssh config alias: {alias}"));
    }
    if host_id.starts_with(tailscale::ID_PREFIX) {
        let user = settings.tailnet()?.default_user;
        return tailscale::resolve_peer_host(host_id, &user).await;
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

/// Adopts an ephemeral row into `hosts.toml` as an editable
/// `source = "setu"` record: an imported `~/.ssh/config` alias (F1) or a
/// tailnet peer (F9, Phase 7). The original source — config file or
/// tailnet — is never touched.
///
/// **Payload:** `{ hostId }` (an `sshcfg:` or `ts:` id) · **Result:** the
/// new persisted `Host` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the id is neither an `sshcfg:` nor a `ts:` id, the alias or
/// peer no longer exists, the copied record fails validation (e.g. an
/// `IdentityFile` missing on disk), or the store cannot be written.
#[tauri::command]
pub async fn host_adopt(
    hosts: State<'_, HostsStore>,
    settings: State<'_, SettingsStore>,
    host_id: String,
) -> Result<Host, String> {
    if host_id.starts_with(tailscale::ID_PREFIX) {
        let user = settings.tailnet()?.default_user;
        let mut host = tailscale::resolve_peer_host(&host_id, &user).await?;
        // A fresh uuid, a normal probed row: adoption promotes the peer to
        // a first-class Setu host (its MagicDNS name stays the hostname).
        host.id = String::new();
        host.source = HostSource::Setu;
        host.reachability = true;
        return match hosts.upsert(host)? {
            UpsertOutcome::Saved(host) => Ok(*host),
            UpsertOutcome::Invalid(errors) => Err(errors
                .first()
                .map(|e| format!("{}: {}", e.field, e.message))
                .unwrap_or_else(|| "validation failed".to_string())),
        };
    }
    let alias = host_id
        .strip_prefix(ssh_config::ID_PREFIX)
        .ok_or_else(|| format!("not an adoptable host: {host_id}"))?;
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

/// Result of [`snippet_upsert`] (mirrors `SnippetUpsertResult`): exactly one
/// of `snippet` (saved) or `errors` (validation failed) is populated —
/// validation failures are expected editor outcomes, not command errors.
#[derive(Debug, Serialize)]
pub struct SnippetUpsertResult {
    /// The saved record (with its assigned id), when validation passed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<Snippet>,
    /// Field-level validation failures, when it did not.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<FieldError>,
}

/// Lists every snippet in `snippets.toml`, in file order (F6).
///
/// **Payload:** none · **Result:** `Snippet[]` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when `snippets.toml` exists but cannot be read or parsed.
#[tauri::command]
pub fn snippet_list(snippets: State<'_, SnippetsStore>) -> Result<Vec<Snippet>, String> {
    snippets.list()
}

/// Creates or updates a snippet in `snippets.toml` (empty `id` = create).
///
/// **Payload:** `{ snippet }` · **Result:** `{ snippet }` on success,
/// `{ errors: [{field, message}] }` on validation failure · **Emits:**
/// nothing.
///
/// Validation (F6): label and command non-empty; every `{{token}}` in the
/// command declared in `variables` and vice versa; names
/// `[A-Za-z_][A-Za-z0-9_]*` with no duplicates; `choices` non-empty; a
/// `default` alongside `choices` must be one of them.
///
/// # Errors
///
/// Fails when the store cannot be read or written, or when a non-empty `id`
/// matches no record. Validation failures are returned in the result, not
/// as an error.
#[tauri::command]
pub fn snippet_upsert(
    snippets: State<'_, SnippetsStore>,
    snippet: Snippet,
) -> Result<SnippetUpsertResult, String> {
    Ok(match snippets.upsert(snippet)? {
        SnippetUpsertOutcome::Saved(snippet) => SnippetUpsertResult {
            snippet: Some(*snippet),
            errors: Vec::new(),
        },
        SnippetUpsertOutcome::Invalid(errors) => SnippetUpsertResult {
            snippet: None,
            errors,
        },
    })
}

/// Deletes a snippet from `snippets.toml`. Unknown ids are a no-op.
///
/// **Payload:** `{ snippetId }` · **Result:** `null` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the store cannot be read or written.
#[tauri::command]
pub fn snippet_delete(
    snippets: State<'_, SnippetsStore>,
    snippet_id: String,
) -> Result<(), String> {
    snippets.delete(&snippet_id)
}

/// Imports a snippet pack from a file the user picked in the native open
/// dialog — `[[snippet]]` TOML in the same shape as the store file.
///
/// **Payload:** `{ path, mergeStrategy: "replace" | "keep" }` ·
/// **Result:** `{ imported, skipped }` · **Emits:** nothing.
///
/// The path comes from the dialog plugin, so it always carries explicit
/// user consent; the core does the read (no fs plugin, no broad scopes).
/// Merging is by id: `"replace"` overwrites an existing record, `"keep"`
/// skips the incoming row. Pack rows without an id always import under a
/// fresh UUID. The import is atomic — a pack with any invalid snippet
/// imports nothing.
///
/// # Errors
///
/// Fails when the file cannot be read, the pack cannot be parsed, is
/// empty, contains an invalid snippet (the message names it),
/// `mergeStrategy` is unknown, or the store cannot be read or written.
#[tauri::command]
pub fn snippet_import(
    snippets: State<'_, SnippetsStore>,
    path: String,
    merge_strategy: String,
) -> Result<ImportOutcome, String> {
    let replace = match merge_strategy.as_str() {
        "replace" => true,
        "keep" => false,
        other => return Err(format!("unknown merge strategy: {other}")),
    };
    let toml_text =
        std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))?;
    snippets.import(&toml_text, replace)
}

/// Exports the given snippets as a pack file at a path the user picked in
/// the native save dialog.
///
/// **Payload:** `{ ids, path }` · **Result:** `null` · **Emits:** nothing.
///
/// The path comes from the dialog plugin (explicit user consent); the core
/// does the write. Packs hold commands and variables only — the schema has
/// no secret fields.
///
/// # Errors
///
/// Fails when the store cannot be read or parsed, no id matches (there is
/// nothing to export), or the file cannot be written. Unknown ids among
/// valid ones are ignored.
#[tauri::command]
pub fn snippet_export(
    snippets: State<'_, SnippetsStore>,
    ids: Vec<String>,
    path: String,
) -> Result<(), String> {
    let toml_text = snippets.export(&ids)?;
    std::fs::write(&path, toml_text).map_err(|e| format!("failed to write {path}: {e}"))
}

/// The error half of [`ForwardStartResult`] (mirrors the `contract.ts`
/// shape): an expected start failure with enough detail for the popover's
/// conflict helper.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStartError {
    /// `"port_in_use"` or `"spawn_failed"`.
    pub kind: &'static str,
    /// Human-readable message (names the owning process when known).
    pub message: String,
    /// The next free local port, for the "Use N" one-shot retry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_port: Option<u16>,
}

/// Result of [`forward_start`] (mirrors `ForwardStartResult`): expected
/// failures — port in use, spawn failure — ride the result, hosts-family
/// style; only infrastructure errors reject the promise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStartResult {
    /// Whether the child is (now) running.
    pub started: bool,
    /// The rule's registry key, when started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_key: Option<String>,
    /// The expected failure, when not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ForwardStartError>,
}

/// Starts a forward rule's managed `ssh -N` child (F7).
///
/// **Payload:** `{ hostId, rule: { type, spec, auto } }` · **Result:**
/// `{ started: true, ruleKey }` or `{ started: false, error: { kind,
/// message, suggestedPort? } }` · **Emits:** `forward:update` transitions
/// (`starting` → `amber` → `green`/`red`) until the child dies or is
/// stopped.
///
/// `L`/`D` rules pre-flight their local bind port: a conflict names the
/// owning process (`lsof`, 2 s budget) and suggests the next free port —
/// the F7 conflict helper. Starting an already-running rule is a no-op
/// reported as started. Children run in their own process group and die
/// with the app (no orphans).
///
/// # Errors
///
/// Fails when the host id is unknown, the store can't be read, or the
/// rule's spec is malformed (hand-edited `hosts.toml` — the editor
/// validates on save). Port conflicts and spawn failures are result-side.
#[tauri::command]
pub async fn forward_start(
    manager: State<'_, ForwardManager>,
    hosts: State<'_, HostsStore>,
    settings: State<'_, SettingsStore>,
    host_id: String,
    rule: Forward,
) -> Result<ForwardStartResult, String> {
    let host = resolve_host(&hosts, &settings, &host_id).await?;
    Ok(match manager.start(&host, &rule).await? {
        StartOutcome::Started { rule_key } | StartOutcome::AlreadyRunning { rule_key } => {
            ForwardStartResult {
                started: true,
                rule_key: Some(rule_key),
                error: None,
            }
        }
        StartOutcome::PortInUse {
            message,
            suggested_port,
        } => ForwardStartResult {
            started: false,
            rule_key: None,
            error: Some(ForwardStartError {
                kind: "port_in_use",
                message,
                suggested_port,
            }),
        },
        StartOutcome::SpawnFailed { message } => ForwardStartResult {
            started: false,
            rule_key: None,
            error: Some(ForwardStartError {
                kind: "spawn_failed",
                message,
                suggested_port: None,
            }),
        },
    })
}

/// Stops a forward rule: SIGTERMs its whole process group and ends its
/// monitor. Unknown keys are a no-op (idempotent toggle-off).
///
/// **Payload:** `{ ruleKey }` · **Result:** `null` · **Emits:** nothing
/// (the frontend drops the rule's status itself; a stop never races a
/// red — the monitor goes quiet instead).
///
/// # Errors
///
/// Never fails.
#[tauri::command]
pub fn forward_stop(manager: State<'_, ForwardManager>, rule_key: String) -> Result<(), String> {
    manager.stop(&rule_key);
    Ok(())
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

/// The needs-secret half of [`SftpConnectResult`] (mirrors
/// `SftpNeedsSecret` in `contract.ts`): the auth ladder stopped at a
/// Keychain gap the user must fill (F8). Never carries a secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpNeedsSecretPayload {
    /// `"password"` or `"passphrase"`.
    pub kind: &'static str,
    /// The key path needing a passphrase (as configured on the host),
    /// for `"passphrase"` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// One plain sentence for the prompt dialog.
    pub detail: String,
}

/// Result of [`sftp_connect`] (mirrors `SftpConnectResult`): a session id,
/// or the expected needs-secret stop — result-side, hosts-family style
/// (PLAN.md §5, Phase 7 row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectResult {
    /// Keys every later SFTP command and its transfers; absent on a
    /// needs-secret stop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sftp_session_id: Option<String>,
    /// The secret the user must store (then retry), when auth stopped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_secret: Option<SftpNeedsSecretPayload>,
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

/// Opens an SFTP session to a host (F5 + F8) — russh, with the auth ladder:
/// agent identities, the identity file (Keychain passphrase for encrypted
/// files), then the Keychain-stored SFTP password.
///
/// **Payload:** `{ hostId }` · **Result:** `{ sftpSessionId }`, or
/// `{ needsSecret: { kind, keyPath?, detail } }` when the ladder stopped at
/// a secret the Keychain doesn't hold — store it (`keychain_set`) and call
/// again · **Emits:** one `hostkey:prompt` when the host key is unknown,
/// then blocks until [`hostkey_trust`] resolves it.
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
/// exists after a failure (nor after a needs-secret stop).
#[tauri::command]
pub async fn sftp_connect(
    manager: State<'_, SftpManager>,
    hosts: State<'_, HostsStore>,
    settings: State<'_, SettingsStore>,
    host_id: String,
) -> Result<SftpConnectResult, String> {
    let host = resolve_host(&hosts, &settings, &host_id).await?;
    let target = HostTarget::from_host(&host)?;
    Ok(match manager.connect(target).await? {
        sftp::ConnectOutcome::Connected(sftp_session_id) => SftpConnectResult {
            sftp_session_id: Some(sftp_session_id),
            needs_secret: None,
        },
        sftp::ConnectOutcome::NeedsSecret { missing, detail } => {
            let (kind, key_path) = match missing {
                sftp::MissingSecret::Password => ("password", None),
                sftp::MissingSecret::Passphrase { key_path } => ("passphrase", Some(key_path)),
            };
            SftpConnectResult {
                sftp_session_id: None,
                needs_secret: Some(SftpNeedsSecretPayload {
                    kind,
                    key_path,
                    detail,
                }),
            }
        }
    })
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

/// Result of [`sftp_realpath`] (mirrors `SftpRealpathResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRealpathResult {
    /// The canonical absolute path.
    pub path: String,
}

/// Resolves a remote path to canonical absolute form (SFTP REALPATH) —
/// turns the post-connect `"."` into the home path the path bar shows.
///
/// **Payload:** `{ sftpSessionId, path }` · **Result:** `{ path }` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the session is unknown or the server refuses.
#[tauri::command]
pub async fn sftp_realpath(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    path: String,
) -> Result<SftpRealpathResult, String> {
    let session = manager.session(&sftp_session_id).await?;
    sftp::remote_realpath(&session, &path)
        .await
        .map(|path| SftpRealpathResult { path })
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

/// Starts an upload (local → remote) and returns immediately; progress
/// streams as events. The queue — concurrency 3, auto-retry ×1 on
/// retryable failures — lives in the frontend store.
///
/// **Payload:** `{ sftpSessionId, localPath, remotePath, transferId }` ·
/// **Result:** `{ transferId }` (echoed) · **Emits:** throttled
/// `sftp:progress:{transferId}` (`state: "running"`), then exactly one
/// terminal `"done"` / `"failed"` / `"cancelled"`.
///
/// `transferId` is minted by the frontend (a UUID) so its event listener
/// can be registered *before* this command flies — a localhost transfer
/// can finish in milliseconds, and a terminal event emitted before the
/// listener exists would strand the queue row as running forever.
///
/// Cancel and failure both clean up the partial remote file (best-effort).
///
/// # Errors
///
/// Fails when the session is unknown, the local file can't be read, the
/// local path is a directory (the store expands folders into per-file
/// transfers), or `transferId` is empty/already in flight. Failures
/// mid-transfer arrive as events, not command errors.
#[tauri::command]
pub async fn sftp_upload(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<SftpTransferResult, String> {
    manager
        .upload(&sftp_session_id, &local_path, &remote_path, &transfer_id)
        .await
        .map(|transfer_id| SftpTransferResult { transfer_id })
}

/// Starts a download (remote → local); see [`sftp_upload`] for the
/// event/queue contract, including the client-minted `transferId`.
/// Cleanup covers the partial local file.
///
/// **Payload:** `{ sftpSessionId, remotePath, localPath, transferId }` ·
/// **Result:** `{ transferId }` (echoed) · **Emits:** as [`sftp_upload`].
///
/// # Errors
///
/// Fails when the session is unknown, the remote path can't be statted,
/// it is a directory, or `transferId` is empty/already in flight.
#[tauri::command]
pub async fn sftp_download(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<SftpTransferResult, String> {
    manager
        .download(&sftp_session_id, &remote_path, &local_path, &transfer_id)
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

/// Which kind of Keychain secret a `keychain_*` command addresses (mirrors
/// the `kind` discriminant of `KeychainSecretRef` in `contract.ts`).
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeychainSecretKind {
    /// A host's SFTP password — addressed by `hostId`.
    Password,
    /// A private key's passphrase — addressed by `keyPath`.
    Passphrase,
}

/// Result of [`keychain_has`] (mirrors `KeychainHasResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeychainHasResult {
    /// Whether an entry exists at the address.
    pub exists: bool,
}

/// Builds the [`keychain::SecretRef`] a command addresses, checking that
/// the field matching `kind` is present and non-empty.
fn keychain_ref(
    kind: KeychainSecretKind,
    host_id: Option<String>,
    key_path: Option<String>,
) -> Result<keychain::SecretRef, String> {
    match kind {
        KeychainSecretKind::Password => host_id
            .filter(|id| !id.is_empty())
            .map(|host_id| keychain::SecretRef::Password { host_id })
            .ok_or_else(|| "hostId is required for password secrets".to_string()),
        KeychainSecretKind::Passphrase => key_path
            .filter(|path| !path.is_empty())
            .map(|key_path| keychain::SecretRef::Passphrase { key_path })
            .ok_or_else(|| "keyPath is required for passphrase secrets".to_string()),
    }
}

/// Stores (or replaces) a secret in the macOS Keychain under the service
/// `dev.pandox.setu` (F8). Write-only by design: no command ever returns a
/// stored secret, and the secret is never logged (PLAN.md §5, Phase 7 row).
///
/// **Payload:** `{ kind, hostId? | keyPath?, secret }` · **Result:** `null`
/// · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the address field matching `kind` is missing or empty, or
/// when the Keychain refuses the write (locked keychain, denied
/// authorization).
#[tauri::command]
pub fn keychain_set(
    kind: KeychainSecretKind,
    host_id: Option<String>,
    key_path: Option<String>,
    secret: String,
) -> Result<(), String> {
    keychain::set(&keychain_ref(kind, host_id, key_path)?, &secret)
}

/// Deletes a Keychain secret. Missing entries are a no-op (idempotent
/// delete, F8).
///
/// **Payload:** `{ kind, hostId? | keyPath? }` · **Result:** `null` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the address field matching `kind` is missing or empty, or
/// when the Keychain refuses the delete for a reason other than a missing
/// entry.
#[tauri::command]
pub fn keychain_delete(
    kind: KeychainSecretKind,
    host_id: Option<String>,
    key_path: Option<String>,
) -> Result<(), String> {
    keychain::delete(&keychain_ref(kind, host_id, key_path)?)
}

/// Reports whether a Keychain entry exists — existence only; the secret
/// itself stays inside the Rust core (F8; reads happen only in the SFTP
/// auth ladder).
///
/// **Payload:** `{ kind, hostId? | keyPath? }` · **Result:** `{ exists }` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Fails when the address field matching `kind` is missing or empty, or
/// when the Keychain cannot be queried at all.
#[tauri::command]
pub fn keychain_has(
    kind: KeychainSecretKind,
    host_id: Option<String>,
    key_path: Option<String>,
) -> Result<KeychainHasResult, String> {
    Ok(KeychainHasResult {
        exists: keychain::has(&keychain_ref(kind, host_id, key_path)?)?,
    })
}

/// The expected-refusal half of [`KeysGenerateResult`] (mirrors
/// `KeysGenerateError`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysGenerateError {
    /// `"file_exists"` or `"no_parent"`.
    pub kind: &'static str,
    /// One plain sentence naming the path.
    pub message: String,
}

/// Result of [`keys_generate`] (mirrors `KeysGenerateResult`): the public
/// key on success, an expected refusal otherwise — hosts-family style.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeysGenerateResult {
    /// The new `.pub` line, for the clipboard and ssh-copy-id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    /// The expected refusal, when nothing was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<KeysGenerateError>,
}

/// Generates an ed25519 keypair with `ssh-keygen` (F8). A non-empty
/// passphrase is typed into ssh-keygen's prompts through a hidden PTY —
/// never argv — and then stored in the Keychain (`passphrase:{path}`) so
/// SFTP can use the key immediately.
///
/// **Payload:** `{ path, passphrase?, comment? }` · **Result:**
/// `{ publicKey }` or `{ error: { kind: "file_exists" | "no_parent",
/// message } }` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when ssh-keygen can't run, exits non-zero, or stalls; and when
/// the key was generated but its passphrase couldn't be stored (the error
/// says so — the key file exists at that point).
#[tauri::command]
pub fn keys_generate(
    path: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<KeysGenerateResult, String> {
    let passphrase = passphrase.unwrap_or_default();
    let comment = comment.unwrap_or_default();
    match keygen::generate(&path, &passphrase, &comment)? {
        keygen::GenOutcome::Generated { public_key } => {
            if !passphrase.is_empty() {
                keychain::set(
                    &keychain::SecretRef::Passphrase {
                        key_path: path.clone(),
                    },
                    &passphrase,
                )
                .map_err(|e| {
                    format!("the key was generated, but storing its passphrase failed: {e}")
                })?;
            }
            Ok(KeysGenerateResult {
                public_key: Some(public_key),
                error: None,
            })
        }
        keygen::GenOutcome::Refused { kind, message } => Ok(KeysGenerateResult {
            public_key: None,
            error: Some(KeysGenerateError { kind, message }),
        }),
    }
}

/// One agent identity in [`AgentListResult`] (mirrors `AgentKey`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentKeyPayload {
    /// Key algorithm, e.g. `"ED25519"` or `"ED25519-SK"`.
    pub algorithm: String,
    /// OpenSSH `SHA256:<base64>` fingerprint.
    pub fingerprint: String,
    /// The key's comment (usually a path or `user@host`).
    pub comment: String,
}

/// Result of [`agent_list`] (mirrors `AgentListResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentListResult {
    /// Whether an ssh-agent is reachable at all.
    pub available: bool,
    /// Loaded identities (empty is normal for a fresh agent).
    pub keys: Vec<AgentKeyPayload>,
    /// One plain sentence for the guidance banner, when something's off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Result of [`binary_check`] (mirrors `BinaryCheckResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryCheckResult {
    /// Whether the tool is installed (on `PATH` or a well-known location).
    pub found: bool,
    /// The resolved absolute path, when found.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Reports whether an optional system tool is installed (Phase 7) — the
/// mosh preflight, tailscale detection, and Phase 13's `claude` check all
/// share it (PLAN.md §5 row). Names are allow-listed so the command never
/// becomes an arbitrary-path oracle.
///
/// **Payload:** `{ name }` · **Result:** `{ found, path? }` · **Emits:**
/// nothing.
///
/// # Errors
///
/// Fails when `name` isn't on the allow-list (`mosh`, `tailscale`,
/// `claude`).
#[tauri::command]
pub fn binary_check(name: String) -> Result<BinaryCheckResult, String> {
    const ALLOWED: [&str; 3] = ["mosh", "tailscale", "claude"];
    if !ALLOWED.contains(&name.as_str()) {
        return Err(format!("unknown binary: {name}"));
    }
    Ok(match binaries::find(&name) {
        Some(path) => BinaryCheckResult {
            found: true,
            path: Some(path.display().to_string()),
        },
        None => BinaryCheckResult {
            found: false,
            path: None,
        },
    })
}

/// One tailnet peer in [`TailscalePeersResult`] (mirrors `TailscalePeer`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeerPayload {
    /// Stable host id (`ts:{nodeId}`) — feeds `pty_spawn`, `sftp_connect`,
    /// and `host_adopt` like any other host id.
    pub id: String,
    /// MagicDNS name without the trailing dot.
    pub dns_name: String,
    /// The device's short hostname (the row label).
    pub host_name: String,
    /// OS as Tailscale reports it (`linux`, `macOS`, `windows`, …).
    pub os: String,
    /// Tailscale's own online state — the LED, never a probe (§3).
    pub online: bool,
    /// RFC 3339 last-seen for dimmed offline rows, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    /// ACL tags (`tag:prod`, …).
    pub tags: Vec<String>,
    /// Whether the peer runs Tailscale SSH (the key-free `ts-ssh` badge).
    pub ts_ssh: bool,
}

/// Result of [`tailscale_peers`] (mirrors `TailscalePeersResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeersResult {
    /// Whether the Tailnet section should exist at all.
    pub available: bool,
    /// One plain sentence when unavailable (`"not installed"`,
    /// `"logged out"`, `"stopped"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The default login user for one-click connects.
    pub default_user: String,
    /// Live peers, self excluded.
    pub peers: Vec<TailscalePeerPayload>,
}

/// Lists tailnet peers via `tailscale status --json` (F9). Pull model:
/// the frontend polls every 30 s and pauses while hidden — peers are
/// ephemeral and never persisted. Peer LEDs mirror Tailscale's own online
/// state; these rows are never TCP-probed (§3).
///
/// **Payload:** `{}` · **Result:** `{ available, reason?, defaultUser,
/// peers }` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when settings can't be read or the command can't run at all. An
/// absent binary or a stopped/logged-out daemon is `{ available: false,
/// reason }` — the section hides, nothing errors (F9 edge case).
#[tauri::command]
pub async fn tailscale_peers(
    settings: State<'_, SettingsStore>,
) -> Result<TailscalePeersResult, String> {
    let user = settings.tailnet()?.default_user;
    let status = tailscale::status(&user).await?;
    Ok(TailscalePeersResult {
        available: status.available,
        reason: status.reason,
        default_user: status.default_user,
        peers: status
            .peers
            .into_iter()
            .map(|peer| TailscalePeerPayload {
                id: peer.id,
                dns_name: peer.dns_name,
                host_name: peer.host_name,
                os: peer.os,
                online: peer.online,
                last_seen: peer.last_seen,
                tags: peer.tags,
                ts_ssh: peer.ts_ssh,
            })
            .collect(),
    })
}

/// Result of [`tailscale_ping`] (mirrors `TailscalePingResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePingResult {
    /// Whether the ping got a pong within the budget.
    pub ok: bool,
    /// The command's last output line — `"pong from … in 23ms"` or the
    /// failure text, for the toast.
    pub summary: String,
}

/// Runs `tailscale ping` against a peer (F9's "ping to wake path"): warms
/// the connection path to a dozing peer. Background execution with a
/// toast — no pane involved.
///
/// **Payload:** `{ target }` (MagicDNS name) · **Result:** `{ ok,
/// summary }` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when tailscale isn't installed or the command can't run; an
/// unreachable peer is `{ ok: false, summary }`, not an error.
#[tauri::command]
pub async fn tailscale_ping(target: String) -> Result<TailscalePingResult, String> {
    let binary =
        binaries::find("tailscale").ok_or("tailscale isn't installed — nothing to ping with")?;
    let output = tokio::process::Command::new(&binary)
        .args(["ping", "-c", "3", "--timeout", "2s", &target])
        .output()
        .await
        .map_err(|e| format!("couldn't run tailscale ping: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let summary = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("no response")
        .trim()
        .to_string();
    Ok(TailscalePingResult {
        ok: output.status.success(),
        summary,
    })
}

/// Result of [`vault_export`] (mirrors `VaultExportResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultExportResult {
    /// Size of the encrypted vault file, in bytes.
    pub bytes: u64,
    /// How many Keychain entries rode along (0 unless the explicit
    /// include-secrets toggle was on).
    pub secrets_included: usize,
}

/// Collects the known Keychain entries for an include-secrets export:
/// every persisted host's SFTP password, plus the passphrase of every
/// configured identity file. Only called behind the explicit toggle.
fn collect_secret_entries(hosts: &HostsStore) -> Result<Vec<vault::SecretEntry>, String> {
    let mut entries = Vec::new();
    let mut seen_paths = std::collections::BTreeSet::new();
    for host in hosts.list()? {
        let reference = keychain::SecretRef::Password {
            host_id: host.id.clone(),
        };
        if let Some(secret) = keychain::get(&reference)? {
            entries.push(vault::SecretEntry {
                account: reference.account(),
                secret,
            });
        }
        let identity = host.identity.trim();
        if identity != "agent" && !identity.is_empty() && seen_paths.insert(identity.to_string()) {
            let reference = keychain::SecretRef::Passphrase {
                key_path: identity.to_string(),
            };
            if let Some(secret) = keychain::get(&reference)? {
                entries.push(vault::SecretEntry {
                    account: reference.account(),
                    secret,
                });
            }
        }
    }
    Ok(entries)
}

/// Exports the config dir (`~/.config/setu`) as an age-encrypted tarball
/// (F8): `age -d vault.tar.age | tar -x` restores it anywhere. Secrets
/// are **excluded by default**; `includeSecrets` — the second, explicit
/// toggle — bundles the known Keychain entries inside the encrypted
/// stream as `keychain-secrets.toml`. The passphrase crosses IPC one way
/// and is never stored or logged.
///
/// **Payload:** `{ destPath, passphrase, includeSecrets }` · **Result:**
/// `{ bytes, secretsIncluded }` · **Emits:** nothing.
///
/// # Errors
///
/// Fails when the passphrase is empty, the config dir doesn't exist, the
/// Keychain refuses a read (include-secrets only), or any IO/encryption
/// step fails — a partial destination file is removed.
#[tauri::command]
pub async fn vault_export(
    hosts: State<'_, HostsStore>,
    dest_path: String,
    passphrase: String,
    include_secrets: bool,
) -> Result<VaultExportResult, String> {
    let config_dir = dirs::home_dir()
        .ok_or("cannot determine home directory")?
        .join(".config/setu");
    let secrets = if include_secrets {
        Some(collect_secret_entries(&hosts)?)
    } else {
        None
    };
    let secrets_included = secrets.as_ref().map(Vec::len).unwrap_or(0);
    // scrypt is deliberately slow — run the whole export off the async
    // pool so a vault never stalls other commands.
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        vault::export(
            &config_dir,
            std::path::Path::new(&dest_path),
            &passphrase,
            secrets,
        )
    })
    .await
    .map_err(|e| format!("the export task died: {e}"))??;
    Ok(VaultExportResult {
        bytes,
        secrets_included,
    })
}

/// Lists the ssh-agent's identities via `ssh-add -l` (F8) — fingerprints
/// and comments for the Keys panel. Read-only: Setu never adds or removes
/// agent identities.
///
/// **Payload:** `{}` · **Result:** `{ available, keys, note? }` ·
/// **Emits:** nothing.
///
/// # Errors
///
/// Never fails — an absent or unreachable agent comes back as
/// `{ available: false, note }` (the F8 guidance banner), not an error.
#[tauri::command]
pub fn agent_list() -> Result<AgentListResult, String> {
    let status = agent::list();
    Ok(AgentListResult {
        available: status.available,
        keys: status
            .keys
            .into_iter()
            .map(|key| AgentKeyPayload {
                algorithm: key.algorithm,
                fingerprint: key.fingerprint,
                comment: key.comment,
            })
            .collect(),
        note: status.note,
    })
}
