//! Access to `~/.config/setu/settings.toml` — read since Phase 4, written
//! by the Phase 8 Settings window.
//!
//! Phase 4 needs the reachability prober's knobs (`PLAN.md` §4): probe
//! interval, timeout, concurrency cap, and the global kill switch. Phase 7
//! adds the `[tailnet]` table (the default login user for tailnet peers,
//! F9). Phase 8 adds the `[terminal]`, `[sync]`, `[snapshots]`, and
//! `[flags]` tables plus the write path: [`SettingsStore::document`] hands
//! the whole file to the Settings window and [`SettingsStore::save`] writes
//! it back atomically (temp file + rename, the [`crate::store`] pattern).
//!
//! The same safety properties as [`crate::store`] apply: a missing file
//! (or missing keys) means defaults, and a corrupt file is reported as an
//! error — never silently replaced with defaults, because that would make
//! a typo silently re-enable probing the user turned off.
//!
//! Forward compatibility: settings.toml is synced between machines (F10),
//! which may run different app versions. Unknown top-level *tables* are
//! captured on load and written back on save, so an older build never
//! drops a newer build's section. Unknown *keys inside known tables* are
//! still ignored-and-dropped on save — future phases add whole tables far
//! more often than keys, and the `[flags]` table (where per-key growth is
//! expected) is an open map by construction.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::FieldError;

/// Comment header written at the top of `settings.toml` on every save.
const SETTINGS_HEADER: &str = "# Setu settings — written by the Settings window (⌘,), hand-editable.\n\
# Schema: PLAN.md §4 · docs/features/F10-sync-backup.md. Unknown tables are\n\
# preserved on save. This file must never hold secrets.\n\n";

/// Reachability prober settings (`[reachability]` in `settings.toml`).
///
/// Every field has the `PLAN.md` §4 default, so a partial table — or no
/// file at all — behaves exactly like the documented defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReachabilitySettings {
    /// Global kill switch for the prober (per-host switches live on
    /// [`crate::store::Host::reachability`]).
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Seconds between probe sweeps.
    #[serde(default = "default_interval_s")]
    pub interval_s: u32,
    /// Per-probe TCP connect timeout, in milliseconds.
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u32,
    /// Maximum probes in flight at once.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: usize,
}

impl Default for ReachabilitySettings {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            interval_s: default_interval_s(),
            timeout_ms: default_timeout_ms(),
            max_concurrent: default_max_concurrent(),
        }
    }
}

/// Default for [`ReachabilitySettings::enabled`].
fn default_enabled() -> bool {
    true
}

/// Default for [`ReachabilitySettings::interval_s`].
fn default_interval_s() -> u32 {
    60
}

/// Default for [`ReachabilitySettings::timeout_ms`].
fn default_timeout_ms() -> u32 {
    1500
}

/// Default for [`ReachabilitySettings::max_concurrent`].
fn default_max_concurrent() -> usize {
    6
}

/// Tailnet settings (`[tailnet]` in `settings.toml`, F9 Phase 7).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TailnetSettings {
    /// Login user for one-click tailnet connects. Empty/missing falls back
    /// to the local `$USER` (resolved by the tailscale module).
    #[serde(default)]
    pub default_user: String,
}

/// Terminal settings (`[terminal]`, Phase 8). Applied live to open
/// terminals by the frontend when the Settings window saves (F2/F10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSettings {
    /// Terminal font size in pixels (validated to 8–32).
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    /// Scrollback lines kept per terminal (§3 default 10 000).
    #[serde(default = "default_scrollback_lines")]
    pub scrollback_lines: u32,
}

impl Default for TerminalSettings {
    fn default() -> Self {
        Self {
            font_size: default_font_size(),
            scrollback_lines: default_scrollback_lines(),
        }
    }
}

/// Default for [`TerminalSettings::font_size`] (§7 typography: 13px mono).
fn default_font_size() -> u16 {
    13
}

/// Default for [`TerminalSettings::scrollback_lines`] (`PLAN.md` §3).
fn default_scrollback_lines() -> u32 {
    10_000
}

/// Git-sync settings (`[sync]`, F10 Phase 8). The sync *remote* is not
/// here on purpose — it lives in the config repo's own `.git/config`
/// (`PLAN.md` §5, Phase 8 kickoff row), because this file is itself synced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSettings {
    /// Run a sync (commit → pull --rebase → push) when the app quits.
    /// Capped at 10s so quit never hangs; skipped while conflicted.
    #[serde(default)]
    pub auto_sync_on_quit: bool,
}

