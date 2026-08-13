//! The in-app SFTP client (F5): connections, host-key trust, and sessions.
//!
//! This is the **only** place Setu speaks the SSH protocol itself (PLAN.md
//! §5): a file browser needs structured directory data, which a PTY driving
//! system `ssh` can't provide. Interactive terminals stay on system `ssh`.
//!
//! The connect pipeline, in order:
//!
//! 1. TCP + SSH handshake via russh; the server's key is checked against
//!    `~/.ssh/known_hosts` ([`crate::known_hosts`]).
//! 2. A **match** proceeds silently. A **mismatch** or **revoked** key fails
//!    the connect with an error naming both fingerprints — never a prompt
//!    (CLAUDE.md hard rules). An **unknown** key emits one
//!    [`SftpEvents::on_hostkey_prompt`] and parks the handshake on a oneshot
//!    until [`SftpManager::resolve_trust`] delivers the user's decision from
//!    the FingerprintDialog; trusting appends to `known_hosts`, declining
//!    fails the connect.
//! 3. Auth ladder (PLAN.md §10 Phase 5): every ssh-agent identity first,
//!    then the host's identity file when one is configured. Password auth
//!    arrives with the Keychain in Phase 7.
//! 4. The `sftp` subsystem opens and the session joins the manager's map,
//!    keyed by a fresh `sftpSessionId`.
//!
//! Sessions are closed by [`SftpManager::disconnect`] (panel close), and
//! [`SftpManager::kill_all`] sweeps everything on app exit — no orphaned
//! connections (CLAUDE.md). File contents and paths never reach logs.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::{load_secret_key, HashAlg, PublicKey};
use tokio::sync::oneshot;

use crate::known_hosts::{self, KeyCheck};
use crate::store::{expand_tilde, Host};

/// Sink for everything the SFTP layer reports to the frontend. The Tauri
/// bridge (`ipc.rs`) forwards these as events; tests substitute a recorder.
pub trait SftpEvents: Send + Sync + 'static {
    /// An unknown host key needs a user verdict: show the FingerprintDialog.
    /// `fingerprint` is OpenSSH-format `SHA256:<base64>`.
    fn on_hostkey_prompt(
        &self,
        host_id: &str,
        host_label: &str,
        algorithm: &str,
        fingerprint: &str,
    );
    /// A transfer moved: `bytes` of `total` are done (throttled upstream).
    fn on_progress(&self, transfer_id: &str, bytes: u64, total: u64);
    /// A transfer finished successfully.
    fn on_done(&self, transfer_id: &str, bytes: u64, total: u64);
    /// A transfer failed. `retryable` marks transient causes (dropped
    /// connection, timeout) the frontend may auto-retry once (F5).
    fn on_failed(&self, transfer_id: &str, error: &str, retryable: bool);
    /// A transfer was cancelled by the user; partial output is cleaned up.
    fn on_cancelled(&self, transfer_id: &str);
}

/// The connection facts the SFTP layer needs from a [`Host`] record.
///
/// Derived in the IPC layer via [`HostTarget::from_host`] so the manager
/// never touches the store directly (mirrors how the prober consumes hosts).
#[derive(Debug, Clone)]
pub struct HostTarget {
    /// The host's stable id — keys the `hostkey:prompt` flow.
    pub host_id: String,
    /// Display label for prompts and errors.
    pub label: String,
    /// Hostname or IP to dial.
    pub hostname: String,
    /// Login user; already defaulted to the local user when empty.
    pub user: String,
    /// SSH port.
    pub port: u16,
    /// `"agent"` or a path to a private key file.
    pub identity: String,
}

impl HostTarget {
    /// Builds a target from a host record, defaulting an empty user to the
    /// local `$USER` (russh has no `~/.ssh/config` to fall back on).
    ///
    /// # Errors
    ///
    /// Fails when the record has no hostname (alias-only `~/.ssh/config`
    /// imports): russh dials addresses, not aliases — such hosts must be
    /// adopted and given a hostname first.
    pub fn from_host(host: &Host) -> Result<Self, String> {
        if host.hostname.trim().is_empty() {
            return Err(format!(
                "\"{}\" has no hostname — SFTP needs one (adopt the host and set it)",
                host.label
            ));
        }
        let user = if host.user.trim().is_empty() {
            std::env::var("USER").unwrap_or_else(|_| "root".into())
        } else {
            host.user.clone()
        };
        Ok(Self {
            host_id: host.id.clone(),
            label: host.label.clone(),
            hostname: host.hostname.clone(),
            user,
            port: host.port,
            identity: host.identity.clone(),
        })
    }
}

/// One live SFTP connection.
struct SftpConn {
    /// The high-level SFTP session (shared with transfer tasks).
    sftp: Arc<russh_sftp::client::SftpSession>,
    /// The underlying SSH connection, kept for a clean disconnect.
    handle: Handle<ClientHandler>,
    /// Connection facts, for error messages and the Cyberduck handoff.
    target: HostTarget,
}

/// Owner of every SFTP connection and pending trust prompt.
///
/// Managed as Tauri state; all methods take `&self` (interior mutability)
/// so commands can share it. Connection ops `await`, so the map lives in a
/// tokio mutex; the prompt registry is sync (no awaits under lock).
pub struct SftpManager {
    /// Event sink (the Tauri bridge in production).
    events: Arc<dyn SftpEvents>,
    /// Live connections keyed by `sftpSessionId`.
    conns: tokio::sync::Mutex<HashMap<String, SftpConn>>,
    /// One pending host-key decision per host id.
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// Running transfers keyed by `transferId` ([`SftpManager::cancel`]).
    transfers: Arc<Mutex<HashMap<String, TransferEntry>>>,
}

