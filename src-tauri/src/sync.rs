//! Git sync of the config dir (F10, Phase 8).
//!
//! `~/.config/setu` is the sync unit (`PLAN.md` §4): plain TOML, safe to
//! version, owned by the user. This module drives the **system `git`**
//! (§5: "git in config dir" — no libgit2) through short, prompt-free,
//! time-capped invocations:
//!
//! - [`SyncManager::status`] — the sidebar dot's five states (clean /
//!   ahead / behind / conflict / local), computed locally, no network.
//! - [`SyncManager::run`] — "Sync now": init-if-needed → secrets lint →
//!   `add -A` → commit `setu: <hostname> <ts>` → fetch → rebase → push.
//! - [`SyncManager::set_remote`] / [`SyncManager::abort_rebase`] — remote
//!   management and the one-click escape from a conflicted rebase.
//!
//! **Conflicts are never auto-resolved** (F10): a failing rebase is left
//! in progress so the markers are on disk for the user, the dot turns
//! `conflict`, and "Cancel sync" runs `git rebase --abort`.
//!
//! **The secrets lint runs before anything is staged** and refuses the
//! whole sync when any working-tree file matches the F10 heuristics
//! (secret-key assignments, PEM private-key headers, long base64 runs),
//! reporting each offending line. Public-key material is allow-listed —
//! `hosts.toml` legitimately carries it.
//!
//! Every git call runs with `GIT_TERMINAL_PROMPT=0` and
//! `GIT_SSH_COMMAND="ssh -oBatchMode=yes"` under a 30s cap, so a dead
//! network or an auth prompt becomes a fast, readable error — never a
//! hung UI or a stuck quit.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;

use crate::binaries;

/// Cap on any single git invocation (fetch/push over a bad link included).
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Longest offending-line excerpt shown in a lint block (characters).
const LINT_EXCERPT_CHARS: usize = 160;

/// The sidebar dot's state (F10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Nothing to sync: no local changes, no known remote news.
    Clean,
    /// Local commits or uncommitted edits waiting to sync.
    Ahead,
    /// The remote has commits this machine hasn't rebased onto yet
    /// (also reported when histories have diverged — pull comes first).
    Behind,
    /// A rebase stopped on conflicts and awaits the user (never
    /// auto-resolved).
    Conflict,
    /// No remote configured (or not a repo yet): local commits only.
    Local,
}

/// Result of `git_sync_status` — everything the footer dot, its popover,
/// and the Settings sync section display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncStatus {
    /// The dot state.
    pub state: SyncState,
    /// The `origin` URL, when configured (absent — never `null` — in the
    /// serialized payload, matching the contract's optional field).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// Whether the working tree has uncommitted changes.
    pub dirty: bool,
    /// Local commits the remote doesn't have (0 when unknown).
    pub ahead: u32,
    /// Remote commits this machine hasn't rebased onto (as of the last
    /// fetch; 0 when unknown).
    pub behind: u32,
    /// Files with unresolved conflict markers while [`SyncState::Conflict`].
    pub conflict_files: Vec<String>,
    /// Unix time of the newest local commit (the popover's "last synced"
    /// line), when any commit exists. Absent when none, like `remote_url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_ts: Option<i64>,
}

/// Which lint heuristic matched (F10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LintRule {
    /// An assignment to a password/token/secret-ish key with a non-trivial
    /// value.
    SecretAssignment,
    /// A PEM private-key header.
    PemPrivateKey,
    /// A base64 run of 40+ characters (public-key lines are allow-listed).
    Base64Run,
}

/// One line the secrets lint refused to commit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedLine {
    /// Path relative to the config dir.
    pub file: String,
    /// 1-based line number.
    pub line_no: u32,
    /// The offending line (excerpted to a readable length).
    pub line: String,
    /// The heuristic that matched.
    pub rule: LintRule,
}

/// Result of `git_sync_run`. Expected failures ride result-side (hosts /
/// forwards precedent): a lint block fills `blocked`, a conflicted rebase
/// fills `conflict_files`, network/auth trouble fills `message`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncRunResult {
    /// Whether the sync completed (through push, or through commit when no
    /// remote is configured).
    pub ok: bool,
    /// Fresh status after whatever happened.
    pub status: GitSyncStatus,
    /// Lines the secrets lint refused (the sync did not stage anything).
    pub blocked: Vec<BlockedLine>,
    /// Conflicted files when a rebase stopped; the rebase is left in
    /// progress for the user.
    pub conflict_files: Vec<String>,
    /// Human-readable failure description for everything else (fetch/push
    /// errors and the like).
    pub message: Option<String>,
}

