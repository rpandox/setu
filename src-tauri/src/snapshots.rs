//! Scheduled config-dir snapshots (F10, Phase 8).
//!
//! A safety net under git sync: every `interval_days` (default weekly) the
//! whole `~/.config/setu` dir is archived as
//! `setu-config-<UTC ts>.tar.gz` into the state dir's `snapshots/`
//! folder, keeping the newest `keep` archives (default 10). The format is
//! tar.gz, not F10's literal "zip" (`PLAN.md` §5, snapshot-format row) —
//! it reuses the vault's tar walk (skip `.git`, skip symlinks) plus tiny
//! gzip, and Archive Utility opens both with a double-click.
//!
//! **Zero state files**: "when did the last snapshot run" is the newest
//! archive's mtime. The scheduler is a [`crate::reach`]-style loop — an
//! hourly tick plus a [`SnapshotScheduler::poke`] wakeup when settings
//! change or a manual snapshot lands — that re-reads
//! [`crate::settings::SettingsStore`] every pass, so an edited interval or
//! a flipped kill switch applies without a restart.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tauri::Manager as _;
use tokio::sync::Notify;

use crate::{settings, sync, vault};

/// Archive filename prefix (also the top-level dir inside the tarball).
const ARCHIVE_PREFIX: &str = "setu-config-";

/// Archive filename suffix.
const ARCHIVE_SUFFIX: &str = ".tar.gz";

/// How often the scheduler re-checks whether a snapshot is due. Wakeups
/// via [`SnapshotScheduler::poke`] happen sooner.
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Archives the config dir into `snapshots_dir` right now, returning the
/// new archive's path, then prunes to `keep` newest archives.
///
/// The write is atomic (temp file + rename), so a crash mid-archive never
/// leaves a half-written `.tar.gz` among the snapshots.
///
/// # Errors
///
/// Fails when either directory can't be read/created or the archive can't
/// be written.
pub fn snapshot_now(config_dir: &Path, snapshots_dir: &Path, keep: u32) -> Result<PathBuf, String> {
    if !config_dir.exists() {
        return Err(format!(
            "config dir {} does not exist yet",
            config_dir.display()
        ));
    }
    std::fs::create_dir_all(snapshots_dir)
        .map_err(|e| format!("failed to create {}: {e}", snapshots_dir.display()))?;

    let stamp = utc_stamp();
    let final_path = snapshots_dir.join(format!("{ARCHIVE_PREFIX}{stamp}{ARCHIVE_SUFFIX}"));
    let tmp_path = snapshots_dir.join(format!(
        ".{ARCHIVE_PREFIX}{stamp}.tmp-{}",
        std::process::id()
    ));

    let file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("failed to create {}: {e}", tmp_path.display()))?;
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    let result = vault::append_dir_filtered(&mut tar, config_dir, Path::new("setu-config"))
        .and_then(|()| {
            tar.into_inner()
                .map_err(|e| format!("failed to finish archive: {e}"))?
                .finish()
                .map_err(|e| format!("failed to finish gzip: {e}"))?
                .sync_all()
                .map_err(|e| format!("failed to flush {}: {e}", tmp_path.display()))
        });
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    std::fs::rename(&tmp_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("failed to move {} into place: {e}", tmp_path.display())
    })?;

    prune(snapshots_dir, keep)?;
    Ok(final_path)
}

/// When the newest snapshot was taken (its mtime), or `None` when there
/// are no snapshots yet.
pub fn latest_snapshot_time(snapshots_dir: &Path) -> Option<SystemTime> {
    list_archives(snapshots_dir)
        .ok()?
        .into_iter()
        .map(|(_, mtime)| mtime)
        .max()
}

