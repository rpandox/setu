//! Device-local UI state — `state.json` in the app-support directory.
//!
//! The first tenant of `~/Library/Application Support/dev.pandox.setu/`
//! (`PLAN.md` §4): window/session-restore state and UI preferences that are
//! deliberately **not** part of the `~/.config/setu` sync unit — they
//! describe *this machine's* windows, not the user's fleet. Phase 3 stores
//! the sidebar collapse set (migrated out of localStorage), the broadcast
//! auto-disarm flag, the session-restore opt-in, and the saved tab/split
//! layout (F4).
//!
//! Same write discipline as the hosts store ([`crate::store`]): atomic
//! temp-file + rename saves, and a corrupt file is never overwritten — reads
//! and writes fail loudly until the user repairs or deletes it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Split orientation in a saved layout (mirrors `SplitDir` in `splits.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SavedSplitDir {
    /// Panes side by side (⌘D).
    Row,
    /// Panes stacked (⇧⌘D).
    Col,
}

/// A node in a saved split tree (mirrors `SavedSplitNode` in `contract.ts`).
///
/// Leaves carry a connection target, not live session ids: `host_id` names
/// a host to reconnect on restore, `None` means a fresh local shell. Pane
/// and session ids are minted anew on restore.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SavedSplitNode {
    /// One pane.
    #[serde(rename_all = "camelCase")]
    Leaf {
        /// The host to reconnect (`Host.id`), or `None` for a local shell.
        #[serde(default)]
        host_id: Option<String>,
    },
    /// Two children sharing the rectangle at `ratio`.
    #[serde(rename_all = "camelCase")]
    Split {
        /// Orientation of the divide.
        dir: SavedSplitDir,
        /// Share of the rectangle given to `a` (0–1).
        ratio: f64,
        /// First child: left (`row`) or top (`col`).
        a: Box<SavedSplitNode>,
        /// Second child: right (`row`) or bottom (`col`).
        b: Box<SavedSplitNode>,
    },
}

/// One saved tab (mirrors `SavedTab` in `contract.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    /// The tab's split tree.
    pub layout: SavedSplitNode,
}

/// Sidebar view state (mirrors `SidebarUiState` in `contract.ts`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SidebarUiState {
    /// Collapsed section keys (`"favorites"`, `"group:<name>"`, …).
    pub collapsed_sections: Vec<String>,
}

/// The `state.json` schema (mirrors `UiState` in `contract.ts`).
///
/// Every field has a serde default, so files written by older builds — or a
/// hand-trimmed file — load cleanly; unknown future fields are ignored on
/// read and dropped on the next write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiState {
    /// Schema version; bumped only on incompatible changes. Currently `1`.
    pub version: u32,
    /// Sidebar view state.
    pub sidebar: SidebarUiState,
    /// Disarm broadcast when the active tab changes (F4 safety, default on).
    pub broadcast_auto_disarm: bool,
    /// Reopen the saved layout on launch (F4 session restore, opt-in).
    pub restore_on_launch: bool,
    /// The saved tab/split layout, updated as tabs change.
    pub saved_layout: Vec<SavedTab>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            version: 1,
            sidebar: SidebarUiState::default(),
            broadcast_auto_disarm: true,
            restore_on_launch: false,
            saved_layout: Vec::new(),
        }
    }
}

/// Thread-safe accessor for `state.json`, managed as Tauri state.
///
/// Reads cache the parsed file; writes replace the whole document
/// atomically. A file that exists but fails to parse poisons nothing: every
/// read and write returns the parse error until the file is fixed or
/// removed, and the corrupt content is never overwritten.
pub struct UiStateStore {
    /// Absolute path of `state.json`.
    path: PathBuf,
    /// Parsed state; `None` until first load.
    cache: Mutex<Option<UiState>>,
}

impl UiStateStore {
    /// Creates a store over `path`. Nothing is read until first use.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(None),
        }
    }

    /// Returns the current state (loading the file on first call). A
    /// missing file is the default state, not an error.
    ///
    /// # Errors
    ///
    /// Fails when the file exists but cannot be read or parsed.
    pub fn get(&self) -> Result<UiState, String> {
        let mut cache = self.cache.lock().expect("ui state cache poisoned");
        self.ensure_loaded(&mut cache)?;
        Ok(cache.as_ref().expect("loaded above").clone())
    }

    /// Replaces the whole document and saves it atomically.
    ///
    /// # Errors
    ///
    /// Fails when the existing file cannot be read or parsed (a corrupt
    /// file is never overwritten — fix or delete it first), or the save
    /// itself fails.
    pub fn set(&self, state: UiState) -> Result<(), String> {
        let mut cache = self.cache.lock().expect("ui state cache poisoned");
        self.ensure_loaded(&mut cache)?;
        save_atomic(&self.path, &state)?;
        *cache = Some(state);
        Ok(())
    }

    /// Loads the file into `cache` if it has not been loaded yet.
    fn ensure_loaded(&self, cache: &mut Option<UiState>) -> Result<(), String> {
        if cache.is_some() {
            return Ok(());
        }
        let state = match fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str::<UiState>(&text)
                .map_err(|e| format!("failed to parse {}: {e}", self.path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => UiState::default(),
            Err(e) => return Err(format!("failed to read {}: {e}", self.path.display())),
        };
        *cache = Some(state);
        Ok(())
    }
}