/// Bookkeeping for one running transfer task.
struct TransferEntry {
    /// Cooperative cancellation signal, checked between chunks.
    token: tokio_util::sync::CancellationToken,
    /// The connection this transfer rides, so disconnects cancel it.
    sftp_session_id: String,
}

impl SftpManager {
    /// Creates a manager reporting through `events`.
    pub fn new(events: Arc<dyn SftpEvents>) -> Self {
        Self {
            events,
            conns: tokio::sync::Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            transfers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Connects to `target` and returns the new `sftpSessionId`.
    ///
    /// Blocks through the whole pipeline described in the module docs —
    /// including, for unknown keys, the user's FingerprintDialog decision.
    ///
    /// # Errors
    ///
    /// Fails on unreachable hosts, refused/mismatched/revoked/declined host
    /// keys, exhausted auth methods, and subsystem failures. No session is
    /// registered on failure.
    pub async fn connect(&self, target: HostTarget) -> Result<String, String> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..client::Config::default()
        });
        let handler = ClientHandler {
            target: target.clone(),
            events: Arc::clone(&self.events),
            pending: Arc::clone(&self.pending),
            refusal: Arc::new(Mutex::new(None)),
        };
        let refusal = Arc::clone(&handler.refusal);

        let addr = (target.hostname.as_str(), target.port);
        let mut handle = client::connect(config, addr, handler).await.map_err(|e| {
            // A refusal recorded by check_server_key explains the generic
            // russh error precisely — prefer it.
            match refusal.lock().expect("refusal lock").take() {
                Some(reason) => reason,
                None => format!(
                    "couldn't connect to {}:{}: {e}",
                    target.hostname, target.port
                ),
            }
        })?;

        authenticate(&mut handle, &target).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("couldn't open an SSH channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("couldn't start the sftp subsystem: {e}"))?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("couldn't initialize sftp: {e}"))?;

        let id = uuid::Uuid::new_v4().to_string();
        self.conns.lock().await.insert(
            id.clone(),
            SftpConn {
                sftp: Arc::new(sftp),
                handle,
                target,
            },
        );
        Ok(id)
    }

    /// Delivers the user's FingerprintDialog verdict for `host_id` to the
    /// handshake parked in `connect`.
    ///
    /// # Errors
    ///
    /// Fails when no prompt is pending for the host (it already resolved,
    /// or the connect died while the dialog was open).
    pub fn resolve_trust(&self, host_id: &str, accept: bool) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .expect("pending lock")
            .remove(host_id)
            .ok_or_else(|| format!("no pending host-key prompt for {host_id}"))?;
        // A dropped receiver means the connect already failed; the frontend
        // learns that from the connect error itself.
        let _ = sender.send(accept);
        Ok(())
    }

    /// The SFTP session for `id`, shared for concurrent ops and transfers.
    ///
    /// # Errors
    ///
    /// Fails when the id is unknown (never connected, or disconnected).
    pub async fn session(&self, id: &str) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        self.conns
            .lock()
            .await
            .get(id)
            .map(|conn| Arc::clone(&conn.sftp))
            .ok_or_else(|| "not connected — reopen the SFTP panel".to_string())
    }

    /// The connection facts for `id` (Cyberduck handoff, error copy).
    ///
    /// # Errors
    ///
    /// Fails when the id is unknown.
    pub async fn target(&self, id: &str) -> Result<HostTarget, String> {
        self.conns
            .lock()
            .await
            .get(id)
            .map(|conn| conn.target.clone())
            .ok_or_else(|| "not connected — reopen the SFTP panel".to_string())
    }

    /// Closes the session `id`. Unknown ids are a no-op (idempotent close,
    /// same contract as `pty_kill`). Transfers riding the connection are
    /// cancelled first; their partial-file cleanup is best-effort — the
    /// link they'd clean over is going away.
    pub async fn disconnect(&self, id: &str) {
        self.cancel_transfers(|entry| entry.sftp_session_id == id);
        let conn = self.conns.lock().await.remove(id);
        if let Some(conn) = conn {
            close_conn(conn).await;
        }
    }

    /// Closes every session — the app-exit sweep (CLAUDE.md: no orphans).
    pub async fn kill_all(&self) {
        self.cancel_transfers(|_| true);
        let conns: Vec<SftpConn> = self.conns.lock().await.drain().map(|(_, c)| c).collect();
        for conn in conns {
            close_conn(conn).await;
        }
    }

    /// Starts an upload and returns its `transferId`. The transfer runs as
    /// its own task; the queue (concurrency 3, auto-retry ×1) lives in the
    /// frontend store, which starts at most three of these at once.
    ///
    /// # Errors
    ///
    /// Fails when the session is unknown or the local file can't be
    /// opened/statted. Failures *during* the transfer arrive as
    /// [`SftpEvents::on_failed`] instead.
    pub async fn upload(
        &self,
        sftp_session_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<String, String> {
        let sftp = self.session(sftp_session_id).await?;
        let meta = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| format!("{local_path}: {e}"))?;
        if meta.is_dir() {
            // Folder uploads arrive with drag-drop batches in the store —
            // each file is its own transfer; the backend moves files.
            return Err(format!("{local_path} is a directory — upload its files"));
        }
        let total = meta.len();
        let (transfer_id, token) = self.register_transfer(sftp_session_id);
        let events = Arc::clone(&self.events);
        let transfers = Arc::clone(&self.transfers);
        let (id, local, remote) = (
            transfer_id.clone(),
            local_path.to_string(),
            remote_path.to_string(),
        );
        tokio::spawn(async move {
            let outcome = stream_upload(&sftp, &local, &remote, total, &token, &*events, &id).await;
            transfers.lock().expect("transfers lock").remove(&id);
            match outcome {
                Ok(bytes) => events.on_done(&id, bytes, total),
                Err(TransferHalt::Cancelled) => {
                    let _ = sftp.remove_file(&remote).await;
                    events.on_cancelled(&id);
                }
                Err(TransferHalt::Failed { message, retryable }) => {
                    let _ = sftp.remove_file(&remote).await;
                    events.on_failed(&id, &message, retryable);
                }
            }
        });
        Ok(transfer_id)
    }

    /// Starts a download and returns its `transferId` (see [`Self::upload`]
    /// for the task/queue split).
    ///
    /// # Errors
    ///
    /// Fails when the session is unknown or the remote path can't be
    /// statted. Failures *during* the transfer arrive as
    /// [`SftpEvents::on_failed`] instead.
    pub async fn download(
        &self,
        sftp_session_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<String, String> {
        let sftp = self.session(sftp_session_id).await?;
        let meta = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err(format!("{remote_path} is a directory — download its files"));
        }
        let total = meta.size.unwrap_or(0);
        let (transfer_id, token) = self.register_transfer(sftp_session_id);
        let events = Arc::clone(&self.events);
        let transfers = Arc::clone(&self.transfers);
        let (id, local, remote) = (
            transfer_id.clone(),
            local_path.to_string(),
            remote_path.to_string(),
        );
        tokio::spawn(async move {
            let outcome =
                stream_download(&sftp, &remote, &local, total, &token, &*events, &id).await;
            transfers.lock().expect("transfers lock").remove(&id);
            match outcome {
                Ok(bytes) => events.on_done(&id, bytes, total),
                Err(TransferHalt::Cancelled) => {
                    let _ = tokio::fs::remove_file(&local).await;
                    events.on_cancelled(&id);
                }
                Err(TransferHalt::Failed { message, retryable }) => {
                    let _ = tokio::fs::remove_file(&local).await;
                    events.on_failed(&id, &message, retryable);
                }
            }
        });
        Ok(transfer_id)
    }

    /// Cancels a running transfer. Unknown ids are a no-op: cancelling
    /// something that just finished must never race into an error.
    pub fn cancel(&self, transfer_id: &str) {
        if let Some(entry) = self
            .transfers
            .lock()
            .expect("transfers lock")
            .get(transfer_id)
        {
            entry.token.cancel();
        }
    }

    /// Mints a transfer id and registers its cancellation token.
    fn register_transfer(
        &self,
        sftp_session_id: &str,
    ) -> (String, tokio_util::sync::CancellationToken) {
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let token = tokio_util::sync::CancellationToken::new();
        self.transfers.lock().expect("transfers lock").insert(
            transfer_id.clone(),
            TransferEntry {
                token: token.clone(),
                sftp_session_id: sftp_session_id.to_string(),
            },
        );
        (transfer_id, token)
    }

    /// Cancels every transfer matching `pick` (session teardown paths).
    fn cancel_transfers(&self, pick: impl Fn(&TransferEntry) -> bool) {
        for entry in self.transfers.lock().expect("transfers lock").values() {
            if pick(entry) {
                entry.token.cancel();
            }
        }
    }
}