/// Drives git in the config dir. One instance is managed by Tauri; a run
/// lock serializes mutating operations so two "Sync now" clicks (or a
/// quit-hook sync racing a click) can't interleave.
pub struct SyncManager {
    /// The config dir (`~/.config/setu`) — every git call runs in here.
    config_dir: PathBuf,
    /// Serializes mutating git sequences.
    run_lock: tokio::sync::Mutex<()>,
    /// Extra environment for every git call (test isolation).
    extra_env: Vec<(String, String)>,
}

impl SyncManager {
    /// Creates a manager over `config_dir`. Nothing touches the directory
    /// until a command runs.
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            config_dir,
            run_lock: tokio::sync::Mutex::new(()),
            extra_env: Vec::new(),
        }
    }

    /// Test constructor: like [`SyncManager::new`] plus environment
    /// overrides applied to every git call (used to null out global/system
    /// git config so tests are hermetic).
    #[cfg(test)]
    fn with_env(config_dir: PathBuf, extra_env: Vec<(String, String)>) -> Self {
        Self {
            config_dir,
            run_lock: tokio::sync::Mutex::new(()),
            extra_env,
        }
    }

    /// The canonical config dir (`~/.config/setu`, `PLAN.md` §4).
    ///
    /// # Errors
    ///
    /// Fails when the home directory cannot be determined.
    pub fn default_dir() -> Result<PathBuf, String> {
        dirs::home_dir()
            .map(|home| home.join(".config/setu"))
            .ok_or_else(|| "cannot determine home directory".to_string())
    }

    /// Computes the dot state locally — no network, safe to call often.
    ///
    /// # Errors
    ///
    /// Fails when git is missing or a git call itself fails unexpectedly
    /// (expected conditions — no repo, no remote, no commits — are states,
    /// not errors).
    pub async fn status(&self) -> Result<GitSyncStatus, String> {
        if !self.config_dir.join(".git").exists() {
            return Ok(GitSyncStatus {
                state: SyncState::Local,
                remote_url: None,
                dirty: false,
                ahead: 0,
                behind: 0,
                conflict_files: Vec::new(),
                last_commit_ts: None,
            });
        }

        let conflicted = self.rebase_in_progress();
        let conflict_files = if conflicted {
            self.conflicted_files().await.unwrap_or_default()
        } else {
            Vec::new()
        };
        let remote_url = self.remote_url().await;
        let dirty = !self
            .git_stdout(&["status", "--porcelain"])
            .await?
            .trim()
            .is_empty();
        let last_commit_ts = self
            .git_stdout(&["log", "-1", "--format=%ct"])
            .await
            .ok()
            .and_then(|out| out.trim().parse::<i64>().ok());

        let (ahead, behind) = self.ahead_behind(remote_url.is_some()).await;
        let state = if conflicted {
            SyncState::Conflict
        } else if remote_url.is_none() {
            SyncState::Local
        } else if behind > 0 {
            SyncState::Behind
        } else if ahead > 0 || dirty {
            SyncState::Ahead
        } else {
            SyncState::Clean
        };
        Ok(GitSyncStatus {
            state,
            remote_url,
            dirty,
            ahead,
            behind,
            conflict_files,
            last_commit_ts,
        })
    }

    /// "Sync now" (F10): lint → stage → commit → fetch → rebase → push.
    ///
    /// With no remote configured the run stops after the commit (local
    /// mode, still `ok`). A lint block or a conflicted rebase comes back
    /// `ok: false` with the details result-side; the conflicted rebase is
    /// **left in progress** on purpose. When the user has fixed the
    /// conflicted files (F10's documented path: edit, then Sync now
    /// again), the same click finishes the paused rebase — user-driven
    /// resolution, never automatic: files that still carry unresolved
    /// conflicts refuse politely.
    ///
    /// # Errors
    ///
    /// Fails only on infrastructure problems (git missing, IO); everything
    /// the user can act on is in the returned [`GitSyncRunResult`].
    pub async fn run(&self, hostname: &str) -> Result<GitSyncRunResult, String> {
        let _guard = self.run_lock.lock().await;

        let blocked = lint_dir(&self.config_dir)?;
        if !blocked.is_empty() {
            return Ok(GitSyncRunResult {
                ok: false,
                status: self.status().await?,
                blocked,
                conflict_files: Vec::new(),
                message: None,
            });
        }

        if self.config_dir.join(".git").exists() && self.rebase_in_progress() {
            // The user came back after editing the conflicted files (F10's
            // documented path). Files still carrying conflict markers mean
            // the resolution isn't done — keep waiting, never resolve for
            // them. The check reads content, not git's unmerged flag: the
            // flag would clear on `add` no matter what the file says.
            let unmerged = self.conflicted_files().await?;
            let still_marked: Vec<String> = unmerged
                .into_iter()
                .filter(|file| {
                    std::fs::read_to_string(self.config_dir.join(file))
                        .map(|text| has_conflict_markers(&text))
                        .unwrap_or(false)
                })
                .collect();
            if !still_marked.is_empty() {
                return Ok(GitSyncRunResult {
                    ok: false,
                    status: self.status().await?,
                    blocked: Vec::new(),
                    conflict_files: still_marked,
                    message: Some(
                        "still conflicted — fix the markers (or cancel the sync) first".into(),
                    ),
                });
            }
            self.git_ok(&["add", "-A"]).await?;
            let cont = self.git(&["rebase", "--continue"]).await?;
            if !cont.status.success() {
                // Later commits in the replay conflicted in turn.
                let conflict_files = self.conflicted_files().await.unwrap_or_default();
                return Ok(GitSyncRunResult {
                    ok: false,
                    status: self.status().await?,
                    blocked: Vec::new(),
                    conflict_files,
                    message: Some("rebase stopped on conflicts".into()),
                });
            }
        }

        self.ensure_repo().await?;
        self.ensure_identity(hostname).await?;

        self.git_ok(&["add", "-A"]).await?;
        let staged = !self
            .git_stdout(&["diff", "--cached", "--name-only"])
            .await?
            .trim()
            .is_empty();
        if staged {
            let ts = now_rfc3339();
            let message = format!("setu: {hostname} {ts}");
            self.git_ok(&["commit", "-m", &message]).await?;
        }

        if self.remote_url().await.is_none() {
            return Ok(GitSyncRunResult {
                ok: true,
                status: self.status().await?,
                blocked: Vec::new(),
                conflict_files: Vec::new(),
                message: None,
            });
        }

        if let Err(e) = self.git_ok(&["fetch", "origin"]).await {
            return Ok(GitSyncRunResult {
                ok: false,
                status: self.status().await?,
                blocked: Vec::new(),
                conflict_files: Vec::new(),
                message: Some(format!("fetch failed: {e}")),
            });
        }

        let branch = self.branch().await?;
        let upstream = format!("refs/remotes/origin/{branch}");
        let upstream_exists = self
            .git(&["rev-parse", "--verify", "--quiet", &upstream])
            .await?
            .status
            .success();
        if upstream_exists {
            let rebase_target = format!("origin/{branch}");
            let rebase = self.git(&["rebase", &rebase_target]).await?;
            if !rebase.status.success() {
                // Left in progress by design (F10): the markers are the
                // user's to resolve; abort_rebase is the escape hatch.
                let conflict_files = self.conflicted_files().await.unwrap_or_default();
                return Ok(GitSyncRunResult {
                    ok: false,
                    status: self.status().await?,
                    blocked: Vec::new(),
                    conflict_files,
                    message: Some("rebase stopped on conflicts".into()),
                });
            }
        }

        if let Err(e) = self.git_ok(&["push", "-u", "origin", &branch]).await {
            return Ok(GitSyncRunResult {
                ok: false,
                status: self.status().await?,
                blocked: Vec::new(),
                conflict_files: Vec::new(),
                message: Some(format!("push failed: {e}")),
            });
        }

        Ok(GitSyncRunResult {
            ok: true,
            status: self.status().await?,
            blocked: Vec::new(),
            conflict_files: Vec::new(),
            message: None,
        })
    }

    /// Points `origin` at `url` (adding or updating), initializing the
    /// repo first if needed. An **empty** `url` removes the remote — the
    /// dot returns to `local`.
    ///
    /// # Errors
    ///
    /// Fails when the URL is malformed (whitespace, leading `-`) or git
    /// fails.
    pub async fn set_remote(&self, url: &str) -> Result<GitSyncStatus, String> {
        let _guard = self.run_lock.lock().await;
        let url = url.trim();
        if url.is_empty() {
            if self.config_dir.join(".git").exists() && self.remote_url().await.is_some() {
                self.git_ok(&["remote", "remove", "origin"]).await?;
            }
            return self.status().await;
        }
        if url.starts_with('-') || url.chars().any(char::is_whitespace) {
            return Err(format!("not a usable remote URL: {url}"));
        }
        self.ensure_repo().await?;
        if self.remote_url().await.is_some() {
            self.git_ok(&["remote", "set-url", "origin", url]).await?;
        } else {
            self.git_ok(&["remote", "add", "origin", url]).await?;
        }
        self.status().await
    }

    /// "Cancel sync": aborts the in-progress rebase, restoring the
    /// pre-sync state.
    ///
    /// # Errors
    ///
    /// Fails when no rebase is in progress or git fails.
    pub async fn abort_rebase(&self) -> Result<GitSyncStatus, String> {
        let _guard = self.run_lock.lock().await;
        self.git_ok(&["rebase", "--abort"]).await?;
        self.status().await
    }

    /// Whether a rebase (either backend) is paused in this repo.
    fn rebase_in_progress(&self) -> bool {
        let git = self.config_dir.join(".git");
        git.join("rebase-merge").exists() || git.join("rebase-apply").exists()
    }

    /// Files with unresolved conflict markers during a paused rebase.
    async fn conflicted_files(&self) -> Result<Vec<String>, String> {
        Ok(self
            .git_stdout(&["diff", "--name-only", "--diff-filter=U"])
            .await?
            .lines()
            .map(str::to_string)
            .collect())
    }

    /// The `origin` URL, when configured (readable failure means none).
    async fn remote_url(&self) -> Option<String> {
        let out = self.git(&["remote", "get-url", "origin"]).await.ok()?;
        if !out.status.success() {
            return None;
        }
        let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!url.is_empty()).then_some(url)
    }

    /// `(ahead, behind)` counts vs `origin/<branch>`; zeros when unknown
    /// (no remote, no upstream ref, or no commits yet — except the
    /// no-upstream case, where every local commit counts as ahead).
    async fn ahead_behind(&self, has_remote: bool) -> (u32, u32) {
        let Ok(branch) = self.branch().await else {
            return (0, 0);
        };
        if !has_remote {
            return (0, 0);
        }
        let upstream = format!("refs/remotes/origin/{branch}");
        let upstream_exists = match self
            .git(&["rev-parse", "--verify", "--quiet", &upstream])
            .await
        {
            Ok(out) => out.status.success(),
            Err(_) => false,
        };
        if !upstream_exists {
            // Remote configured but never fetched/pushed this branch:
            // everything committed locally is waiting to go up.
            let ahead = self
                .git_stdout(&["rev-list", "--count", "HEAD"])
                .await
                .ok()
                .and_then(|out| out.trim().parse().ok())
                .unwrap_or(0);
            return (ahead, 0);
        }
        let range = format!("origin/{branch}...HEAD");
        let Ok(counts) = self
            .git_stdout(&["rev-list", "--left-right", "--count", &range])
            .await
        else {
            return (0, 0);
        };
        let mut parts = counts.split_whitespace();
        let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        (ahead, behind)
    }

    /// The checked-out branch name (works before the first commit).
    async fn branch(&self) -> Result<String, String> {
        Ok(self
            .git_stdout(&["symbolic-ref", "--short", "HEAD"])
            .await?
            .trim()
            .to_string())
    }

    /// Initializes the repo and seeds `.gitignore` on first use.
    async fn ensure_repo(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.config_dir)
            .map_err(|e| format!("failed to create {}: {e}", self.config_dir.display()))?;
        if !self.config_dir.join(".git").exists() {
            self.git_ok(&["init"]).await?;
        }
        let gitignore = self.config_dir.join(".gitignore");
        if !gitignore.exists() {
            std::fs::write(&gitignore, ".DS_Store\n")
                .map_err(|e| format!("failed to write {}: {e}", gitignore.display()))?;
        }
        Ok(())
    }

    /// Ensures a commit identity exists, falling back to a repo-local
    /// `setu <setu@hostname>` so sync works without global git config.
    async fn ensure_identity(&self, hostname: &str) -> Result<(), String> {
        let has_email = self
            .git(&["config", "user.email"])
            .await
            .map(|out| out.status.success() && !out.stdout.is_empty())
            .unwrap_or(false);
        if !has_email {
            self.git_ok(&["config", "user.name", "setu"]).await?;
            let email = format!("setu@{hostname}");
            self.git_ok(&["config", "user.email", &email]).await?;
        }
        Ok(())
    }

    /// Runs git with `args`, requiring success; returns trimmed-nothing
    /// stdout and folds stderr into the error message.
    async fn git_ok(&self, args: &[&str]) -> Result<String, String> {
        let out = self.git(args).await?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "git {} failed: {}",
                args.first().unwrap_or(&"?"),
                stderr.trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Like [`SyncManager::git_ok`] but only the stdout is wanted.
    async fn git_stdout(&self, args: &[&str]) -> Result<String, String> {
        self.git_ok(args).await
    }

    /// Runs one prompt-free, time-capped git invocation in the config dir.
    async fn git(&self, args: &[&str]) -> Result<std::process::Output, String> {
        let git = binaries::find("git").ok_or_else(|| {
            "git not found — install Xcode command line tools or Homebrew git".to_string()
        })?;
        let mut cmd = tokio::process::Command::new(git);
        cmd.args(args)
            .current_dir(&self.config_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
            // `rebase --continue` must take its default message instead of
            // parking the process inside an editor nobody can see.
            .env("GIT_EDITOR", "true")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &self.extra_env {
            cmd.env(key, value);
        }
        let subcommand = args.first().copied().unwrap_or("?");
        match tokio::time::timeout(GIT_TIMEOUT, cmd.output()).await {
            Ok(Ok(out)) => Ok(out),
            Ok(Err(e)) => Err(format!("failed to run git {subcommand}: {e}")),
            Err(_) => Err(format!(
                "git {subcommand} timed out after {}s",
                GIT_TIMEOUT.as_secs()
            )),
        }
    }
}

/// The device's short hostname for commit messages (`setu: <hostname> <ts>`).
pub fn device_hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

/// The current UTC time as RFC 3339 (`2026-08-14T09:31:04Z`).
fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "unknown-time".into())
}