/// Config-dir snapshot settings (`[snapshots]`, F10 Phase 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotSettings {
    /// Whether scheduled snapshots run at all.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Days between scheduled snapshots (F10 default: weekly).
    #[serde(default = "default_interval_days")]
    pub interval_days: u32,
    /// How many archives to keep; older ones are pruned (F10 default: 10).
    #[serde(default = "default_keep")]
    pub keep: u32,
}

impl Default for SnapshotSettings {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            interval_days: default_interval_days(),
            keep: default_keep(),
        }
    }
}

/// Default for [`SnapshotSettings::interval_days`].
fn default_interval_days() -> u32 {
    7
}

/// Default for [`SnapshotSettings::keep`].
fn default_keep() -> u32 {
    10
}

/// The whole `settings.toml` document.
///
/// Field names mirror the TOML tables verbatim (the [`crate::store::Host`]
/// precedent), and the struct crosses IPC as-is: the Settings window edits
/// a copy and hands it back to [`SettingsStore::save`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SettingsDocument {
    /// The `[reachability]` table; missing means defaults.
    #[serde(default)]
    pub reachability: ReachabilitySettings,
    /// The `[tailnet]` table; missing means defaults.
    #[serde(default)]
    pub tailnet: TailnetSettings,
    /// The `[terminal]` table; missing means defaults.
    #[serde(default)]
    pub terminal: TerminalSettings,
    /// The `[sync]` table; missing means defaults.
    #[serde(default)]
    pub sync: SyncSettings,
    /// The `[snapshots]` table; missing means defaults.
    #[serde(default)]
    pub snapshots: SnapshotSettings,
    /// Advanced-track feature flags (`[flags]`, default-off; §0.5). Keys
    /// are defined by the phases that ship the features — an open map, so
    /// flags from newer builds survive an older build's save.
    #[serde(default)]
    pub flags: BTreeMap<String, bool>,
    /// Unknown top-level tables from newer app versions, preserved
    /// verbatim across a load → save round trip (see the module docs).
    #[serde(flatten)]
    pub extra: toml::map::Map<String, toml::Value>,
}

/// Validates `doc`, returning one [`FieldError`] per out-of-range value.
///
/// Field names are the TOML key paths (`"terminal.font_size"`), which the
/// Settings window maps back onto its inputs. An empty result means the
/// document is safe to [`SettingsStore::save`].
pub fn validate(doc: &SettingsDocument) -> Vec<FieldError> {
    let mut errors = Vec::new();
    let mut check = |ok: bool, field: &str, message: &str| {
        if !ok {
            errors.push(FieldError::new(field, message));
        }
    };
    let t = &doc.terminal;
    check(
        (8..=32).contains(&t.font_size),
        "terminal.font_size",
        "font size must be 8–32 px",
    );
    check(
        t.scrollback_lines <= 1_000_000,
        "terminal.scrollback_lines",
        "scrollback is capped at 1 000 000 lines",
    );
    let s = &doc.snapshots;
    check(
        (1..=365).contains(&s.interval_days),
        "snapshots.interval_days",
        "snapshot interval must be 1–365 days",
    );
    check(
        (1..=100).contains(&s.keep),
        "snapshots.keep",
        "keep must be 1–100 archives",
    );
    let r = &doc.reachability;
    check(
        (5..=3600).contains(&r.interval_s),
        "reachability.interval_s",
        "probe interval must be 5–3600 seconds",
    );
    check(
        (100..=60_000).contains(&r.timeout_ms),
        "reachability.timeout_ms",
        "probe timeout must be 100–60000 ms",
    );
    check(
        (1..=64).contains(&r.max_concurrent),
        "reachability.max_concurrent",
        "concurrent probes must be 1–64",
    );
    errors
}

/// Owns `settings.toml`: lazy loading with defaults for a missing file,
/// atomic writes from the Settings window (Phase 8).
pub struct SettingsStore {
    /// Absolute path of `settings.toml`.
    path: PathBuf,
    /// Parsed document once loaded; `None` until the first read. Replaced
    /// wholesale by [`SettingsStore::save`] and refreshed by
    /// [`SettingsStore::document`], so hand-edits are picked up whenever
    /// the Settings window opens.
    cache: Mutex<Option<SettingsDocument>>,
}