/// Politely closes one connection; errors are ignored (the process is
/// closing the socket either way, and there is nothing to report to).
async fn close_conn(conn: SftpConn) {
    let _ = conn.sftp.close().await;
    let _ = conn
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
}

/// Runs the Phase 5 auth ladder: every agent identity, then the configured
/// identity file. Returns the first success.
async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    target: &HostTarget,
) -> Result<(), String> {
    let mut notes: Vec<String> = Vec::new();

    // Rung 1 — the ssh-agent, when one is reachable.
    if std::env::var_os("SSH_AUTH_SOCK").is_some() {
        match AgentClient::connect_env().await {
            Ok(mut agent) => match agent.request_identities().await {
                Ok(identities) if !identities.is_empty() => {
                    let rsa_hash = best_rsa_hash(handle).await;
                    for identity in identities {
                        // Plain keys only in v1; agent-held certificates are
                        // out of Phase 5 scope.
                        let AgentIdentity::PublicKey { key, .. } = identity else {
                            continue;
                        };
                        let hash = rsa_hash_for(&key, rsa_hash);
                        match handle
                            .authenticate_publickey_with(&target.user, key, hash, &mut agent)
                            .await
                        {
                            Ok(result) if result.success() => return Ok(()),
                            Ok(_) => {}
                            Err(e) => notes.push(format!("agent signing failed: {e}")),
                        }
                    }
                    notes.push("no agent identity was accepted".into());
                }
                Ok(_) => notes.push("the ssh-agent holds no identities".into()),
                Err(e) => notes.push(format!("couldn't list agent identities: {e}")),
            },
            Err(e) => notes.push(format!("couldn't reach the ssh-agent: {e}")),
        }
    } else {
        notes.push("no ssh-agent (SSH_AUTH_SOCK unset)".into());
    }

    // Rung 2 — the configured identity file.
    let identity = target.identity.trim();
    if identity != "agent" && !identity.is_empty() {
        let path = expand_tilde(identity);
        match load_secret_key(&path, None) {
            Ok(key) => {
                let hash = if key.algorithm().is_rsa() {
                    best_rsa_hash(handle).await
                } else {
                    None
                };
                match handle
                    .authenticate_publickey(
                        &target.user,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                {
                    Ok(result) if result.success() => return Ok(()),
                    Ok(_) => notes.push(format!("key {} was not accepted", path.display())),
                    Err(e) => notes.push(format!("key auth failed: {e}")),
                }
            }
            // Passphrase-protected files need the Keychain (Phase 7); the
            // error from an encrypted key says so on its own.
            Err(e) => notes.push(format!("couldn't load {}: {e}", path.display())),
        }
    }

    Err(format!(
        "authentication to {} failed — {}",
        target.label,
        notes.join("; ")
    ))
}

/// The server's preferred RSA signature hash, when it advertises one.
async fn best_rsa_hash(handle: &Handle<ClientHandler>) -> Option<HashAlg> {
    handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten()
}

/// `hash` for RSA keys, `None` otherwise (non-RSA algorithms ignore it, and
/// passing one would mislabel the agent signing request).
fn rsa_hash_for(key: &PublicKey, hash: Option<HashAlg>) -> Option<HashAlg> {
    if key.algorithm().is_rsa() {
        hash
    } else {
        None
    }
}

/// russh connection handler: its single job is the host-key verdict.
struct ClientHandler {
    /// Who we think we're talking to.
    target: HostTarget,
    /// Prompt sink for unknown keys.
    events: Arc<dyn SftpEvents>,
    /// The manager's prompt registry ([`SftpManager::resolve_trust`] side).
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    /// Why the key was refused, for a precise connect error: russh only
    /// reports a generic "unknown key" when we return `Ok(false)`.
    refusal: Arc<Mutex<Option<String>>>,
}

impl ClientHandler {
    /// Records the reason a key is being refused and returns `Ok(false)`.
    fn refuse(&self, reason: String) -> Result<bool, russh::Error> {
        *self.refusal.lock().expect("refusal lock") = Some(reason);
        Ok(false)
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = known_hosts::sha256_fingerprint(key);
        let path = known_hosts_path();
        let verdict = match known_hosts::check_key_file(
            &path,
            &self.target.hostname,
            self.target.port,
            key,
        ) {
            Ok(verdict) => verdict,
            Err(e) => return self.refuse(e),
        };

        match verdict {
            KeyCheck::Match => Ok(true),
            KeyCheck::Revoked => self.refuse(format!(
                "the host key for {} ({fingerprint}) is marked @revoked in known_hosts — refusing to connect",
                self.target.label
            )),
            KeyCheck::Mismatch { stored_fingerprint } => self.refuse(format!(
                "HOST KEY CHANGED for {}: known_hosts has {stored_fingerprint}, the server sent {fingerprint}. \
                 If the server was reinstalled, remove its old line from ~/.ssh/known_hosts and reconnect.",
                self.target.label
            )),
            KeyCheck::Unknown => {
                let (tx, rx) = oneshot::channel();
                {
                    let mut pending = self.pending.lock().expect("pending lock");
                    if pending.contains_key(&self.target.host_id) {
                        drop(pending);
                        return self.refuse(format!(
                            "a host-key prompt for {} is already open",
                            self.target.label
                        ));
                    }
                    pending.insert(self.target.host_id.clone(), tx);
                }
                self.events.on_hostkey_prompt(
                    &self.target.host_id,
                    &self.target.label,
                    key.algorithm().as_str(),
                    &fingerprint,
                );
                match rx.await {
                    Ok(true) => match known_hosts::append_trusted(
                        &path,
                        &self.target.hostname,
                        self.target.port,
                        key,
                    ) {
                        Ok(()) => Ok(true),
                        Err(e) => self.refuse(format!("couldn't record the trusted key: {e}")),
                    },
                    Ok(false) | Err(_) => {
                        // Declined, or the prompt was torn down.
                        self.pending
                            .lock()
                            .expect("pending lock")
                            .remove(&self.target.host_id);
                        self.refuse(format!("host key for {} was not trusted", self.target.label))
                    }
                }
            }
        }
    }
}

/// `~/.ssh/known_hosts` — the same trust store system ssh uses.
fn known_hosts_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".ssh")
        .join("known_hosts")
}