/// Lints every regular file under `dir` (skipping `.git` and symlinks,
/// the vault-walk rules) against the F10 secret heuristics.
///
/// # Errors
///
/// Fails when the directory can't be walked or a file can't be read.
pub fn lint_dir(dir: &Path) -> Result<Vec<BlockedLine>, String> {
    let mut blocked = Vec::new();
    if dir.exists() {
        lint_walk(dir, Path::new(""), &mut blocked)?;
    }
    Ok(blocked)
}

/// Recursive worker for [`lint_dir`].
fn lint_walk(dir: &Path, prefix: &Path, out: &mut Vec<BlockedLine>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("couldn't read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("couldn't read {}: {e}", dir.display()))?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        let rel = prefix.join(&name);
        let kind = entry
            .file_type()
            .map_err(|e| format!("couldn't stat {}: {e}", path.display()))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            lint_walk(&path, &rel, out)?;
        } else {
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
            let text = String::from_utf8_lossy(&bytes);
            lint_text(&rel.to_string_lossy(), &text, out);
        }
    }
    Ok(())
}

/// Scans one file's text, appending every offending line to `out`.
fn lint_text(file: &str, text: &str, out: &mut Vec<BlockedLine>) {
    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let rule = if is_secret_assignment(line) {
            Some(LintRule::SecretAssignment)
        } else if pem_re().is_match(line) {
            Some(LintRule::PemPrivateKey)
        } else if base64_re().is_match(line) && !is_public_key_line(line) {
            Some(LintRule::Base64Run)
        } else {
            None
        };
        if let Some(rule) = rule {
            out.push(BlockedLine {
                file: file.to_string(),
                line_no: (idx + 1) as u32,
                line: excerpt(raw),
                rule,
            });
        }
    }
}