/// Serializes `state` and writes the file atomically: temp file in the same
/// directory, then `rename` into place (same discipline as the hosts store).
fn save_atomic(path: &Path, state: &UiState) -> Result<(), String> {
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| format!("failed to serialize ui state: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("no parent directory for {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("state.json"),
        std::process::id()
    ));
    fs::write(&tmp, body).map_err(|e| format!("failed to write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup; the temp file is harmless if this fails too.
        let _ = fs::remove_file(&tmp);
        format!("failed to move {} into place: {e}", tmp.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store over a unique temp path, cleaned up on drop.
    struct TempStore {
        store: UiStateStore,
        dir: PathBuf,
    }

    impl TempStore {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("setu-ui-state-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self {
                store: UiStateStore::new(dir.join("state.json")),
                dir,
            }
        }

        fn path(&self) -> PathBuf {
            self.dir.join("state.json")
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn sample_state() -> UiState {
        UiState {
            version: 1,
            sidebar: SidebarUiState {
                collapsed_sections: vec!["favorites".into(), "group:fleet".into()],
            },
            broadcast_auto_disarm: false,
            restore_on_launch: true,
            saved_layout: vec![SavedTab {
                layout: SavedSplitNode::Split {
                    dir: SavedSplitDir::Row,
                    ratio: 0.4,
                    a: Box::new(SavedSplitNode::Leaf {
                        host_id: Some("host-1".into()),
                    }),
                    b: Box::new(SavedSplitNode::Leaf { host_id: None }),
                },
            }],
        }
    }

    #[test]
    fn missing_file_is_default_state() {
        let t = TempStore::new("missing");
        let state = t.store.get().expect("get");
        assert_eq!(state.version, 1);
        assert!(state.broadcast_auto_disarm);
        assert!(!state.restore_on_launch);
        assert!(state.saved_layout.is_empty());
    }

    #[test]
    fn set_then_get_round_trips() {
        let t = TempStore::new("roundtrip");
        t.store.set(sample_state()).expect("set");
        let state = t.store.get().expect("get");
        assert_eq!(
            state.sidebar.collapsed_sections,
            vec!["favorites", "group:fleet"]
        );
        assert!(!state.broadcast_auto_disarm);
        assert!(state.restore_on_launch);
        assert_eq!(state.saved_layout.len(), 1);
        match &state.saved_layout[0].layout {
            SavedSplitNode::Split { dir, ratio, a, b } => {
                assert_eq!(*dir, SavedSplitDir::Row);
                assert!((ratio - 0.4).abs() < 1e-9);
                assert!(matches!(
                    a.as_ref(),
                    SavedSplitNode::Leaf { host_id: Some(id) } if id == "host-1"
                ));
                assert!(matches!(b.as_ref(), SavedSplitNode::Leaf { host_id: None }));
            }
            SavedSplitNode::Leaf { .. } => panic!("expected a split root"),
        }
    }

    #[test]
    fn survives_a_reload_from_disk() {
        let t = TempStore::new("reload");
        t.store.set(sample_state()).expect("set");
        // A second store over the same path parses the file fresh.
        let reread = UiStateStore::new(t.path());
        assert!(reread.get().expect("get").restore_on_launch);
    }

    #[test]
    fn camel_case_and_kind_tags_on_disk() {
        let t = TempStore::new("shape");
        t.store.set(sample_state()).expect("set");
        let text = fs::read_to_string(t.path()).expect("read");
        assert!(text.contains("\"collapsedSections\""));
        assert!(text.contains("\"broadcastAutoDisarm\""));
        assert!(text.contains("\"restoreOnLaunch\""));
        assert!(text.contains("\"savedLayout\""));
        assert!(text.contains("\"kind\": \"leaf\""));
        assert!(text.contains("\"hostId\": \"host-1\""));
    }

    #[test]
    fn partial_files_fill_with_defaults() {
        let t = TempStore::new("partial");
        fs::create_dir_all(&t.dir).expect("mkdir");
        fs::write(t.path(), r#"{ "restoreOnLaunch": true }"#).expect("write");
        let state = t.store.get().expect("get");
        assert!(state.restore_on_launch);
        assert!(state.broadcast_auto_disarm); // default survived
        assert_eq!(state.version, 1);
    }

    #[test]
    fn corrupt_file_errors_and_is_never_overwritten() {
        let t = TempStore::new("corrupt");
        fs::create_dir_all(&t.dir).expect("mkdir");
        fs::write(t.path(), "{ not json").expect("write");
        assert!(t.store.get().is_err());
        assert!(t.store.set(sample_state()).is_err());
        assert_eq!(fs::read_to_string(t.path()).expect("read"), "{ not json");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let t = TempStore::new("atomic");
        t.store.set(sample_state()).expect("set");
        let leftovers: Vec<_> = fs::read_dir(&t.dir)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