// ---------------------------------------------------------------------------
// Listings and file ops (F5): the same entry shape on both panes — remote
// via russh-sftp, local via std::fs.
// ---------------------------------------------------------------------------

/// One row in a pane listing (mirrors `SftpEntry` in `contract.ts`).
///
/// The shape is identical for both panes so every downstream consumer —
/// sorting, columns, drag payloads — is pane-agnostic. For symlinks the
/// entry describes the **link itself** (`is_dir: false`); `link_target`
/// carries the raw target for display, and following happens explicitly
/// via a `stat` on double-click (F5).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// File name (final path component), UTF-8.
    pub name: String,
    /// Size in bytes; `0` for directories and when the server omits it.
    pub size: u64,
    /// Modification time in epoch milliseconds; `0` when unknown.
    pub mtime_ms: u64,
    /// Unix permission bits (lower 12 bits: `rwxrwxrwx` + setuid/setgid/sticky).
    pub mode: u32,
    /// Whether the entry is a directory (never true for symlinks).
    pub is_dir: bool,
    /// Whether the entry is a symbolic link.
    pub is_symlink: bool,
    /// The symlink's raw target, when the entry is one and it was readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

/// Permission-and-type bits mask kept in [`SftpEntry::mode`].
const MODE_BITS: u32 = 0o7777;

