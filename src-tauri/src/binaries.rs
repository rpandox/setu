//! Locating optional system tools (Phase 7): mosh, tailscale, claude.
//!
//! A GUI-launched app inherits launchd's minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) — Homebrew's directories are not on
//! it, so "is mosh installed?" cannot be answered by `PATH` alone. The
//! finder therefore walks `PATH` first, then the well-known install
//! locations, and returns the **absolute path**, which callers use for
//! spawning too (the same lookup answers "where" and "run it").
//!
//! The IPC surface (`binary_check`) allow-lists the names it accepts; this
//! module just finds executables.

use std::path::{Path, PathBuf};

/// Well-known directories beyond the (possibly minimal) `PATH`: Homebrew
/// on Apple silicon and Intel, plus the Mac App Store Tailscale bundle.
const EXTRA_DIRS: [&str; 3] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Where the Tailscale app bundles its CLI when installed from the App
/// Store / standalone download (there is no symlink on `PATH`).
const TAILSCALE_APP_CLI: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// Finds `name` on `PATH` or in the well-known locations, returning the
/// absolute path to an executable file, or `None` when absent.
pub fn find(name: &str) -> Option<PathBuf> {
    let path_dirs = std::env::var_os("PATH");
    let from_path = path_dirs
        .as_deref()
        .into_iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate));
    if from_path.is_some() {
        return from_path;
    }
    let extra = EXTRA_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| is_executable(candidate));
    if extra.is_some() {
        return extra;
    }
    if name == "tailscale" {
        let bundled = PathBuf::from(TAILSCALE_APP_CLI);
        if is_executable(&bundled) {
            return Some(bundled);
        }
    }
    None
}

/// Whether `path` is an existing file with any execute bit set.
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_standard_binary() {
        let sh = find("sh").expect("sh exists everywhere");
        assert!(sh.is_absolute());
        assert!(sh.ends_with("sh"));
    }

    #[test]
    fn absent_binaries_come_back_none() {
        assert_eq!(find("setu-definitely-not-a-binary"), None);
    }

    #[test]
    fn directories_do_not_count_as_executables() {
        // `/usr/bin` itself is executable-as-directory; the finder must
        // only accept files.
        assert!(!is_executable(Path::new("/usr/bin")));
    }
}
