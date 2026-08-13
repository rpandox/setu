//! Plain-TOML persistence for hosts, snippets, runbooks, and settings.
//!
//! Setu's sync unit is `~/.config/setu/` — human-diffable TOML files that are
//! safe to put in a git repo because the schema forbids secret fields
//! (`PLAN.md` §4). Secrets live only in the macOS Keychain.
//!
//! Phase 2 lands `hosts.toml` here: the [`Host`] record (the full §4 schema,
//! so fields owned by later phases round-trip today), the [`HostsStore`] that
//! owns loading, validating, and atomically writing the file, and the
//! [`FieldError`] shape that carries validation failures to the HostEditor.
//!
//! Two safety properties hold everywhere:
//!
//! 1. **Writes are atomic** — the file is written to a temp path in the same
//!    directory and `rename`d into place, so a crash mid-write can never eat
//!    the host list.
//! 2. **A corrupt file is never overwritten** — when `hosts.toml` fails to
//!    parse, every operation returns the parse error and no save happens
//!    until the user fixes the file.
//!
//! Saves rewrite the file in canonical formatting; hand-written comments are
//! not preserved (documented in `docs/dev/store.md`, escape hatch `toml_edit`).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Header written at the top of every `hosts.toml` Setu saves.
const HOSTS_HEADER: &str = "# Setu hosts — managed by the app (canonical formatting; comments are\n# rewritten on save). Schema: PLAN.md §4. This file must never hold secrets.\n\n";

/// Where a host record came from (`PLAN.md` §4 `source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HostSource {
    /// Created in Setu and persisted in `hosts.toml`.
    #[default]
    Setu,
    /// Parsed from `~/.ssh/config`; read-only until adopted (F1).
    SshConfig,
    /// Discovered tailnet peer; ephemeral, never persisted (Phase 7).
    Tailscale,
}

/// A saved port-forward definition (F7). Stored from Phase 2 so files
/// round-trip; the forwarding engine arrives in Phase 6.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Forward {
    /// Forward type: `"L"` (local), `"R"` (remote), or `"D"` (dynamic).
    #[serde(rename = "type")]
    pub kind: String,
    /// The `ssh -L/-R/-D` spec, e.g. `"8080:localhost:8080"`.
    pub spec: String,
    /// Whether the forward starts automatically with the session.
    #[serde(default)]
    pub auto: bool,
}

/// Per-host fleet-health settings (F13). Stored from Phase 2 so files
/// round-trip; the health engine arrives in Phase 12.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    /// Whether batched health probing is enabled for this host.
    #[serde(default)]
    pub enabled: bool,
    /// Seconds between health probes.
    #[serde(default = "default_health_interval")]
    pub interval_s: u32,
}

impl Default for Health {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_s: default_health_interval(),
        }
    }
}