/// Whether `line` assigns a non-trivial value to a secret-ish key.
///
/// Boolean and purely numeric values pass — `use_password_auth = true` is
/// configuration, not a credential.
fn is_secret_assignment(line: &str) -> bool {
    let Some(caps) = secret_re().captures(line) else {
        return false;
    };
    let value = caps
        .get(1)
        .map(|m| m.as_str().trim().trim_matches(['"', '\'']))
        .unwrap_or("");
    if value.is_empty() {
        return false;
    }
    let lowered = value.to_ascii_lowercase();
    if lowered == "true" || lowered == "false" || value.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    true
}

/// Whether `text` still contains git conflict markers (an unresolved
/// hand-merge; `run` keeps refusing while any remain).
fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|line| {
        line.starts_with("<<<<<<< ") || line == "=======" || line.starts_with(">>>>>>> ")
    })
}

/// Whether `line` carries an SSH public key (allow-listed base64).
fn is_public_key_line(line: &str) -> bool {
    ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2", "sk-ssh-", "ssh-dss"]
        .iter()
        .any(|marker| line.contains(marker))
}

/// Assignment to a `password`/`token`/`secret`/`api_key`/`private_key`-ish
/// key; capture 1 is the value part.
fn secret_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)^\s*(?:export\s+)?["']?[\w.-]*(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)[\w.-]*["']?\s*[:=]\s*(.+)$"#,
        )
        .expect("static regex compiles")
    })
}

