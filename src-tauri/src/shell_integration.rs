//! Shell integration installer (F12, Phase 10).
//!
//! The semantic terminal needs the shell to speak: OSC 133 A/B/C/D around
//! every prompt and command, OSC 7 with the working directory, and
//! `OSC 633;E` carrying the command line (PLAN.md §5, command-text
//! transport row). This module owns the snippet text for zsh, bash, and
//! fish, and the **fenced block** that carries it into an rc file:
//!
//! ```text
//! # >>> setu shell integration >>>
//! …snippet…
//! # <<< setu shell integration <<<
//! ```
//!
//! Everything here is a pure function over the rc file's *contents* — the
//! same code serves the local `~/.zshrc` and a remote `~/.bashrc` read over
//! SFTP (PLAN.md §5, remote-installer row). The IPC layer does the reading
//! and writing; this module decides what the file should say and renders
//! the exact diff the user confirms first (F12: "shows the exact diff of
//! the target rc file and appends only on confirm").
//!
//! Double installs are detected by the fence markers; uninstall removes
//! exactly the fenced block (and the one blank line the installer added
//! before it), leaving every other line intact — only the file's trailing
//! blank lines can differ from before the install, since the installer
//! normalizes the end of the file to one newline.

use serde::{Deserialize, Serialize};

/// The line that opens the fenced block.
pub const FENCE_START: &str = "# >>> setu shell integration >>>";
/// The line that closes the fenced block.
pub const FENCE_END: &str = "# <<< setu shell integration <<<";

/// The shells the installer knows how to integrate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    /// Z shell — `~/.zshrc`.
    Zsh,
    /// GNU bash — `~/.bashrc` (Ubuntu's interactive rc; macOS users on
    /// bash source it from `~/.bash_profile`).
    Bash,
    /// fish — `~/.config/fish/config.fish`.
    Fish,
}

impl Shell {
    /// The snippet text for this shell (embedded at build time from
    /// `assets/shell-integration/`).
    pub fn snippet(self) -> &'static str {
        match self {
            Shell::Zsh => include_str!("../../assets/shell-integration/setu.zsh"),
            Shell::Bash => include_str!("../../assets/shell-integration/setu.bash"),
            Shell::Fish => include_str!("../../assets/shell-integration/setu.fish"),
        }
    }

    /// The rc file this shell's snippet belongs in, relative to `$HOME`.
    pub fn rc_relative_path(self) -> &'static str {
        match self {
            Shell::Zsh => ".zshrc",
            Shell::Bash => ".bashrc",
            Shell::Fish => ".config/fish/config.fish",
        }
    }

    /// Parses a `$SHELL`-style path or bare name (`"/bin/zsh"`, `"bash"`).
    ///
    /// # Examples
    ///
    /// ```
    /// use setu_lib::shell_integration::Shell;
    /// assert_eq!(Shell::from_name("/usr/local/bin/fish"), Some(Shell::Fish));
    /// assert_eq!(Shell::from_name("tcsh"), None);
    /// ```
    pub fn from_name(name: &str) -> Option<Self> {
        match name.rsplit('/').next().unwrap_or(name) {
            "zsh" => Some(Shell::Zsh),
            "bash" => Some(Shell::Bash),
            "fish" => Some(Shell::Fish),
            _ => None,
        }
    }
}

/// Whether `contents` already carries the fenced block.
///
/// # Examples
///
/// ```
/// use setu_lib::shell_integration::{is_installed, install, Shell};
/// let rc = "export EDITOR=vim\n";
/// assert!(!is_installed(rc));
/// assert!(is_installed(&install(rc, Shell::Zsh)));
/// ```
pub fn is_installed(contents: &str) -> bool {
    fence_span(contents).is_some()
}

/// Locates the fenced block: byte range from the start of the opening
/// marker line to just past the closing marker's newline (or end of file).
fn fence_span(contents: &str) -> Option<(usize, usize)> {
    let start = contents
        .match_indices(FENCE_START)
        .find(|(i, _)| *i == 0 || contents.as_bytes()[i - 1] == b'\n')
        .map(|(i, _)| i)?;
    let end_marker = contents[start..].find(FENCE_END)? + start;
    let end = contents[end_marker..]
        .find('\n')
        .map(|i| end_marker + i + 1)
        .unwrap_or(contents.len());
    Some((start, end))
}