/// One host record — the full `PLAN.md` §4 `[[host]]` schema.
///
/// Serialized with snake_case keys in both `hosts.toml` and over IPC (the
/// frontend `Host` type mirrors the TOML schema verbatim; see
/// `src/ipc/contract.ts`). Fields owned by later phases (`use_mosh`,
/// `control_master`, `forwards`, `health`) are stored and round-tripped now
/// but ignored until their phase lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Host {
    /// Stable UUID. Empty on a create draft; assigned by
    /// [`HostsStore::upsert`].
    #[serde(default)]
    pub id: String,
    /// Display label, the row's primary identity (e.g. `"hermes"`).
    #[serde(default)]
    pub label: String,
    /// Sidebar section this host lives under; empty = ungrouped.
    #[serde(default)]
    pub group: String,
    /// Free-form tag chips (F1).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Identity accent hue, 0–7, used on tabs and the terminal cursor (§7).
    #[serde(default)]
    pub hue: u8,
    /// Hostname or IP to connect to. May be empty only for
    /// `source = "ssh_config"` alias-only rows.
    #[serde(default)]
    pub hostname: String,
    /// Login user; empty lets system ssh decide (config or local user).
    #[serde(default)]
    pub user: String,
    /// SSH port.
    #[serde(default = "default_port")]
    pub port: u16,
    /// `"agent"` or a path to a private key file.
    #[serde(default = "default_identity")]
    pub identity: String,
    /// Prefer mosh over ssh (Phase 7; stored, not yet honored).
    #[serde(default)]
    pub use_mosh: bool,
    /// Command appended after `--` on connect (e.g. `"tmux new -A -s main"`).
    /// Empty = none.
    #[serde(default)]
    pub startup: String,
    /// OpenSSH ControlMaster multiplexing (Phase 11; stored, not yet honored).
    #[serde(default)]
    pub control_master: bool,
    /// Whether the reachability prober may touch this host (LED board,
    /// Phase 4). Defaults on.
    #[serde(default = "default_true")]
    pub reachability: bool,
    /// Saved port forwards (Phase 6; stored, not yet honored).
    #[serde(default)]
    pub forwards: Vec<Forward>,
    /// Fleet-health settings (Phase 12; stored, not yet honored).
    #[serde(default)]
    pub health: Health,
    /// Free-form notes (minimal markdown rendered in a popover, Phase 4).
    #[serde(default)]
    pub notes: String,
    /// Pinned to the Favorites section at the top of the sidebar.
    #[serde(default)]
    pub favorite: bool,
    /// Where this record came from; only `setu` rows persist here.
    #[serde(default)]
    pub source: HostSource,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            group: String::new(),
            tags: Vec::new(),
            hue: 0,
            hostname: String::new(),
            user: String::new(),
            port: default_port(),
            identity: default_identity(),
            use_mosh: false,
            startup: String::new(),
            control_master: false,
            reachability: true,
            forwards: Vec::new(),
            health: Health::default(),
            notes: String::new(),
            favorite: false,
            source: HostSource::Setu,
        }
    }
}

/// One field-level validation failure, addressed to a HostEditor input
/// (mirrors `HostFieldError` in `contract.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FieldError {
    /// The `Host` field the message belongs to, e.g. `"hostname"`.
    pub field: String,
    /// Human-readable problem statement.
    pub message: String,
}

impl FieldError {
    /// Builds an error for `field` with `message` (shared with
    /// [`crate::snippets`]'s validator).
    pub(crate) fn new(field: &str, message: &str) -> Self {
        Self {
            field: field.to_string(),
            message: message.to_string(),
        }
    }
}

/// Outcome of [`HostsStore::upsert`]: saved, or rejected with field errors.
#[derive(Debug)]
pub enum UpsertOutcome {
    /// The host passed validation and was written to disk (boxed to keep
    /// the variant sizes balanced).
    Saved(Box<Host>),
    /// Validation failed; nothing was written.
    Invalid(Vec<FieldError>),
}

/// Wrapper matching the `[[host]]` array-of-tables layout of `hosts.toml`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct HostsFile {
    /// The host records, in file order (which is also sidebar order within
    /// a group).
    #[serde(default)]
    host: Vec<Host>,
}

/// Owns `hosts.toml`: lazy loading, validation, and atomic writes.
///
/// One instance lives in Tauri managed state. The cache holds the parsed
/// host list after the first successful load; a file that fails to parse
/// keeps every operation failing (with the parse error) rather than risking
/// a save that clobbers user data.
///
/// # Examples
///
/// ```
/// use setu_lib::store::{Host, HostsStore, UpsertOutcome};
///
/// let dir = std::env::temp_dir().join(format!("setu-doc-{}", uuid::Uuid::new_v4()));
/// let store = HostsStore::new(dir.join("hosts.toml"));
/// assert_eq!(store.list().unwrap().len(), 0);
///
/// let outcome = store
///     .upsert(Host {
///         label: "hermes".into(),
///         hostname: "hermes.example.net".into(),
///         ..Host::default()
///     })
///     .unwrap();
/// assert!(matches!(outcome, UpsertOutcome::Saved(_)));
/// assert_eq!(store.list().unwrap().len(), 1);
/// # std::fs::remove_dir_all(&dir).ok();
/// ```
pub struct HostsStore {
    /// Absolute path of `hosts.toml`.
    path: PathBuf,
    /// Parsed hosts once loaded; `None` until the first read.
    cache: Mutex<Option<Vec<Host>>>,
}