/// POSIX path join for **remote** paths (which are `/`-separated strings,
/// never `std::path` on this side): absolute children replace, everything
/// else appends with exactly one separator.
pub fn remote_join(dir: &str, name: &str) -> String {
    if name.starts_with('/') {
        return name.to_string();
    }
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Lists a remote directory: one `read_dir` round-trip, plus one
/// `read_link` per symlink for its target (targets aren't in the READDIR
/// reply). Entries come back name-sorted for deterministic pagination-free
/// rendering; the frontend re-sorts per its own column state.
///
/// # Errors
///
/// Surfaces the server's error verbatim (permission denied included, F5).
pub async fn remote_list(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<Vec<SftpEntry>, String> {
    let dir = sftp.read_dir(path).await.map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for item in dir {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = item.metadata();
        let is_symlink = meta.is_symlink();
        let link_target = if is_symlink {
            sftp.read_link(remote_join(path, &name)).await.ok()
        } else {
            None
        };
        entries.push(entry_from_remote(name, &meta, link_target));
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

/// Stats a remote path, **following** symlinks — the explicit follow half
/// of the F5 symlink behavior (list never follows).
///
/// # Errors
///
/// Surfaces the server's error verbatim (broken links stat as errors).
pub async fn remote_stat(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<SftpEntry, String> {
    let meta = sftp.metadata(path).await.map_err(|e| e.to_string())?;
    let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("/");
    Ok(entry_from_remote(name.to_string(), &meta, None))
}

/// Creates a remote directory.
///
/// # Errors
///
/// Surfaces the server's error verbatim (exists, permission denied, …).
pub async fn remote_mkdir(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), String> {
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

/// Renames (moves) a remote file or directory.
///
/// # Errors
///
/// Surfaces the server's error verbatim; many servers refuse to overwrite
/// an existing target.
pub async fn remote_rename(
    sftp: &russh_sftp::client::SftpSession,
    from: &str,
    to: &str,
) -> Result<(), String> {
    sftp.rename(from, to).await.map_err(|e| e.to_string())
}

/// Deletes a remote file, or a directory **recursively** (SFTP's RMDIR
/// only takes empty directories, so the walk happens client-side, exactly
/// like every other SFTP browser). Symlinks are removed as links — never
/// followed — so a link into `/etc` can't turn a folder delete into a
/// system-wide one.
///
/// # Errors
///
/// Surfaces the first server error verbatim and stops there (a partial
/// delete leaves the remainder listed, which is honest).
pub async fn remote_delete(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    if !is_dir {
        return sftp.remove_file(path).await.map_err(|e| e.to_string());
    }
    // Depth-first: children before their directory. Boxed for async recursion.
    let children = remote_list(sftp, path).await?;
    for child in children {
        let child_path = remote_join(path, &child.name);
        let recurse_dir = child.is_dir && !child.is_symlink;
        Box::pin(remote_delete(sftp, &child_path, recurse_dir)).await?;
    }
    sftp.remove_dir(path).await.map_err(|e| e.to_string())
}

/// Sets a remote path's permission bits (the chmod dialog, F5).
///
/// # Errors
///
/// Fails when `mode` exceeds `0o7777` or the server refuses the SETSTAT.
pub async fn remote_chmod(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    mode: u32,
) -> Result<(), String> {
    let meta = russh_sftp::client::fs::Metadata {
        permissions: Some(validate_mode(mode)?),
        ..Default::default()
    };
    sftp.set_metadata(path, meta)
        .await
        .map_err(|e| e.to_string())
}

/// Converts a russh-sftp [`Metadata`](russh_sftp::client::fs::Metadata)
/// into the shared entry shape.
fn entry_from_remote(
    name: String,
    meta: &russh_sftp::client::fs::Metadata,
    link_target: Option<String>,
) -> SftpEntry {
    let is_symlink = meta.is_symlink();
    SftpEntry {
        name,
        size: meta.size.unwrap_or(0),
        mtime_ms: u64::from(meta.mtime.unwrap_or(0)) * 1000,
        mode: meta.permissions.unwrap_or(0) & MODE_BITS,
        is_dir: meta.is_dir() && !is_symlink,
        is_symlink,
        link_target,
    }
}

/// Lists a local directory via `std::fs`, producing the same entry shape
/// as [`remote_list`]: symlinks are described as links (`lstat`), targets
/// come from `read_link`, `.`/`..` are omitted, names sort caselessly.
///
/// # Errors
///
/// Surfaces the OS error verbatim (missing dir, permission denied, …).
pub fn local_list(path: &Path) -> Result<Vec<SftpEntry>, String> {
    let dir = std::fs::read_dir(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut entries = Vec::new();
    for item in dir {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(meta) = std::fs::symlink_metadata(item.path()) else {
            // Raced away between readdir and lstat; skip like `ls` does.
            continue;
        };
        let link_target = if meta.is_symlink() {
            std::fs::read_link(item.path())
                .ok()
                .map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        };
        entries.push(entry_from_local(name, &meta, link_target));
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(entries)
}

/// Stats a local path, **following** symlinks (the double-click follow).
///
/// # Errors
///
/// Surfaces the OS error verbatim (broken links stat as errors).
pub fn local_stat(path: &Path) -> Result<SftpEntry, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());
    Ok(entry_from_local(name, &meta, None))
}

/// Creates a local directory.
///
/// # Errors
///
/// Surfaces the OS error verbatim.
pub fn local_mkdir(path: &Path) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Renames (moves) a local file or directory.
///
/// # Errors
///
/// Surfaces the OS error verbatim.
pub fn local_rename(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("{}: {e}", from.display()))
}

/// Deletes a local file, or a directory recursively. Symlinks are removed
/// as links (`remove_dir_all` does not follow them).
///
/// # Errors
///
/// Surfaces the OS error verbatim.
pub fn local_delete(path: &Path, is_dir: bool) -> Result<(), String> {
    let result = if is_dir {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| format!("{}: {e}", path.display()))
}

/// Sets a local path's permission bits (the chmod dialog works on both
/// panes).
///
/// # Errors
///
/// Fails when `mode` exceeds `0o7777` or the OS refuses.
#[cfg(unix)]
pub fn local_chmod(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(validate_mode(mode)?))
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Converts local `symlink_metadata` into the shared entry shape.
fn entry_from_local(
    name: String,
    meta: &std::fs::Metadata,
    link_target: Option<String>,
) -> SftpEntry {
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & MODE_BITS
    };
    #[cfg(not(unix))]
    let mode = 0;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let is_symlink = meta.is_symlink();
    SftpEntry {
        name,
        size: if meta.is_dir() { 0 } else { meta.len() },
        mtime_ms,
        mode,
        is_dir: meta.is_dir() && !is_symlink,
        is_symlink,
        link_target,
    }
}

/// Rejects permission values beyond the defined bits before they hit a
/// server or the OS.
fn validate_mode(mode: u32) -> Result<u32, String> {
    if mode > MODE_BITS {
        return Err(format!("invalid mode {mode:o} (max 7777)"));
    }
    Ok(mode)
}

// ---------------------------------------------------------------------------
// The transfer engine (F5): streaming, cancellable, progress-throttled.
// ---------------------------------------------------------------------------

/// Chunk size for transfer streaming: big enough to amortize round-trips,
/// small enough that cancellation reacts within a chunk (256 KiB at even
/// 10 MB/s is ~25 ms).
const TRANSFER_CHUNK: usize = 256 * 1024;

/// Minimum interval between progress events (~10/s): the F5 progress bar
/// needs smoothness, not every write (PLAN.md §3 keeps IPC volume down).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// Why a transfer stopped before completing.
enum TransferHalt {
    /// The user cancelled; the caller cleans the partial file quietly.
    Cancelled,
    /// Something broke. `retryable` marks transient causes (dropped
    /// connection, timeout) for the store's auto-retry ×1.
    Failed {
        /// Human-readable cause, surfaced verbatim in the queue row.
        message: String,
        /// Whether an immediate retry is worth attempting.
        retryable: bool,
    },
}

/// Failure from a local I/O error (the `std::io::ErrorKind` taxonomy).
fn halt_from_io(error: &std::io::Error) -> TransferHalt {
    use std::io::ErrorKind;
    let retryable = matches!(
        error.kind(),
        ErrorKind::TimedOut
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::BrokenPipe
            | ErrorKind::UnexpectedEof
            | ErrorKind::Interrupted
            | ErrorKind::WouldBlock
    );
    TransferHalt::Failed {
        message: error.to_string(),
        retryable,
    }
}

/// Failure from an SFTP-level error (the protocol status taxonomy).
fn halt_from_sftp(error: &russh_sftp::client::error::Error) -> TransferHalt {
    use russh_sftp::client::error::Error;
    use russh_sftp::protocol::StatusCode;
    let retryable = match error {
        Error::Status(status) => matches!(
            status.status_code,
            StatusCode::NoConnection | StatusCode::ConnectionLost
        ),
        // Channel-level I/O and timeouts are the connection misbehaving.
        Error::IO(_) | Error::Timeout => true,
        _ => false,
    };
    TransferHalt::Failed {
        message: error.to_string(),
        retryable,
    }
}

/// Emits progress at most every [`PROGRESS_EVERY`].
struct ProgressThrottle {
    /// When progress last went out.
    last: std::time::Instant,
}

impl ProgressThrottle {
    /// A throttle that fires immediately on first ask (bytes 0 paints the
    /// bar without waiting 100 ms).
    fn new() -> Self {
        Self {
            last: std::time::Instant::now() - PROGRESS_EVERY,
        }
    }

    /// Whether to emit now; arms the interval when it says yes.
    fn ready(&mut self) -> bool {
        let now = std::time::Instant::now();
        if now.duration_since(self.last) >= PROGRESS_EVERY {
            self.last = now;
            true
        } else {
            false
        }
    }
}

/// Streams a local file to the remote, reporting progress; the partial
/// remote file on cancel/failure is the **caller's** cleanup.
async fn stream_upload(
    sftp: &russh_sftp::client::SftpSession,
    local: &str,
    remote: &str,
    total: u64,
    token: &tokio_util::sync::CancellationToken,
    events: &dyn SftpEvents,
    transfer_id: &str,
) -> Result<u64, TransferHalt> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let mut src = tokio::fs::File::open(local)
        .await
        .map_err(|e| halt_from_io(&e))?;
    let mut dst = sftp.create(remote).await.map_err(|e| halt_from_sftp(&e))?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut bytes: u64 = 0;
    let mut throttle = ProgressThrottle::new();
    loop {
        let read = tokio::select! {
            biased;
            () = token.cancelled() => return Err(TransferHalt::Cancelled),
            read = src.read(&mut buf) => read.map_err(|e| halt_from_io(&e))?,
        };
        if read == 0 {
            break;
        }
        // The write also reacts to cancel: a stalled server would otherwise
        // pin a cancelled transfer until its timeout.
        tokio::select! {
            biased;
            () = token.cancelled() => return Err(TransferHalt::Cancelled),
            write = dst.write_all(&buf[..read]) => write.map_err(|e| halt_from_io(&e))?,
        }
        bytes += read as u64;
        if throttle.ready() {
            events.on_progress(transfer_id, bytes, total);
        }
    }
    dst.flush().await.map_err(|e| halt_from_io(&e))?;
    dst.close().await.map_err(|e| halt_from_io(&e))?;
    Ok(bytes)
}

/// Streams a remote file to the local disk, reporting progress; the partial
/// local file on cancel/failure is the **caller's** cleanup.
async fn stream_download(
    sftp: &russh_sftp::client::SftpSession,
    remote: &str,
    local: &str,
    total: u64,
    token: &tokio_util::sync::CancellationToken,
    events: &dyn SftpEvents,
    transfer_id: &str,
) -> Result<u64, TransferHalt> {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let mut src = sftp.open(remote).await.map_err(|e| halt_from_sftp(&e))?;
    let mut dst = tokio::fs::File::create(local)
        .await
        .map_err(|e| halt_from_io(&e))?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    let mut bytes: u64 = 0;
    let mut throttle = ProgressThrottle::new();
    loop {
        let read = tokio::select! {
            biased;
            () = token.cancelled() => return Err(TransferHalt::Cancelled),
            read = src.read(&mut buf) => read.map_err(|e| halt_from_io(&e))?,
        };
        if read == 0 {
            break;
        }
        tokio::select! {
            biased;
            () = token.cancelled() => return Err(TransferHalt::Cancelled),
            write = dst.write_all(&buf[..read]) => write.map_err(|e| halt_from_io(&e))?,
        }
        bytes += read as u64;
        if throttle.ready() {
            events.on_progress(transfer_id, bytes, total);
        }
    }
    dst.flush().await.map_err(|e| halt_from_io(&e))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Event sink that records prompt calls.
    struct RecordingEvents {
        prompts: Mutex<Vec<String>>,
    }

    impl RecordingEvents {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                prompts: Mutex::new(Vec::new()),
            })
        }
    }

    impl SftpEvents for RecordingEvents {
        fn on_hostkey_prompt(&self, host_id: &str, _: &str, _: &str, _: &str) {
            self.prompts.lock().expect("lock").push(host_id.to_string());
        }
        fn on_progress(&self, _: &str, _: u64, _: u64) {}
        fn on_done(&self, _: &str, _: u64, _: u64) {}
        fn on_failed(&self, _: &str, _: &str, _: bool) {}
        fn on_cancelled(&self, _: &str) {}
    }

    fn target() -> HostTarget {
        HostTarget {
            host_id: "id-1".into(),
            label: "hermes".into(),
            hostname: "hermes.example.net".into(),
            user: "pandox".into(),
            port: 22,
            identity: "agent".into(),
        }
    }

    #[test]
    fn resolve_trust_without_a_prompt_is_an_error() {
        let manager = SftpManager::new(RecordingEvents::new());
        assert!(manager.resolve_trust("nope", true).is_err());
    }

    #[tokio::test]
    async fn resolve_trust_delivers_the_verdict_to_the_parked_handshake() {
        let manager = SftpManager::new(RecordingEvents::new());
        let (tx, rx) = oneshot::channel();
        manager
            .pending
            .lock()
            .expect("lock")
            .insert("id-1".into(), tx);

        manager.resolve_trust("id-1", true).expect("resolve");
        assert_eq!(rx.await, Ok(true));
        // The prompt is consumed: resolving again is an error.
        assert!(manager.resolve_trust("id-1", false).is_err());
    }

    #[tokio::test]
    async fn unknown_session_ids_are_reported_not_panicked() {
        let manager = SftpManager::new(RecordingEvents::new());
        assert!(manager.session("ghost").await.is_err());
        assert!(manager.target("ghost").await.is_err());
        manager.disconnect("ghost").await; // idempotent no-op
    }

    #[test]
    fn host_target_defaults_an_empty_user() {
        let host = Host {
            id: "id-1".into(),
            label: "hermes".into(),
            hostname: "hermes.example.net".into(),
            ..Host::default()
        };
        let target = HostTarget::from_host(&host).expect("target");
        assert!(!target.user.is_empty(), "user must be defaulted");
    }

    #[test]
    fn host_target_requires_a_hostname() {
        let host = Host {
            id: "sshcfg:hermes".into(),
            label: "hermes".into(),
            ..Host::default()
        };
        assert!(HostTarget::from_host(&host).is_err());
    }

    /// A unique scratch dir in the OS temp dir; removed by each test.
    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("setu-sftp-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn is_retryable(halt: &TransferHalt) -> bool {
        matches!(
            halt,
            TransferHalt::Failed {
                retryable: true,
                ..
            }
        )
    }

    #[test]
    fn io_errors_classify_transient_vs_permanent() {
        use std::io::{Error as IoError, ErrorKind};
        for kind in [
            ErrorKind::TimedOut,
            ErrorKind::ConnectionReset,
            ErrorKind::BrokenPipe,
            ErrorKind::UnexpectedEof,
        ] {
            assert!(
                is_retryable(&halt_from_io(&IoError::new(kind, "x"))),
                "{kind:?} must be retryable"
            );
        }
        for kind in [ErrorKind::NotFound, ErrorKind::PermissionDenied] {
            assert!(
                !is_retryable(&halt_from_io(&IoError::new(kind, "x"))),
                "{kind:?} must not be retryable"
            );
        }
    }

    #[test]
    fn sftp_errors_classify_transient_vs_permanent() {
        use russh_sftp::client::error::Error;
        use russh_sftp::protocol::{Status, StatusCode};
        let status = |code: StatusCode| {
            Error::Status(Status {
                id: 0,
                status_code: code,
                error_message: "x".into(),
                language_tag: "en".into(),
            })
        };
        assert!(is_retryable(&halt_from_sftp(&status(
            StatusCode::ConnectionLost
        ))));
        assert!(is_retryable(&halt_from_sftp(&status(
            StatusCode::NoConnection
        ))));
        assert!(is_retryable(&halt_from_sftp(&Error::Timeout)));
        assert!(is_retryable(&halt_from_sftp(&Error::IO(
            "broken pipe".into()
        ))));
        assert!(!is_retryable(&halt_from_sftp(&status(
            StatusCode::PermissionDenied
        ))));
        assert!(!is_retryable(&halt_from_sftp(&status(
            StatusCode::NoSuchFile
        ))));
        assert!(!is_retryable(&halt_from_sftp(&status(StatusCode::Failure))));
    }

    #[test]
    fn permission_denied_message_survives_verbatim() {
        use russh_sftp::client::error::Error;
        use russh_sftp::protocol::{Status, StatusCode};
        let halt = halt_from_sftp(&Error::Status(Status {
            id: 0,
            status_code: StatusCode::PermissionDenied,
            error_message: "cannot write /var/log".into(),
            language_tag: "en".into(),
        }));
        let TransferHalt::Failed { message, .. } = halt else {
            panic!("expected Failed");
        };
        assert!(
            message.contains("Permission denied") && message.contains("cannot write /var/log"),
            "F5: permission errors surface verbatim, got {message:?}"
        );
    }

    #[test]
    fn progress_throttle_fires_immediately_then_holds() {
        let mut throttle = ProgressThrottle::new();
        assert!(throttle.ready(), "first ask paints the bar");
        assert!(!throttle.ready(), "second ask inside the window holds");
    }

    #[test]
    fn cancel_is_idempotent_and_scoped() {
        let manager = SftpManager::new(RecordingEvents::new());
        let (id_a, token_a) = manager.register_transfer("sess-1");
        let (_id_b, token_b) = manager.register_transfer("sess-2");

        manager.cancel("unknown-id"); // no-op, no panic
        manager.cancel(&id_a);
        assert!(token_a.is_cancelled());
        assert!(!token_b.is_cancelled(), "other transfers untouched");

        // Session-scoped cancellation (the disconnect path).
        manager.cancel_transfers(|t| t.sftp_session_id == "sess-2");
        assert!(token_b.is_cancelled());
    }

    #[test]
    fn remote_join_forms() {
        assert_eq!(remote_join("/home/pandox", "logs"), "/home/pandox/logs");
        assert_eq!(remote_join("/", "etc"), "/etc");
        assert_eq!(remote_join("/home/", "x"), "/home/x");
        assert_eq!(remote_join("/anything", "/absolute"), "/absolute");
        assert_eq!(remote_join("", "top"), "/top");
    }

    #[test]
    fn validate_mode_bounds() {
        assert_eq!(validate_mode(0o755), Ok(0o755));
        assert_eq!(validate_mode(0o7777), Ok(0o7777));
        assert!(validate_mode(0o10000).is_err());
    }

    #[test]
    fn local_list_names_sizes_and_dirs_sorted_caselessly() {
        let dir = scratch_dir("list");
        std::fs::write(dir.join("beta.txt"), b"12345").expect("file");
        std::fs::create_dir(dir.join("Alpha")).expect("dir");
        let entries = local_list(&dir).expect("list");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "beta.txt"]);
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].size, 5);
        assert!(entries[1].mtime_ms > 0);
        assert!(entries[1].mode > 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_list_round_trips_unicode_and_emoji_names() {
        let dir = scratch_dir("unicode");
        let name = "café-📁-日誌.txt";
        std::fs::write(dir.join(name), b"x").expect("file");
        let entries = local_list(&dir).expect("list");
        assert_eq!(entries[0].name, name);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn local_symlinks_are_links_with_targets_never_followed() {
        let dir = scratch_dir("symlink");
        std::fs::create_dir(dir.join("real")).expect("dir");
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).expect("symlink");
        let entries = local_list(&dir).expect("list");
        let link = entries.iter().find(|e| e.name == "link").expect("link row");
        assert!(link.is_symlink);
        assert!(!link.is_dir, "the entry describes the link, not the target");
        assert!(link.link_target.as_deref().unwrap_or("").ends_with("real"));
        // The follow half: stat resolves through the link.
        let followed = local_stat(&dir.join("link")).expect("stat");
        assert!(followed.is_dir);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn local_chmod_applies_permission_bits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("chmod");
        let file = dir.join("f");
        std::fs::write(&file, b"x").expect("file");
        local_chmod(&file, 0o640).expect("chmod");
        let mode = std::fs::metadata(&file).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o640);
        assert!(local_chmod(&file, 0o10000).is_err(), "out-of-range mode");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_ops_mkdir_rename_delete_recursive() {
        let dir = scratch_dir("ops");
        local_mkdir(&dir.join("sub")).expect("mkdir");
        std::fs::write(dir.join("sub/inner.txt"), b"x").expect("file");
        local_rename(&dir.join("sub"), &dir.join("moved")).expect("rename");
        assert!(dir.join("moved/inner.txt").exists());
        local_delete(&dir.join("moved"), true).expect("recursive delete");
        assert!(!dir.join("moved").exists());
        // Errors surface verbatim, not as panics.
        assert!(local_delete(&dir.join("moved"), true).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_prompt_for_the_same_host_is_refused() {
        let events = RecordingEvents::new();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, _rx) = oneshot::channel();
        pending.lock().expect("lock").insert("id-1".to_string(), tx);

        let handler = ClientHandler {
            target: target(),
            events,
            pending,
            refusal: Arc::new(Mutex::new(None)),
        };
        let result = handler.refuse("test refusal".into());
        assert!(matches!(result, Ok(false)));
        assert_eq!(
            handler.refusal.lock().expect("lock").take(),
            Some("test refusal".into())
        );
    }
}
