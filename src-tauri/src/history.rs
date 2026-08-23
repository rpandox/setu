//! Global command history (F12, Phase 10): `history.sqlite`.
//!
//! Every command the semantic terminal sees complete (OSC 133 D after a
//! 633;E) is recorded as one row — `ts, host, cwd, cmd, exit, duration` —
//! in a local rusqlite database under the app-support directory
//! (PLAN.md §4). It is **device-local by construction**: the file lives
//! outside `~/.config/setu`, so neither git sync nor the vault export ever
//! carries it (§5, command-history row; CLAUDE.md hard rules).
//!
//! Privacy gates live here too, not only in the UI: [`HistoryStore::add`]
//! refuses rows while the global `[history] enabled` toggle is off, and
//! the IPC layer drops rows for incognito hosts before they reach the
//! store. Alt-screen output is never a *command*, so it is never recorded —
//! the frontend only reports completed prompt-to-prompt commands.
//!
//! Search is a `LIKE`-per-token AND over `cmd`, `host`, and `cwd`, newest
//! first, capped by the caller — fast enough past 100k rows with the index
//! on `ts` (the §5 row's bar).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// One recorded command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// Row id (assigned on insert; `0` on a draft).
    pub id: i64,
    /// Completion time, Unix milliseconds.
    pub ts: i64,
    /// Host label (`"local"` for local shells).
    pub host: String,
    /// Working directory when the command ran (from OSC 7; empty if unknown).
    pub cwd: String,
    /// The command line as the shell reported it.
    pub cmd: String,
    /// Exit status (`None` when the shell reported none).
    pub exit: Option<i32>,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: i64,
}

/// The history database handle. One per app; `Connection` is not `Sync`,
/// so the mutex serializes commands (all are sub-millisecond).
pub struct HistoryStore {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl HistoryStore {
    /// Opens (creating if needed) the database at `path` and applies the
    /// schema.
    ///
    /// # Errors
    ///
    /// Returns the SQLite error text when the file cannot be opened or the
    /// schema cannot be applied (e.g. the directory is unwritable).
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
        Self::from_connection(conn, path.to_path_buf())
    }

    /// An in-memory store for tests and previews.
    ///
    /// # Errors
    ///
    /// Only if SQLite itself fails to create an in-memory database.
    pub fn in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::from_connection(conn, PathBuf::from(":memory:"))
    }

    fn from_connection(conn: Connection, path: PathBuf) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS commands (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               ts INTEGER NOT NULL,
               host TEXT NOT NULL,
               cwd TEXT NOT NULL,
               cmd TEXT NOT NULL,
               exit INTEGER,
               duration_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS commands_ts ON commands (ts DESC);",
        )
        .map_err(|e| format!("history schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// Where the database lives (`:memory:` for test stores).
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records one completed command. Returns the new row id.
    ///
    /// `enabled` is the global `[history] enabled` toggle: when false the
    /// row is dropped and `Ok(None)` is returned — the caller treats both
    /// outcomes as success, the gate is simply enforced here as well as in
    /// the UI.
    ///
    /// # Errors
    ///
    /// SQLite insert failures (disk full, corrupt file).
    pub fn add(&self, entry: &HistoryEntry, enabled: bool) -> Result<Option<i64>, String> {
        if !enabled || entry.cmd.trim().is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock().map_err(|_| "history lock poisoned")?;
        conn.execute(
            "INSERT INTO commands (ts, host, cwd, cmd, exit, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.ts,
                entry.host,
                entry.cwd,
                entry.cmd,
                entry.exit,
                entry.duration_ms
            ],
        )
        .map_err(|e| format!("history insert: {e}"))?;
        Ok(Some(conn.last_insert_rowid()))
    }

    /// Searches history: every whitespace-separated token of `query` must
    /// appear (case-insensitively) in `cmd`, `host`, or `cwd`. An empty
    /// query lists the newest rows. Results are newest first, at most
    /// `limit`.
    ///
    /// # Errors
    ///
    /// SQLite query failures.
    pub fn query(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>, String> {
        let tokens: Vec<String> = query
            .split_whitespace()
            .map(|t| format!("%{}%", escape_like(t)))
            .collect();
        let mut sql =
            String::from("SELECT id, ts, host, cwd, cmd, exit, duration_ms FROM commands");
        for (i, _) in tokens.iter().enumerate() {
            sql.push_str(if i == 0 { " WHERE " } else { " AND " });
            let n = i + 1;
            sql.push_str(&format!(
                "(cmd LIKE ?{n} ESCAPE '\\' OR host LIKE ?{n} ESCAPE '\\' OR cwd LIKE ?{n} ESCAPE '\\')"
            ));
        }
        sql.push_str(&format!(
            " ORDER BY ts DESC, id DESC LIMIT {}",
            limit.min(1000)
        ));
        let conn = self.conn.lock().map_err(|_| "history lock poisoned")?;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("history query: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(tokens.iter()), |row| {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    host: row.get(2)?,
                    cwd: row.get(3)?,
                    cmd: row.get(4)?,
                    exit: row.get(5)?,
                    duration_ms: row.get(6)?,
                })
            })
            .map_err(|e| format!("history query: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("history row: {e}"))
    }

    /// Total rows — the "DB row count proves it" evidence for the
    /// incognito acceptance item.
    ///
    /// # Errors
    ///
    /// SQLite query failures.
    pub fn count(&self) -> Result<i64, String> {
        let conn = self.conn.lock().map_err(|_| "history lock poisoned")?;
        conn.query_row("SELECT COUNT(*) FROM commands", [], |r| r.get(0))
            .optional()
            .map_err(|e| format!("history count: {e}"))
            .map(|n| n.unwrap_or(0))
    }

    /// Deletes every row (the "Clear history" control).
    ///
    /// # Errors
    ///
    /// SQLite failures.
    pub fn clear(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "history lock poisoned")?;
        conn.execute("DELETE FROM commands", [])
            .map(|_| ())
            .map_err(|e| format!("history clear: {e}"))
    }
}

