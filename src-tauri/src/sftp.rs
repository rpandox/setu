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
}

impl SftpManager {
    /// Creates a manager reporting through `events`.
    pub fn new(events: Arc<dyn SftpEvents>) -> Self {
        Self {
            events,
            conns: tokio::sync::Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
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
    /// same contract as `pty_kill`).
    pub async fn disconnect(&self, id: &str) {
        let conn = self.conns.lock().await.remove(id);
        if let Some(conn) = conn {
            close_conn(conn).await;
        }
    }

    /// Closes every session — the app-exit sweep (CLAUDE.md: no orphans).
    pub async fn kill_all(&self) {
        let conns: Vec<SftpConn> = self.conns.lock().await.drain().map(|(_, c)| c).collect();
        for conn in conns {
            close_conn(conn).await;
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