impl HostsStore {
    /// Creates a store over `path`. Nothing is read until first use.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    /// The canonical location: `~/.config/setu/hosts.toml` (`PLAN.md` §4).
    ///
    /// # Errors
    ///
    /// Fails when the home directory cannot be determined.
    pub fn default_path() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join(".config/setu/hosts.toml"))
            .ok_or_else(|| "cannot determine home directory".to_string())
    }

    /// Returns all persisted hosts (loading the file on first call).
    ///
    /// A missing file is an empty list, not an error.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn list(&self) -> Result<Vec<Host>, String> {
        let mut cache = self.cache.lock().expect("hosts cache poisoned");
        self.ensure_loaded(&mut cache)?;
        Ok(cache.as_ref().expect("loaded above").clone())
    }

    /// Looks up a persisted host by id.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read or parsed.
    pub fn get(&self, id: &str) -> Result<Option<Host>, String> {
        Ok(self.list()?.into_iter().find(|h| h.id == id))
    }

    /// Validates `host` and creates it (empty `id` → fresh UUID) or updates
    /// the record with the same `id`, then atomically saves the file.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read/parsed or the save fails.
    /// Validation failures are the `Ok(UpsertOutcome::Invalid)` case, not an
    /// error: they are expected editor outcomes, and nothing is written.
    pub fn upsert(&self, mut host: Host) -> Result<UpsertOutcome, String> {
        let errors = validate_host(&host);
        if !errors.is_empty() {
            return Ok(UpsertOutcome::Invalid(errors));
        }
        // Persisted rows are always Setu-owned: adopt flips the source by
        // upserting a copy, and ssh_config rows are never written here.
        host.source = HostSource::Setu;
        let mut cache = self.cache.lock().expect("hosts cache poisoned");
        self.ensure_loaded(&mut cache)?;
        let hosts = cache.as_mut().expect("loaded above");
        if host.id.is_empty() {
            host.id = uuid::Uuid::new_v4().to_string();
            hosts.push(host.clone());
        } else if let Some(existing) = hosts.iter_mut().find(|h| h.id == host.id) {
            *existing = host.clone();
        } else {
            return Err(format!("unknown host: {}", host.id));
        }
        save_atomic(&self.path, hosts)?;
        Ok(UpsertOutcome::Saved(Box::new(host)))
    }

    /// Deletes a host by id and atomically saves. Unknown ids are a no-op
    /// (idempotent delete).
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be read/parsed or the save fails.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut cache = self.cache.lock().expect("hosts cache poisoned");
        self.ensure_loaded(&mut cache)?;
        let hosts = cache.as_mut().expect("loaded above");
        let before = hosts.len();
        hosts.retain(|h| h.id != id);
        if hosts.len() != before {
            save_atomic(&self.path, hosts)?;
        }
        Ok(())
    }

    /// Loads the file into `cache` if it has not been loaded yet.
    fn ensure_loaded(&self, cache: &mut Option<Vec<Host>>) -> Result<(), String> {
        if cache.is_some() {
            return Ok(());
        }
        let hosts = match fs::read_to_string(&self.path) {
            Ok(text) => {
                toml::from_str::<HostsFile>(&text)
                    .map_err(|e| format!("failed to parse {}: {e}", self.path.display()))?
                    .host
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("failed to read {}: {e}", self.path.display())),
        };
        *cache = Some(hosts);
        Ok(())
    }
}