impl SettingsStore {
    /// Creates a store over `path`. Nothing is read until first use.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    /// The canonical location: `~/.config/setu/settings.toml` (`PLAN.md` §4).
    ///
    /// # Errors
    ///
    /// Fails when the home directory cannot be determined.
    pub fn default_path() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join(".config/setu/settings.toml"))
            .ok_or_else(|| "cannot determine home directory".to_string())
    }

    /// Returns the reachability settings (loading the file on first call).
    ///
    /// A missing file — or a file without a `[reachability]` table — is the
    /// documented defaults, not an error. The launch-time cache is replaced
    /// by every [`SettingsStore::save`], so a Settings-window edit reaches
    /// the prober without a restart.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn reachability(&self) -> Result<ReachabilitySettings, String> {
        let mut cache = self.cache.lock().expect("settings cache poisoned");
        if cache.is_none() {
            *cache = Some(self.load()?);
        }
        Ok(cache.as_ref().expect("loaded above").reachability)
    }

    /// Returns the tailnet settings, fresh-parsed on every call — the F9
    /// poll is 30s apart and the file is tiny, so re-reading keeps a
    /// hand-edited `[tailnet] default_user` live without an app restart
    /// (`PLAN.md` §5, Phase 7 live-walk row).
    ///
    /// A missing file — or a file without a `[tailnet]` table — is the
    /// defaults, not an error.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn tailnet(&self) -> Result<TailnetSettings, String> {
        Ok(self.load()?.tailnet)
    }

    /// Returns the whole document, fresh-parsed and re-cached — the
    /// Settings window must show the file's current truth even after a
    /// hand edit.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn document(&self) -> Result<SettingsDocument, String> {
        let doc = self.load()?;
        let mut cache = self.cache.lock().expect("settings cache poisoned");
        *cache = Some(doc.clone());
        Ok(doc)
    }

    /// Validates and writes `doc` atomically (temp file in the same
    /// directory, then rename — the [`crate::store`] pattern), then
    /// replaces the in-memory cache so every later read sees the new
    /// values.
    ///
    /// # Errors
    ///
    /// Fails when validation rejects the document (the message lists the
    /// offending fields; the IPC layer surfaces per-field errors
    /// result-side instead) or when the file cannot be written.
    pub fn save(&self, doc: &SettingsDocument) -> Result<(), String> {
        let errors = validate(doc);
        if !errors.is_empty() {
            let fields: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
            return Err(format!("invalid settings: {}", fields.join(", ")));
        }
        save_atomic(&self.path, doc)?;
        let mut cache = self.cache.lock().expect("settings cache poisoned");
        *cache = Some(doc.clone());
        Ok(())
    }

    /// Reads and parses the file; a missing file is the default document.
    fn load(&self) -> Result<SettingsDocument, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SettingsDocument::default());
            }
            Err(e) => return Err(format!("failed to read {}: {e}", self.path.display())),
        };
        toml::from_str(&text).map_err(|e| format!("failed to parse {}: {e}", self.path.display()))
    }
}

