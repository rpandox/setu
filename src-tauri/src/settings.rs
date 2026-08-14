//! Read-only access to `~/.config/setu/settings.toml`.
//!
//! Phase 4 needs the reachability prober's knobs (`PLAN.md` §4): probe
//! interval, timeout, concurrency cap, and the global kill switch.
//! Phase 7 adds the `[tailnet]` table (the default login user for tailnet
//! peers, F9). The Settings *window* arrives in Phase 8 — until then the
//! file is optional and hand-editable, and this module only reads it.
//!
//! The same safety properties as [`crate::store`] apply, minus writing:
//! a missing file (or missing keys) means defaults, and a corrupt file is
//! reported as an error — never silently replaced with defaults, because
//! that would make a typo silently re-enable probing the user turned off.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;

/// Reachability prober settings (`[reachability]` in `settings.toml`).
///
/// Every field has the `PLAN.md` §4 default, so a partial table — or no
/// file at all — behaves exactly like the documented defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct TailnetSettings {
    /// Login user for one-click tailnet connects. Empty/missing falls back
    /// to the local `$USER` (resolved by the tailscale module).
    #[serde(default)]
    pub default_user: String,
}

/// The whole `settings.toml` document — only the tables read so far.
///
/// Unknown tables and keys are ignored on purpose: future phases add their
/// sections without breaking older builds reading the same synced file.
#[derive(Debug, Clone, Default, Deserialize)]
struct Settings {
    /// The `[reachability]` table; missing means defaults.
    #[serde(default)]
    reachability: ReachabilitySettings,
    /// The `[tailnet]` table; missing means defaults.
    #[serde(default)]
    tailnet: TailnetSettings,
}

/// Owns `settings.toml`: lazy loading with defaults for a missing file.
///
/// Read-only by design in Phase 4 — the file is the user's to edit until
/// the Phase 8 settings UI writes it.
pub struct SettingsStore {
    /// Absolute path of `settings.toml`.
    path: PathBuf,
    /// Parsed document once loaded; `None` until the first read.
    cache: Mutex<Option<Settings>>,
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
    /// documented defaults, not an error.
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
    /// (the Settings window only lands in Phase 8). The launch-time cache
    /// stays untouched for the reachability path, which snapshots its
    /// config when the prober starts.
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

    /// Reads and parses the file; a missing file is the default document.
    fn load(&self) -> Result<Settings, String> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Settings::default());
            }
            Err(e) => return Err(format!("failed to read {}: {e}", self.path.display())),
        };
        toml::from_str(&text).map_err(|e| format!("failed to parse {}: {e}", self.path.display()))
    }
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
    }

    #[test]
    fn defaults_match_plan_section_4() {
        let d = ReachabilitySettings::default();
        assert!(d.enabled);
        assert_eq!(d.interval_s, 60);
        assert_eq!(d.timeout_ms, 1500);
        assert_eq!(d.max_concurrent, 6);
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
}