/// Validates a host draft for saving; an empty result means valid.
///
/// Rules (F1 inline validation): label and hostname non-empty, port ≥ 1
/// (the type caps it at 65535), hue 0–7, and `identity` is `"agent"` or a
/// path that exists (`~` expanded).
pub fn validate_host(host: &Host) -> Vec<FieldError> {
    let mut errors = Vec::new();
    if host.label.trim().is_empty() {
        errors.push(FieldError::new("label", "Label is required"));
    }
    if host.hostname.trim().is_empty() {
        errors.push(FieldError::new("hostname", "Hostname is required"));
    }
    if host.port == 0 {
        errors.push(FieldError::new("port", "Port must be between 1 and 65535"));
    }
    if host.hue > 7 {
        errors.push(FieldError::new("hue", "Hue must be between 0 and 7"));
    }
    let identity = host.identity.trim();
    if identity != "agent" && !identity.is_empty() && !expand_tilde(identity).exists() {
        errors.push(FieldError::new(
            "identity",
            "Identity file not found (use \"agent\" for the SSH agent)",
        ));
    }
    errors
}

/// Expands a leading `~/` to the home directory (paths from the editor and
/// from `~/.ssh/config` commonly use it).
pub fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Serializes `hosts` and writes the file atomically: temp file in the same
/// directory, then `rename` into place.
fn save_atomic(path: &Path, hosts: &[Host]) -> Result<(), String> {
    let file = HostsFile {
        host: hosts.to_vec(),
    };
    let body =
        toml::to_string_pretty(&file).map_err(|e| format!("failed to serialize hosts: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("hosts.toml"),
        std::process::id()
    ));
    fs::write(&tmp, format!("{HOSTS_HEADER}{body}"))
        .map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup; the temp file is harmless if this fails too.
        let _ = fs::remove_file(&tmp);
        format!("failed to move {} into place: {e}", tmp.display())
    })
}

/// Default SSH port.
fn default_port() -> u16 {
    22
}

/// Default identity: the SSH agent.
fn default_identity() -> String {
    "agent".to_string()
}

/// Serde default for fields that default to `true`.
fn default_true() -> bool {
    true
}