/// Serializes `doc` and writes the file atomically: temp file in the same
/// directory, then `rename` into place.
fn save_atomic(path: &Path, doc: &SettingsDocument) -> Result<(), String> {
    let body =
        toml::to_string_pretty(doc).map_err(|e| format!("failed to serialize settings: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("settings.toml"),
        std::process::id()
    ));
    fs::write(&tmp, format!("{SETTINGS_HEADER}{body}"))
        .map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup; the temp file is harmless if this fails too.
        let _ = fs::remove_file(&tmp);
        format!("failed to move {} into place: {e}", tmp.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store over a fresh temp directory (removed on drop).
    struct TempSettings {
        dir: PathBuf,
        store: SettingsStore,
    }

    impl TempSettings {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("setu-settings-{}", uuid::Uuid::new_v4()));
            let store = SettingsStore::new(dir.join("settings.toml"));
            Self { dir, store }
        }

        fn write(&self, body: &str) {
            fs::create_dir_all(&self.dir).expect("mkdir");
            fs::write(self.dir.join("settings.toml"), body).expect("write settings");
        }

        fn read(&self) -> String {
            fs::read_to_string(self.dir.join("settings.toml")).expect("read settings")
        }
    }

    impl Drop for TempSettings {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn missing_file_is_the_defaults() {
        let t = TempSettings::new();
        assert_eq!(
            t.store.reachability().expect("defaults"),
            ReachabilitySettings::default()
        );
        assert_eq!(t.store.document().expect("defaults"), SettingsDocument::default());
    }

    #[test]
    fn defaults_match_plan_section_4() {
        let d = ReachabilitySettings::default();
        assert!(d.enabled);
        assert_eq!(d.interval_s, 60);
        assert_eq!(d.timeout_ms, 1500);
        assert_eq!(d.max_concurrent, 6);
        let t = TerminalSettings::default();
        assert_eq!(t.font_size, 13);
        assert_eq!(t.scrollback_lines, 10_000);
        let s = SnapshotSettings::default();
        assert!(s.enabled);
        assert_eq!(s.interval_days, 7);
        assert_eq!(s.keep, 10);
        assert!(!SyncSettings::default().auto_sync_on_quit);
    }

    #[test]
    fn partial_table_fills_missing_keys_with_defaults() {
        let t = TempSettings::new();
        t.write("[reachability]\ninterval_s = 15\n");
        let s = t.store.reachability().expect("parse");
        assert_eq!(s.interval_s, 15);
        assert!(s.enabled);
        assert_eq!(s.timeout_ms, 1500);
        assert_eq!(s.max_concurrent, 6);
    }

    #[test]
    fn full_table_round_trips() {
        let t = TempSettings::new();
        t.write(
            "[reachability]\nenabled = false\ninterval_s = 120\ntimeout_ms = 500\nmax_concurrent = 2\n",
        );
        let s = t.store.reachability().expect("parse");
        assert!(!s.enabled);
        assert_eq!(s.interval_s, 120);
        assert_eq!(s.timeout_ms, 500);
        assert_eq!(s.max_concurrent, 2);
    }

    #[test]
    fn unknown_tables_and_keys_are_ignored() {
        let t = TempSettings::new();
        t.write("[appearance]\ncrt = true\n\n[reachability]\ntimeout_ms = 900\nfuture_knob = 1\n");
        let s = t.store.reachability().expect("parse");
        assert_eq!(s.timeout_ms, 900);
    }

    #[test]
    fn tailnet_default_user_reads_and_defaults_empty() {
        let t = TempSettings::new();
        t.write("[tailnet]\ndefault_user = \"ops\"\n");
        assert_eq!(t.store.tailnet().expect("parse").default_user, "ops");

        let empty = TempSettings::new();
        assert_eq!(empty.store.tailnet().expect("defaults").default_user, "");
    }

    #[test]
    fn corrupt_file_is_an_error_not_defaults() {
        let t = TempSettings::new();
        t.write("[reachability\nnot toml");
        let err = t.store.reachability().expect_err("must fail");
        assert!(err.contains("failed to parse"), "got: {err}");
    }

    #[test]
    fn save_round_trips_through_document() {
        let t = TempSettings::new();
        let mut doc = SettingsDocument::default();
        doc.terminal.font_size = 15;
        doc.terminal.scrollback_lines = 20_000;
        doc.sync.auto_sync_on_quit = true;
        doc.tailnet.default_user = "ops".into();
        doc.flags.insert("semantic_terminal".into(), false);
        t.store.save(&doc).expect("save");
        assert_eq!(t.store.document().expect("reload"), doc);
        assert!(t.read().starts_with("# Setu settings"));
    }

    #[test]
    fn save_replaces_the_reachability_cache() {
        let t = TempSettings::new();
        // Prime the launch-time cache with the defaults.
        assert_eq!(t.store.reachability().expect("defaults").interval_s, 60);
        let mut doc = SettingsDocument::default();
        doc.reachability.interval_s = 15;
        t.store.save(&doc).expect("save");
        // The cached read now sees the saved value — no restart needed.
        assert_eq!(t.store.reachability().expect("cached").interval_s, 15);
    }

    #[test]
    fn save_preserves_unknown_tables_from_newer_builds() {
        let t = TempSettings::new();
        t.write("[quake]\nhotkey = \"alt-backtick\"\n\n[terminal]\nfont_size = 14\n");
        let doc = t.store.document().expect("load");
        assert_eq!(doc.terminal.font_size, 14);
        t.store.save(&doc).expect("save");
        let body = t.read();
        assert!(body.contains("[quake]"), "unknown table dropped: {body}");
        assert!(body.contains("hotkey = \"alt-backtick\""));
    }

    #[test]
    fn validate_flags_out_of_range_fields() {
        let mut doc = SettingsDocument::default();
        doc.terminal.font_size = 4;
        doc.snapshots.keep = 0;
        doc.reachability.max_concurrent = 200;
        let errors = validate(&doc);
        let fields: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
        assert_eq!(
            fields,
            vec![
                "terminal.font_size",
                "snapshots.keep",
                "reachability.max_concurrent"
            ]
        );
        let err = TempSettings::new().store.save(&doc).expect_err("must fail");
        assert!(err.contains("terminal.font_size"), "got: {err}");
    }

    #[test]
    fn flags_default_to_an_empty_map_and_round_trip() {
        let t = TempSettings::new();
        t.write("[flags]\nsemantic_terminal = true\nfuture_flag = true\n");
        let doc = t.store.document().expect("load");
        assert_eq!(doc.flags.get("semantic_terminal"), Some(&true));
        assert_eq!(doc.flags.get("future_flag"), Some(&true));
        t.store.save(&doc).expect("save");
        assert!(t.read().contains("future_flag = true"));
    }
}