/// The fenced block for `shell`, ready to append.
pub fn fenced_block(shell: Shell) -> String {
    let snippet = shell.snippet().trim_end_matches('\n');
    format!("{FENCE_START}\n{snippet}\n{FENCE_END}\n")
}

/// Returns `contents` with the fenced block appended — or unchanged when
/// it is already installed (the double-install edge case in F12).
///
/// A blank separator line precedes the block unless the file is empty or
/// already ends with one, so the rc stays readable; the file always ends
/// with a newline afterwards.
pub fn install(contents: &str, shell: Shell) -> String {
    if is_installed(contents) {
        return contents.to_string();
    }
    let mut out = String::with_capacity(contents.len() + 2048);
    out.push_str(contents);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(&fenced_block(shell));
    out
}

/// Returns `contents` with the fenced block removed — the inverse of
/// [`install`] up to trailing blank lines (see the module docs).
/// Unchanged when no block is present.
///
/// # Examples
///
/// ```
/// use setu_lib::shell_integration::{install, uninstall, Shell};
/// let rc = "alias ll='ls -l'\n";
/// assert_eq!(uninstall(&install(rc, Shell::Bash)), rc);
/// ```
pub fn uninstall(contents: &str) -> String {
    let Some((start, end)) = fence_span(contents) else {
        return contents.to_string();
    };
    let mut out = String::with_capacity(contents.len());
    let before = &contents[..start];
    // Drop the separator blank line the installer added, but never more
    // than one, and never the file's own trailing newline.
    let before = if before.ends_with("\n\n") {
        &before[..before.len() - 1]
    } else {
        before
    };
    out.push_str(before);
    out.push_str(&contents[end..]);
    out
}

/// One line of a rendered diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffLine {
    /// `"+"` for an added line, `"-"` for a removed one, `" "` for context.
    pub kind: String,
    /// The line text (no trailing newline).
    pub text: String,
}

/// Renders the change from `before` to `after` as a line diff.
///
/// The installer only ever appends or removes one contiguous block, so
/// this is a common-prefix / common-suffix diff: context is the three
/// lines either side of the change. It is exact for the installer's own
/// edits and readable for anything else.
///
/// # Examples
///
/// ```
/// use setu_lib::shell_integration::{diff_lines, DiffLine};
/// let d = diff_lines("a\nb\n", "a\nb\nc\n");
/// assert_eq!(d.last().unwrap(), &DiffLine { kind: "+".into(), text: "c".into() });
/// ```
pub fn diff_lines(before: &str, after: &str) -> Vec<DiffLine> {
    const CONTEXT: usize = 3;
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    let prefix = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let max_suffix = old.len().min(new.len()) - prefix;
    let suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(max_suffix)
        .take_while(|(a, b)| a == b)
        .count();
    let line = |kind: &str, text: &str| DiffLine {
        kind: kind.to_string(),
        text: text.to_string(),
    };
    let mut out = Vec::new();
    for text in &old[prefix.saturating_sub(CONTEXT)..prefix] {
        out.push(line(" ", text));
    }
    for text in &old[prefix..old.len() - suffix] {
        out.push(line("-", text));
    }
    for text in &new[prefix..new.len() - suffix] {
        out.push(line("+", text));
    }
    let tail_start = old.len() - suffix;
    for text in &old[tail_start..(tail_start + CONTEXT).min(old.len())] {
        out.push(line(" ", text));
    }
    out
}