/// Deletes all but the newest `keep` archives.
///
/// # Errors
///
/// Fails when the directory listing or a delete fails.
pub fn prune(snapshots_dir: &Path, keep: u32) -> Result<(), String> {
    let mut archives = list_archives(snapshots_dir)?;
    // Newest first; everything past `keep` goes.
    archives.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
    for (path, _) in archives.into_iter().skip(keep as usize) {
        std::fs::remove_file(&path)
            .map_err(|e| format!("failed to prune {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Lists `(path, mtime)` for every snapshot archive in `snapshots_dir`.
fn list_archives(snapshots_dir: &Path) -> Result<Vec<(PathBuf, SystemTime)>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(snapshots_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(format!("couldn't read {}: {e}", snapshots_dir.display())),
    };
    for entry in entries {
        let entry = entry.map_err(|e| format!("couldn't read {}: {e}", snapshots_dir.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(ARCHIVE_PREFIX) || !name.ends_with(ARCHIVE_SUFFIX) {
            continue;
        }
        let meta = entry
            .metadata()
            .map_err(|e| format!("couldn't stat {}: {e}", entry.path().display()))?;
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.push((entry.path(), mtime));
    }
    Ok(out)
}

/// Compact UTC stamp for archive names (`20260814-093104`).
fn utc_stamp() -> String {
    let format = time::macros::format_description!("[year][month][day]-[hour][minute][second]");
    time::OffsetDateTime::now_utc()
        .format(format)
        .unwrap_or_else(|_| format!("{}", fastrand::u64(..)))
}

/// The reach-style background scheduler: spawned once at app start, wakes
/// hourly or on [`SnapshotScheduler::poke`], and snapshots when due.
pub struct SnapshotScheduler {
    /// Early-wakeup signal (settings changed, manual snapshot taken).
    notify: Arc<Notify>,
    /// Guards against double-spawn.
    started: AtomicBool,
}

impl Default for SnapshotScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapshotScheduler {
    /// Creates an idle scheduler; nothing runs until [`Self::start`].
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            started: AtomicBool::new(false),
        }
    }

    /// Spawns the loop (first call only). The loop re-reads settings every
    /// pass, so it needs no restart when they change — a [`Self::poke`]
    /// just makes the next check immediate.
    pub fn start(&self, app: tauri::AppHandle) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let notify = Arc::clone(&self.notify);
        tauri::async_runtime::spawn(async move {
            loop {
                run_due_snapshot(&app);
                tokio::select! {
                    () = tokio::time::sleep(CHECK_INTERVAL) => {}
                    () = notify.notified() => {}
                }
            }
        });
    }

    /// Wakes the loop for an immediate due-check (call after settings
    /// change or a manual snapshot).
    pub fn poke(&self) {
        self.notify.notify_one();
    }
}

/// One scheduler pass: snapshot when enabled and due. Failures are logged
/// to stderr and retried next pass — a broken snapshot must never take
/// the app down.
fn run_due_snapshot(app: &tauri::AppHandle) {
    let store = app.state::<settings::SettingsStore>();
    let Ok(doc) = store.document() else {
        return; // Corrupt settings file; the Settings window surfaces it.
    };
    if !doc.snapshots.enabled {
        return;
    }
    let Ok(config_dir) = sync::SyncManager::default_dir() else {
        return;
    };
    let Some(snapshots_dir) = snapshots_dir(app) else {
        return;
    };
    let interval = Duration::from_secs(u64::from(doc.snapshots.interval_days) * 24 * 60 * 60);
    let due = match latest_snapshot_time(&snapshots_dir) {
        None => true,
        Some(last) => SystemTime::now()
            .duration_since(last)
            .map(|elapsed| elapsed >= interval)
            .unwrap_or(false),
    };
    if !due {
        return;
    }
    if let Err(e) = snapshot_now(&config_dir, &snapshots_dir, doc.snapshots.keep) {
        eprintln!("setu: scheduled snapshot failed: {e}");
    }
}

/// Where snapshots live: `<state dir>/snapshots` (`PLAN.md` §4 — never
/// synced).
pub fn snapshots_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("snapshots"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A config dir with a nested file, plus an empty snapshots dir.
    struct TempDirs {
        root: PathBuf,
    }

    impl TempDirs {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("setu-snap-{}", uuid::Uuid::new_v4()));
            let config = root.join("config");
            std::fs::create_dir_all(config.join("themes")).expect("mkdir");
            std::fs::create_dir_all(config.join(".git")).expect("mkdir");
            std::fs::write(config.join("hosts.toml"), "label = \"hermes\"\n").expect("write");
            std::fs::write(config.join("themes/basalt.json"), "{}\n").expect("write");
            std::fs::write(config.join(".git/config"), "[core]\n").expect("write");
            Self { root }
        }

        fn config(&self) -> PathBuf {
            self.root.join("config")
        }

        fn snaps(&self) -> PathBuf {
            self.root.join("snapshots")
        }
    }

    impl Drop for TempDirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn snapshot_creates_a_named_archive_with_contents_minus_git() {
        let t = TempDirs::new();
        let path = snapshot_now(&t.config(), &t.snaps(), 10).expect("snapshot");
        let name = path
            .file_name()
            .expect("name")
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with(ARCHIVE_PREFIX) && name.ends_with(ARCHIVE_SUFFIX));

        // Inspect the archive: config files in, .git out.
        let file = std::fs::File::open(&path).expect("open");
        let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
        let names: Vec<String> = archive
            .entries()
            .expect("entries")
            .map(|e| {
                e.expect("entry")
                    .path()
                    .expect("path")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(
            names.contains(&"setu-config/hosts.toml".to_string()),
            "{names:?}"
        );
        assert!(names.contains(&"setu-config/themes/basalt.json".to_string()));
        assert!(
            names.iter().all(|n| !n.contains(".git")),
            "git dir leaked: {names:?}"
        );
    }

    #[test]
    fn latest_time_tracks_the_newest_archive() {
        let t = TempDirs::new();
        assert!(latest_snapshot_time(&t.snaps()).is_none());
        snapshot_now(&t.config(), &t.snaps(), 10).expect("snapshot");
        assert!(latest_snapshot_time(&t.snaps()).is_some());
    }

    #[test]
    fn prune_keeps_the_newest_n() {
        let t = TempDirs::new();
        std::fs::create_dir_all(t.snaps()).expect("mkdir");
        // Fabricate five archives with strictly increasing mtimes.
        for i in 0..5 {
            let path = t
                .snaps()
                .join(format!("{ARCHIVE_PREFIX}2026010{i}-000000{ARCHIVE_SUFFIX}"));
            std::fs::write(&path, b"x").expect("write");
            let mtime = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000 + i * 1000);
            let file = std::fs::File::options()
                .append(true)
                .open(&path)
                .expect("open");
            file.set_modified(mtime).expect("set mtime");
        }
        prune(&t.snaps(), 2).expect("prune");
        let mut left: Vec<String> = list_archives(&t.snaps())
            .expect("list")
            .into_iter()
            .map(|(p, _)| p.file_name().expect("name").to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            vec![
                format!("{ARCHIVE_PREFIX}20260103-000000{ARCHIVE_SUFFIX}"),
                format!("{ARCHIVE_PREFIX}20260104-000000{ARCHIVE_SUFFIX}"),
            ]
        );
    }

    #[test]
    fn snapshot_prunes_as_it_goes() {
        let t = TempDirs::new();
        snapshot_now(&t.config(), &t.snaps(), 1).expect("first");
        // Same-second stamps collide on rename; nudge the clock's name by
        // waiting for a distinct second boundary only if needed.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        snapshot_now(&t.config(), &t.snaps(), 1).expect("second");
        assert_eq!(list_archives(&t.snaps()).expect("list").len(), 1);
    }

    #[test]
    fn missing_config_dir_is_a_readable_error() {
        let t = TempDirs::new();
        let missing = t.root.join("nope");
        let err = snapshot_now(&missing, &t.snaps(), 10).expect_err("must fail");
        assert!(err.contains("does not exist"), "got: {err}");
    }
}