/// Default health-probe interval, seconds (§4).
fn default_health_interval() -> u32 {
    30
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store over a fresh temp directory (removed by `TempStore::drop`).
    struct TempStore {
        dir: PathBuf,
        store: HostsStore,
    }

    impl TempStore {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("setu-store-{}", uuid::Uuid::new_v4()));
            let store = HostsStore::new(dir.join("hosts.toml"));
            Self { dir, store }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("hosts.toml")
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn valid_host() -> Host {
        Host {
            label: "hermes".into(),
            hostname: "hermes.example.net".into(),
            user: "pandox".into(),
            ..Host::default()
        }
    }

    fn saved(outcome: UpsertOutcome) -> Host {
        match outcome {
            UpsertOutcome::Saved(host) => *host,
            UpsertOutcome::Invalid(errors) => panic!("unexpected validation errors: {errors:?}"),
        }
    }

    #[test]
    fn missing_file_is_an_empty_list() {
        let t = TempStore::new();
        assert_eq!(t.store.list().expect("list"), Vec::new());
    }

    #[test]
    fn upsert_assigns_id_persists_and_survives_reload() {
        let t = TempStore::new();
        let mut host = valid_host();
        host.tags = vec!["prod".into(), "ubuntu".into()];
        host.hue = 4;
        host.startup = "tmux new -A -s main".into();
        host.favorite = true;
        host.forwards = vec![Forward {
            kind: "L".into(),
            spec: "8080:localhost:8080".into(),
            auto: false,
        }];
        let saved_host = saved(t.store.upsert(host).expect("upsert"));
        assert!(!saved_host.id.is_empty(), "id must be assigned");

        // A brand-new store over the same file sees the identical record —
        // the full §4 schema round-trips.
        let reloaded = HostsStore::new(t.path()).list().expect("reload");
        assert_eq!(reloaded, vec![saved_host]);
    }

    #[test]
    fn upsert_with_id_updates_in_place() {
        let t = TempStore::new();
        let mut host = saved(t.store.upsert(valid_host()).expect("create"));
        host.label = "hermes-renamed".into();
        let updated = saved(t.store.upsert(host.clone()).expect("update"));
        assert_eq!(updated.label, "hermes-renamed");
        let all = t.store.list().expect("list");
        assert_eq!(all.len(), 1, "update must not duplicate");
        assert_eq!(all[0].label, "hermes-renamed");
    }

    #[test]
    fn upsert_unknown_id_is_an_error() {
        let t = TempStore::new();
        let mut host = valid_host();
        host.id = "no-such-id".into();
        assert!(t.store.upsert(host).is_err());
    }

    #[test]
    fn validation_rejects_bad_fields_and_writes_nothing() {
        let t = TempStore::new();
        let host = Host {
            label: "  ".into(),
            hostname: String::new(),
            port: 0,
            hue: 9,
            identity: "/definitely/not/a/real/key".into(),
            ..Host::default()
        };
        let outcome = t.store.upsert(host).expect("upsert runs");
        let UpsertOutcome::Invalid(errors) = outcome else {
            panic!("expected validation failure");
        };
        let fields: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(fields, vec!["label", "hostname", "port", "hue", "identity"]);
        assert!(!t.path().exists(), "invalid draft must not create the file");
    }

    #[test]
    fn identity_agent_and_existing_path_are_valid() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        let key = t.dir.join("id_ed25519");
        fs::write(&key, "not-a-real-key").expect("write key");

        let mut host = valid_host();
        host.identity = key.to_string_lossy().into_owned();
        assert!(validate_host(&host).is_empty());
        host.identity = "agent".into();
        assert!(validate_host(&host).is_empty());
    }

    #[test]
    fn delete_removes_and_is_idempotent() {
        let t = TempStore::new();
        let host = saved(t.store.upsert(valid_host()).expect("create"));
        t.store.delete(&host.id).expect("delete");
        assert_eq!(t.store.list().expect("list"), Vec::new());
        // Unknown id: no-op, no error.
        t.store.delete(&host.id).expect("re-delete");
    }

    #[test]
    fn corrupt_file_errors_and_is_never_overwritten() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        let garbage = "[[host]\nthis is not toml";
        fs::write(t.path(), garbage).expect("write garbage");

        assert!(t.store.list().is_err());
        assert!(t.store.upsert(valid_host()).is_err());
        assert!(t.store.delete("any").is_err());
        let on_disk = fs::read_to_string(t.path()).expect("read back");
        assert_eq!(on_disk, garbage, "corrupt file must be left untouched");
    }

    #[test]
    fn unknown_fields_are_tolerated_on_load() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        fs::write(
            t.path(),
            "[[host]]\nid = \"x\"\nlabel = \"h\"\nhostname = \"h.net\"\nfrom_the_future = true\n",
        )
        .expect("write");
        let hosts = t.store.list().expect("list");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "h");
    }

    #[test]
    fn defaults_fill_missing_fields() {
        let t = TempStore::new();
        fs::create_dir_all(&t.dir).expect("mkdir");
        fs::write(
            t.path(),
            "[[host]]\nid = \"x\"\nlabel = \"h\"\nhostname = \"h.net\"\n",
        )
        .expect("write");
        let host = &t.store.list().expect("list")[0];
        assert_eq!(host.port, 22);
        assert_eq!(host.identity, "agent");
        assert!(host.reachability);
        assert!(!host.health.enabled);
        assert_eq!(host.health.interval_s, 30);
        assert_eq!(host.source, HostSource::Setu);
    }
}