/// Picks the shell for a remote host from which rc files exist, when
/// `$SHELL` cannot be asked (SFTP runs no commands — PLAN.md §5).
///
/// Preference order is fish → zsh → bash: a fish config is the strongest
/// signal (nobody has one by accident); `.zshrc` beats `.bashrc` because
/// Ubuntu ships a `.bashrc` for every account whether bash is the login
/// shell or not. `None` when nothing exists — the UI then asks.
///
/// # Examples
///
/// ```
/// use setu_lib::shell_integration::{detect_by_rc, Shell};
/// assert_eq!(detect_by_rc(&[".bashrc", ".zshrc"]), Some(Shell::Zsh));
/// assert_eq!(detect_by_rc(&[]), None);
/// ```
pub fn detect_by_rc(existing: &[&str]) -> Option<Shell> {
    if existing.contains(&Shell::Fish.rc_relative_path()) {
        Some(Shell::Fish)
    } else if existing.contains(&Shell::Zsh.rc_relative_path()) {
        Some(Shell::Zsh)
    } else if existing.contains(&Shell::Bash.rc_relative_path()) {
        Some(Shell::Bash)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_is_idempotent_and_uninstall_restores_exactly() {
        for shell in [Shell::Zsh, Shell::Bash, Shell::Fish] {
            for rc in ["", "x=1", "x=1\n", "x=1\n\n", "# a\n# b\n"] {
                let once = install(rc, shell);
                assert!(is_installed(&once), "{shell:?} {rc:?}");
                assert_eq!(install(&once, shell), once, "double install must no-op");
                assert!(once.ends_with('\n'));
                let restored = uninstall(&once);
                // Every original line survives; only trailing blank lines
                // may be normalized (the installer ends the file with one
                // newline, and the uninstaller takes back the one blank
                // separator it added).
                assert_eq!(restored.trim_end(), rc.trim_end(), "{shell:?} {rc:?}");
                assert!(restored.is_empty() || restored.ends_with('\n'));
                assert!(!is_installed(&restored));
            }
        }
    }

    #[test]
    fn uninstall_keeps_text_after_the_block() {
        let rc = format!("{}\nalias after=1\n", install("before=1\n", Shell::Bash));
        assert_eq!(uninstall(&rc), "before=1\n\nalias after=1\n");
    }

    #[test]
    fn fence_marker_inside_a_comment_is_not_a_block() {
        let rc = format!("echo '{FENCE_START}'\n");
        assert!(!is_installed(&rc));
        assert_eq!(uninstall(&rc), rc);
    }

    #[test]
    fn snippets_are_fenced_and_nonempty() {
        for shell in [Shell::Zsh, Shell::Bash, Shell::Fish] {
            let block = fenced_block(shell);
            assert!(block.starts_with(FENCE_START));
            assert!(block.ends_with(&format!("{FENCE_END}\n")));
            assert!(block.contains("133;A"), "{shell:?} must emit prompt marks");
            assert!(
                block.contains("633;E"),
                "{shell:?} must carry the command text"
            );
            assert!(block.contains("7;file://"), "{shell:?} must report cwd");
        }
    }

    #[test]
    fn diff_shows_only_the_appended_block_with_context() {
        let before = "1\n2\n3\n4\n5\n";
        let after = install(before, Shell::Zsh);
        let d = diff_lines(before, &after);
        let context: Vec<_> = d.iter().filter(|l| l.kind == " ").collect();
        assert_eq!(context.len(), 3);
        assert_eq!(context[0].text, "3");
        assert!(d.iter().all(|l| l.kind != "-"));
        let added: Vec<_> = d.iter().filter(|l| l.kind == "+").collect();
        assert_eq!(added[0].text, "");
        assert_eq!(added[1].text, FENCE_START);
        assert_eq!(added.last().unwrap().text, FENCE_END);
        // And the reverse for uninstall.
        let back = diff_lines(&after, before);
        assert!(back.iter().all(|l| l.kind != "+"));
        assert_eq!(back.iter().filter(|l| l.kind == "-").count(), added.len());
    }

    #[test]
    fn diff_of_identical_text_is_only_context() {
        let d = diff_lines("a\nb\n", "a\nb\n");
        assert!(d.iter().all(|l| l.kind == " "));
    }

    #[test]
    fn shell_from_name_handles_paths() {
        assert_eq!(Shell::from_name("/bin/zsh"), Some(Shell::Zsh));
        assert_eq!(Shell::from_name("bash"), Some(Shell::Bash));
        assert_eq!(Shell::from_name("/usr/bin/nologin"), None);
    }
}