/// Escapes `LIKE` metacharacters so a search for `50%` means fifty percent.
fn escape_like(token: &str) -> String {
    token
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: i64, host: &str, cmd: &str) -> HistoryEntry {
        HistoryEntry {
            id: 0,
            ts,
            host: host.into(),
            cwd: "/home/u".into(),
            cmd: cmd.into(),
            exit: Some(0),
            duration_ms: 12,
        }
    }

    #[test]
    fn add_query_newest_first_and_tokens_and() {
        let store = HistoryStore::in_memory().unwrap();
        store.add(&entry(1, "hermes", "ls -la"), true).unwrap();
        store.add(&entry(2, "local", "git status"), true).unwrap();
        store.add(&entry(3, "hermes", "git log"), true).unwrap();
        let all = store.query("", 10).unwrap();
        assert_eq!(all.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![3, 2, 1]);
        let git_hermes = store.query("git hermes", 10).unwrap();
        assert_eq!(git_hermes.len(), 1);
        assert_eq!(git_hermes[0].cmd, "git log");
        assert_eq!(store.query("GIT", 1).unwrap().len(), 1);
        assert_eq!(store.count().unwrap(), 3);
    }

    #[test]
    fn disabled_toggle_and_blank_commands_record_nothing() {
        let store = HistoryStore::in_memory().unwrap();
        assert_eq!(store.add(&entry(1, "h", "ls"), false).unwrap(), None);
        assert_eq!(store.add(&entry(1, "h", "   "), true).unwrap(), None);
        assert_eq!(store.count().unwrap(), 0);
    }

    #[test]
    fn like_metacharacters_are_literal() {
        let store = HistoryStore::in_memory().unwrap();
        store.add(&entry(1, "h", "df -h | grep 50%"), true).unwrap();
        store.add(&entry(2, "h", "df -h | grep 500"), true).unwrap();
        assert_eq!(store.query("50%", 10).unwrap().len(), 1);
        assert_eq!(store.query("a_b", 10).unwrap().len(), 0);
    }

    #[test]
    fn clear_empties_and_file_store_round_trips() {
        let dir = std::env::temp_dir().join(format!("setu-history-{}", uuid::Uuid::new_v4()));
        let path = dir.join("history.sqlite");
        {
            let store = HistoryStore::open(&path).unwrap();
            store.add(&entry(1, "h", "uptime"), true).unwrap();
        }
        let store = HistoryStore::open(&path).unwrap();
        assert_eq!(store.count().unwrap(), 1);
        store.clear().unwrap();
        assert_eq!(store.count().unwrap(), 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