/// PEM private-key header.
fn pem_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----").expect("static regex compiles")
    })
}

/// A base64 run of 40+ characters (key/token material length).
fn base64_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9+/]{40,}={0,2}").expect("static regex compiles"))
}

/// Truncates `line` for display without splitting a character.
fn excerpt(line: &str) -> String {
    if line.chars().count() <= LINT_EXCERPT_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(LINT_EXCERPT_CHARS).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- lint heuristics -------------------------------------------------

    fn lint_lines(text: &str) -> Vec<BlockedLine> {
        let mut out = Vec::new();
        lint_text("test.toml", text, &mut out);
        out
    }

    #[test]
    fn password_assignment_is_blocked_with_the_line_shown() {
        let blocked = lint_lines("label = \"db\"\npassword = \"hunter2\"\n");
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].line_no, 2);
        assert_eq!(blocked[0].line, "password = \"hunter2\"");
        assert_eq!(blocked[0].rule, LintRule::SecretAssignment);
    }

    #[test]
    fn secret_key_variants_are_blocked() {
        for line in [
            "api_key: abc123def",
            "export GITHUB_TOKEN=ghp_abcdef",
            "aws_secret_access_key = \"wJalrXUtnFEMI\"",
            "smtp-passwd = 'p4ss'",
        ] {
            assert_eq!(lint_lines(line).len(), 1, "should block: {line}");
        }
    }

    #[test]
    fn ordinary_config_is_not_blocked() {
        let clean = "\
[[host]]\nid = \"9f2c\"\nlabel = \"hermes\"\nhostname = \"hermes.ts.net\"\n\
identity = \"agent\"\nuse_mosh = false\nport = 22\n";
        assert!(lint_lines(clean).is_empty());
    }

    #[test]
    fn boolean_and_numeric_secretish_values_pass() {
        assert!(lint_lines("use_password_auth = true\n").is_empty());
        assert!(lint_lines("token_ttl_seconds = 3600\n").is_empty());
        assert!(lint_lines("password = \"\"\n").is_empty());
    }

    #[test]
    fn comment_lines_pass() {
        assert!(lint_lines("# password = \"hunter2\"\n").is_empty());
    }

    #[test]
    fn pem_header_is_blocked() {
        let blocked = lint_lines("-----BEGIN OPENSSH PRIVATE KEY-----\n");
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].rule, LintRule::PemPrivateKey);
    }

    #[test]
    fn long_base64_run_is_blocked_but_public_keys_pass() {
        let b64 = "A".repeat(48);
        assert_eq!(lint_lines(&format!("blob = \"{b64}\"\n")).len(), 1);
        let pubkey = format!("authorized = \"ssh-ed25519 {b64} user@host\"\n");
        assert!(
            lint_lines(&pubkey).is_empty(),
            "pubkey must be allow-listed"
        );
    }

    #[test]
    fn uuids_are_too_short_to_trip_the_base64_rule() {
        assert!(lint_lines("id = \"9f2c4a10-77aa-4bd2-9e11-2b8f0c33d901\"\n").is_empty());
    }

    #[test]
    fn long_lines_are_excerpted_without_splitting_chars() {
        let long = format!("password = \"{}\"", "é".repeat(300));
        let blocked = lint_lines(&long);
        assert_eq!(blocked.len(), 1);
        assert!(blocked[0].line.ends_with('…'));
        assert!(blocked[0].line.chars().count() <= LINT_EXCERPT_CHARS + 1);
    }

    #[test]
    fn lint_dir_walks_files_and_skips_git_dir() {
        let dir = std::env::temp_dir().join(format!("setu-lint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".git")).expect("mkdir");
        std::fs::create_dir_all(dir.join("themes")).expect("mkdir");
        std::fs::write(dir.join("hosts.toml"), "password = \"hunter2\"\n").expect("write");
        std::fs::write(dir.join(".git/config"), "password = \"ignored\"\n").expect("write");
        std::fs::write(dir.join("themes/ok.toml"), "accent = \"#3BFF7E\"\n").expect("write");
        let blocked = lint_dir(&dir).expect("lint");
        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].file, "hosts.toml");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- git flows (hermetic: real git, temp dirs, no network) -----------

    /// A config dir + bare remote in a temp root, with git config nulled.
    struct TempSync {
        root: PathBuf,
        manager: SyncManager,
    }

    /// Environment that hides the developer's global/system git config.
    fn hermetic_env() -> Vec<(String, String)> {
        vec![
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_CONFIG_SYSTEM".into(), "/dev/null".into()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ]
    }

    impl TempSync {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("setu-sync-{}", uuid::Uuid::new_v4()));
            let config = root.join("config");
            std::fs::create_dir_all(&config).expect("mkdir");
            Self {
                manager: SyncManager::with_env(config, hermetic_env()),
                root,
            }
        }

        fn config_dir(&self) -> PathBuf {
            self.root.join("config")
        }

        /// Creates a bare remote and returns its `file://`-style path.
        fn make_remote(&self) -> String {
            let remote = self.root.join("remote.git");
            raw_git(&self.root, &["init", "--bare", "remote.git"]);
            remote.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempSync {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Runs git synchronously for test fixture plumbing (clones, pushes
    /// from a second checkout) with the same hermetic env.
    fn raw_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?} in {} failed: {}",
            dir.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// Commit identity args for raw fixture commits.
    fn raw_commit(dir: &Path, message: &str) {
        raw_git(dir, &["add", "-A"]);
        raw_git(
            dir,
            &[
                "-c",
                "user.name=fixture",
                "-c",
                "user.email=fixture@test",
                "commit",
                "-m",
                message,
            ],
        );
    }

    #[tokio::test]
    async fn fresh_dir_reports_local() {
        let t = TempSync::new();
        let status = t.manager.status().await.expect("status");
        assert_eq!(status.state, SyncState::Local);
        assert!(status.remote_url.is_none());
    }

    #[tokio::test]
    async fn run_without_remote_commits_locally() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "# hosts\n").expect("write");
        let result = t.manager.run("testhost").await.expect("run");
        assert!(result.ok, "message: {:?}", result.message);
        assert_eq!(result.status.state, SyncState::Local);
        assert!(result.status.last_commit_ts.is_some());
        let log = raw_git(&t.config_dir(), &["log", "-1", "--format=%s"]);
        assert!(log.starts_with("setu: testhost "), "got: {log}");
        // A second run with nothing new stays ok and commits nothing.
        let again = t.manager.run("testhost").await.expect("run");
        assert!(again.ok);
        let count = raw_git(&t.config_dir(), &["rev-list", "--count", "HEAD"]);
        assert_eq!(count.trim(), "1");
    }

    #[tokio::test]
    async fn run_with_remote_pushes_and_reports_clean() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "# hosts\n").expect("write");
        let remote = t.make_remote();
        t.manager.set_remote(&remote).await.expect("set remote");
        let result = t.manager.run("testhost").await.expect("run");
        assert!(result.ok, "message: {:?}", result.message);
        assert_eq!(result.status.state, SyncState::Clean);
        assert_eq!(result.status.ahead, 0);
        // The remote really has the commit.
        let log = raw_git(Path::new(&remote), &["log", "-1", "--format=%s"]);
        assert!(log.starts_with("setu: testhost "));
    }

    #[tokio::test]
    async fn second_checkout_reproduces_hosts_and_round_trips() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "label = \"hermes\"\n").expect("write");
        let remote = t.make_remote();
        t.manager.set_remote(&remote).await.expect("set remote");
        assert!(t.manager.run("machine-a").await.expect("run").ok);

        // Second machine: clone reproduces the hosts file (F10 acceptance).
        raw_git(&t.root, &["clone", &remote, "checkout-b"]);
        let b = t.root.join("checkout-b");
        let cloned = std::fs::read_to_string(b.join("hosts.toml")).expect("cloned file");
        assert_eq!(cloned, "label = \"hermes\"\n");

        // B edits and pushes; A's next sync rebases the edit in.
        std::fs::write(b.join("snippets.toml"), "# from b\n").expect("write");
        raw_commit(&b, "b: add snippets");
        raw_git(&b, &["push", "origin", "HEAD"]);
        let result = t.manager.run("machine-a").await.expect("run");
        assert!(result.ok, "message: {:?}", result.message);
        let pulled = std::fs::read_to_string(t.config_dir().join("snippets.toml"));
        assert_eq!(pulled.expect("pulled file"), "# from b\n");
    }

    #[tokio::test]
    async fn divergent_edits_conflict_is_left_in_place_and_abortable() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "port = 22\n").expect("write");
        let remote = t.make_remote();
        t.manager.set_remote(&remote).await.expect("set remote");
        assert!(t.manager.run("machine-a").await.expect("run").ok);

        // B rewrites the same line and pushes first.
        raw_git(&t.root, &["clone", &remote, "checkout-b"]);
        let b = t.root.join("checkout-b");
        std::fs::write(b.join("hosts.toml"), "port = 2222\n").expect("write");
        raw_commit(&b, "b: port 2222");
        raw_git(&b, &["push", "origin", "HEAD"]);

        // A rewrites it differently; the sync's rebase must stop.
        std::fs::write(t.config_dir().join("hosts.toml"), "port = 2200\n").expect("write");
        let result = t.manager.run("machine-a").await.expect("run");
        assert!(!result.ok);
        assert_eq!(result.conflict_files, vec!["hosts.toml".to_string()]);
        assert_eq!(result.status.state, SyncState::Conflict);
        // The rebase is genuinely still in progress (never auto-resolved)…
        let status = t.manager.status().await.expect("status");
        assert_eq!(status.state, SyncState::Conflict);
        assert_eq!(status.conflict_files, vec!["hosts.toml".to_string()]);
        // …and running sync again refuses politely instead of stacking.
        let again = t.manager.run("machine-a").await.expect("run");
        assert!(!again.ok);
        assert!(again.message.expect("message").contains("conflict"));
        // "Cancel sync" restores a non-conflicted state.
        let aborted = t.manager.abort_rebase().await.expect("abort");
        assert_ne!(aborted.state, SyncState::Conflict);
    }

    #[tokio::test]
    async fn fixed_markers_finish_the_paused_rebase_on_next_sync() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "port = 22\n").expect("write");
        let remote = t.make_remote();
        t.manager.set_remote(&remote).await.expect("set remote");
        assert!(t.manager.run("machine-a").await.expect("run").ok);

        raw_git(&t.root, &["clone", &remote, "checkout-b"]);
        let b = t.root.join("checkout-b");
        std::fs::write(b.join("hosts.toml"), "port = 2222\n").expect("write");
        raw_commit(&b, "b: port 2222");
        raw_git(&b, &["push", "origin", "HEAD"]);

        std::fs::write(t.config_dir().join("hosts.toml"), "port = 2200\n").expect("write");
        assert!(!t.manager.run("machine-a").await.expect("run").ok);
        assert_eq!(
            t.manager.status().await.expect("status").state,
            SyncState::Conflict
        );

        // Markers still present → the sync keeps refusing (never auto).
        let refused = t.manager.run("machine-a").await.expect("run");
        assert!(!refused.ok);
        assert!(refused.message.expect("message").contains("conflict"));

        // The user resolves by hand (F10's documented path), then Sync now
        // finishes the rebase and pushes.
        std::fs::write(t.config_dir().join("hosts.toml"), "port = 2222\n").expect("write");
        let finished = t.manager.run("machine-a").await.expect("run");
        assert!(finished.ok, "message: {:?}", finished.message);
        assert_eq!(finished.status.state, SyncState::Clean);
        let remote_file = raw_git(Path::new(&remote), &["show", "HEAD:hosts.toml"]);
        assert_eq!(remote_file, "port = 2222\n");
    }

    #[tokio::test]
    async fn lint_blocks_the_sync_before_anything_is_staged() {
        let t = TempSync::new();
        std::fs::write(
            t.config_dir().join("hosts.toml"),
            "label = \"db\"\npassword = \"hunter2\"\n",
        )
        .expect("write");
        let result = t.manager.run("testhost").await.expect("run");
        assert!(!result.ok);
        assert_eq!(result.blocked.len(), 1);
        assert_eq!(result.blocked[0].file, "hosts.toml");
        assert_eq!(result.blocked[0].line_no, 2);
        assert_eq!(result.blocked[0].line, "password = \"hunter2\"");
        // Nothing was initialized or committed.
        assert!(!t.config_dir().join(".git").exists());
    }

    #[tokio::test]
    async fn set_remote_add_update_remove() {
        let t = TempSync::new();
        let remote = t.make_remote();
        let status = t.manager.set_remote(&remote).await.expect("add");
        assert_eq!(status.remote_url.as_deref(), Some(remote.as_str()));
        let status = t.manager.set_remote(&remote).await.expect("update");
        assert_eq!(status.remote_url.as_deref(), Some(remote.as_str()));
        let status = t.manager.set_remote("").await.expect("remove");
        assert!(status.remote_url.is_none());
        assert_eq!(status.state, SyncState::Local);
        assert!(t.manager.set_remote("-oProxyCommand=evil").await.is_err());
        assert!(t.manager.set_remote("two words").await.is_err());
    }

    #[tokio::test]
    async fn dirty_tree_with_remote_reports_ahead() {
        let t = TempSync::new();
        std::fs::write(t.config_dir().join("hosts.toml"), "# hosts\n").expect("write");
        let remote = t.make_remote();
        t.manager.set_remote(&remote).await.expect("set remote");
        assert!(t.manager.run("testhost").await.expect("run").ok);
        std::fs::write(t.config_dir().join("hosts.toml"), "# edited\n").expect("write");
        let status = t.manager.status().await.expect("status");
        assert_eq!(status.state, SyncState::Ahead);
        assert!(status.dirty);
    }

    #[test]
    fn device_hostname_is_nonempty() {
        assert!(!device_hostname().is_empty());
    }
}
