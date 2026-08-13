//! `known_hosts` verification for the in-app SFTP client (F5).
//!
//! Interactive terminals never need this module: they drive the *system*
//! `ssh`, which does its own host-key prompting in the terminal (PLAN.md §5).
//! The SFTP client is the one place Setu speaks the SSH protocol itself
//! (russh), so it must also verify server keys itself — against the same
//! `~/.ssh/known_hosts` the user already trusts.
//!
//! The rules (PLAN.md §3 security model, CLAUDE.md hard rules):
//!
//! - **Read** `~/.ssh/*` freely; **write** only `known_hosts`, and only by
//!   *appending* a line after the user explicitly trusts a fingerprint in
//!   the FingerprintDialog. Nothing here ever rewrites or deletes entries.
//! - An **unknown** key prompts. A **mismatched** key (same algorithm,
//!   different key) hard-fails — a changed host key is exactly the situation
//!   the file exists to catch, and a trust prompt there would train the user
//!   to click through the one warning that matters. `@revoked` keys likewise
//!   hard-fail.
//!
//! Parsing of individual lines (markers, hashed `|1|` patterns, key blobs)
//! comes from the `ssh-key` crate re-exported by russh; the *matching* —
//! OpenSSH glob patterns, `!` negation, `[host]:port` forms, hashed-name
//! HMAC-SHA1 comparison — and the verdict logic live here, unit-tested
//! against fixtures produced by OpenSSH's own `ssh-keygen`.

use std::fmt;
use std::io::Write as _;
use std::path::Path;

use hmac::{Hmac, Mac};
use russh::keys::ssh_key::known_hosts::{Entry, HostPatterns, Marker};
use russh::keys::{HashAlg, PublicKey};
use sha1::Sha1;

/// The verdict from checking a server's key against `known_hosts`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyCheck {
    /// The exact key is on file for this host: connect silently.
    Match,
    /// No entry for this host + algorithm: emit `hostkey:prompt` and let the
    /// user decide in the FingerprintDialog.
    Unknown,
    /// An entry for this host and algorithm exists but the key differs —
    /// possibly a reinstalled server, possibly an interception. Hard fail;
    /// never a prompt.
    Mismatch {
        /// OpenSSH-format `SHA256:…` fingerprint of the key on file, so the
        /// error can name both keys.
        stored_fingerprint: String,
    },
    /// The presented key is explicitly marked `@revoked` on file. Hard fail.
    Revoked,
}

impl fmt::Display for KeyCheck {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyCheck::Match => write!(f, "match"),
            KeyCheck::Unknown => write!(f, "unknown"),
            KeyCheck::Mismatch { stored_fingerprint } => {
                write!(f, "mismatch (key on file: {stored_fingerprint})")
            }
            KeyCheck::Revoked => write!(f, "revoked"),
        }
    }
}

/// The canonical `known_hosts` host string OpenSSH uses for lookups:
/// the lowercased hostname bare on port 22, `[host]:port` otherwise.
pub fn canonical_host(hostname: &str, port: u16) -> String {
    let hostname = hostname.to_lowercase();
    if port == 22 {
        hostname
    } else {
        format!("[{hostname}]:{port}")
    }
}

/// The OpenSSH-format `SHA256:<base64>` fingerprint of `key` — the exact
/// string `ssh-keygen -lf` prints and the FingerprintDialog displays.
pub fn sha256_fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Checks `key` for `hostname:port` against `known_hosts` text.
///
/// Pure — the file-reading wrapper is [`check_key_file`]. Unparseable lines
/// and comments are skipped, like OpenSSH does. `@cert-authority` entries
/// are ignored: Setu doesn't validate host certificates, and a directly
/// trusted key line alongside a CA line is harmless. A `@revoked` entry for
/// the presented key wins over everything else in the file.
pub fn check_key(known_hosts: &str, hostname: &str, port: u16, key: &PublicKey) -> KeyCheck {
    let canonical = canonical_host(hostname, port);
    let mut matched = false;
    let mut mismatch: Option<String> = None;

    for line in known_hosts.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Ok(entry) = line.parse::<Entry>() else {
            continue;
        };
        if !host_matches(entry.host_patterns(), &canonical) {
            continue;
        }
        let stored = entry.public_key();
        match entry.marker() {
            Some(Marker::Revoked) => {
                if stored.key_data() == key.key_data() {
                    return KeyCheck::Revoked;
                }
            }
            Some(Marker::CertAuthority) => {}
            None => {
                if stored.key_data() == key.key_data() {
                    matched = true;
                } else if stored.algorithm() == key.algorithm() {
                    mismatch = Some(sha256_fingerprint(stored));
                }
            }
        }
    }

    if matched {
        KeyCheck::Match
    } else if let Some(stored_fingerprint) = mismatch {
        KeyCheck::Mismatch { stored_fingerprint }
    } else {
        KeyCheck::Unknown
    }
}

/// [`check_key`] against the file at `path`. A missing file is simply an
/// empty trust store: every key is [`KeyCheck::Unknown`].
///
/// # Errors
///
/// Returns a message when the file exists but can't be read (permissions,
/// invalid UTF-8).
pub fn check_key_file(
    path: &Path,
    hostname: &str,
    port: u16,
    key: &PublicKey,
) -> Result<KeyCheck, String> {
    if !path.exists() {
        return Ok(KeyCheck::Unknown);
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    Ok(check_key(&text, hostname, port, key))
}

/// Appends a trusted key line for `hostname:port` to the file at `path` —
/// the write half of the FingerprintDialog trust flow, and the **only**
/// `known_hosts` write in the app.
///
/// Append-only by construction: the file is opened in append mode, created
/// `0600` if missing, and a separating newline is inserted first when the
/// existing content doesn't end with one (hand-edited files often don't).
///
/// # Errors
///
/// Returns a message when the file can't be opened, read, or written.
pub fn append_trusted(
    path: &Path,
    hostname: &str,
    port: u16,
    key: &PublicKey,
) -> Result<(), String> {
    let openssh = key
        .to_openssh()
        .map_err(|e| format!("couldn't encode the host key: {e}"))?;
    let line = format!(
        "{} {}\n",
        canonical_host(hostname, port),
        openssh.trim_end()
    );

    let needs_separator = match std::fs::read(path) {
        Ok(bytes) => !bytes.is_empty() && !bytes.ends_with(b"\n"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
    };
    let created = !path.exists();

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("couldn't open {}: {e}", path.display()))?;
    #[cfg(unix)]
    if created {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut data = String::new();
    if needs_separator {
        data.push('\n');
    }
    data.push_str(&line);
    file.write_all(data.as_bytes())
        .map_err(|e| format!("couldn't append to {}: {e}", path.display()))
}

/// Whether a parsed entry's host patterns cover `canonical` (already
/// lowercased, `[host]:port` form for non-22 ports).
fn host_matches(patterns: &HostPatterns, canonical: &str) -> bool {
    match patterns {
        HostPatterns::Patterns(list) => patterns_match(list, canonical),
        HostPatterns::HashedName { salt, hash } => hashed_matches(salt, hash, canonical),
    }
}

/// OpenSSH `match_hostname` semantics over a comma-separated pattern list:
/// a matching `!`-negated pattern vetoes the entry regardless of any
/// positive match; otherwise any positive match wins.
fn patterns_match(list: &[String], canonical: &str) -> bool {
    let mut found = false;
    for raw in list {
        let (negated, pattern) = match raw.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        if glob_match(&pattern.to_lowercase(), canonical) {
            if negated {
                return false;
            }
            found = true;
        }
    }
    found
}

/// OpenSSH `match_pattern`: `*` matches any run (including empty), `?`
/// matches exactly one character, everything else is literal.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn rec(p: &[char], t: &[char]) -> bool {
        match p.first() {
            None => t.is_empty(),
            Some('*') => rec(&p[1..], t) || (!t.is_empty() && rec(p, &t[1..])),
            Some('?') => !t.is_empty() && rec(&p[1..], &t[1..]),
            Some(c) => t.first() == Some(c) && rec(&p[1..], &t[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    rec(&p, &t)
}

/// Whether a hashed `|1|salt|hash` pattern names `canonical`:
/// `HMAC-SHA1(salt, canonical) == hash`, per OpenSSH's `hostfile.c`.
fn hashed_matches(salt: &[u8], hash: &[u8; 20], canonical: &str) -> bool {
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(salt) else {
        return false;
    };
    mac.update(canonical.as_bytes());
    mac.finalize().into_bytes().as_slice() == hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixture key A (`ssh-keygen -t ed25519`); the server's key in most tests.
    const KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM9kzRm9EolhOp3reJgZLRrgVCZHe4leaVcgCr9PXKMf";
    /// `ssh-keygen -lf` fingerprint of [`KEY_A`], for exact-format checks.
    const KEY_A_FP: &str = "SHA256:E9t37xjdtxUauy8TwxP1t0feF1MASESd+k1GqJAlBDw";
    /// Fixture key B — same algorithm as A, different key.
    const KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIv/Bdalg2vRGClT3Rd1nqBPwyTkIuPz6Vdc+CaArM4l";
    /// Fixture RSA key — a different algorithm entirely.
    const KEY_RSA: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDNLiCc0/AXgjjt6zX/7WPIZMHxqtKLFjFIw8YtqzZotbPa2mm6sVvDv2Zilnqbcn1No/Oz8iqGPGD1/hWOT9jaBAUMD7KI5EViUf2/TnO/tBMJCDmyn8Aw6jqDfpS71p7uyVX4G5I7GPkrtn8q5N9PvjQQ1X0NOXX1O+8AlP3vdikDxdYqlLAhjGXwLIGSl+EYAzrhF4LYgOWZ7d3Q9EDYWayWhFVw465TvWTLtUYPMn6pK5qQmrD9ImVnB3qmsONspqXhVdjukc8ZmJU0Ti3sztmwuufmfTHa3BMp7pE3+M+CeCetEclbrb8Xi6xqljMkkkebF2CTbTS8ZYs4pftL";
    /// [`KEY_A`] for `hermes.example.net` hashed by `ssh-keygen -H` itself —
    /// ground truth for the HMAC-SHA1 comparison.
    const HASHED_LINE: &str = "|1|C+ZUVyTjgIeLgybbjUHzhGKucHU=|BGfXf3zLryt60pSDlb9c34iWW6w= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM9kzRm9EolhOp3reJgZLRrgVCZHe4leaVcgCr9PXKMf";

    fn key(s: &str) -> PublicKey {
        s.parse().expect("fixture key parses")
    }

    fn line(host: &str, k: &str) -> String {
        format!("{host} {k}\n")
    }

    #[test]
    fn exact_host_on_default_port_matches() {
        let file = line("hermes.example.net", KEY_A);
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn hostname_lookup_is_case_insensitive() {
        let file = line("hermes.example.net", KEY_A);
        assert_eq!(
            check_key(&file, "HERMES.example.NET", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn other_host_is_unknown() {
        let file = line("hermes.example.net", KEY_A);
        assert_eq!(
            check_key(&file, "athena.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
    }

    #[test]
    fn non_default_port_uses_bracketed_form() {
        let file = line("[hermes.example.net]:2222", KEY_A);
        assert_eq!(
            check_key(&file, "hermes.example.net", 2222, &key(KEY_A)),
            KeyCheck::Match
        );
        // The bare-hostname port-22 lookup must NOT hit the :2222 entry.
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
    }

    #[test]
    fn wildcard_patterns_match() {
        let file = line("*.example.net", KEY_A);
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn negated_pattern_vetoes_the_entry() {
        let file = line("*.example.net,!hermes.example.net", KEY_A);
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
        assert_eq!(
            check_key(&file, "athena.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn openssh_hashed_entry_matches_its_host_only() {
        assert_eq!(
            check_key(HASHED_LINE, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
        assert_eq!(
            check_key(HASHED_LINE, "athena.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
    }

    #[test]
    fn same_algorithm_different_key_is_a_mismatch_naming_the_stored_key() {
        let file = line("hermes.example.net", KEY_B);
        let verdict = check_key(&file, "hermes.example.net", 22, &key(KEY_A));
        let KeyCheck::Mismatch { stored_fingerprint } = verdict else {
            panic!("expected Mismatch, got {verdict:?}");
        };
        assert_eq!(stored_fingerprint, sha256_fingerprint(&key(KEY_B)));
    }

    #[test]
    fn different_algorithm_on_file_is_unknown_not_mismatch() {
        // OpenSSH semantics: records are per (host, key type). An RSA entry
        // says nothing about the ed25519 key the server now presents.
        let file = line("hermes.example.net", KEY_RSA);
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
    }

    #[test]
    fn a_matching_entry_beats_a_stale_mismatching_one() {
        // Both an old key and the current key on file (common after a
        // server reinstall where the new key was re-trusted).
        let file = format!(
            "{}{}",
            line("hermes.example.net", KEY_B),
            line("hermes.example.net", KEY_A)
        );
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn revoked_key_is_refused_even_when_also_trusted() {
        let file = format!(
            "@revoked hermes.example.net {KEY_A}\n{}",
            line("hermes.example.net", KEY_A)
        );
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Revoked
        );
    }

    #[test]
    fn cert_authority_entries_are_ignored() {
        let file = format!("@cert-authority *.example.net {KEY_A}\n");
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Unknown
        );
    }

    #[test]
    fn comments_blanks_and_garbage_are_skipped() {
        let file = format!(
            "# a comment\n\nnot a valid line at all\n{}",
            line("hermes.example.net", KEY_A)
        );
        assert_eq!(
            check_key(&file, "hermes.example.net", 22, &key(KEY_A)),
            KeyCheck::Match
        );
    }

    #[test]
    fn fingerprint_is_openssh_sha256_format() {
        assert_eq!(sha256_fingerprint(&key(KEY_A)), KEY_A_FP);
    }

    #[test]
    fn canonical_host_forms() {
        assert_eq!(
            canonical_host("Hermes.Example.Net", 22),
            "hermes.example.net"
        );
        assert_eq!(
            canonical_host("hermes.example.net", 2222),
            "[hermes.example.net]:2222"
        );
    }

    /// A unique scratch path in the OS temp dir; removed by the test.
    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("setu-kh-{}-{}", name, uuid::Uuid::new_v4()))
    }

    #[test]
    fn append_creates_the_file_and_the_key_then_matches() {
        let path = scratch("create");
        append_trusted(&path, "hermes.example.net", 22, &key(KEY_A)).expect("append");
        let verdict = check_key_file(&path, "hermes.example.net", 22, &key(KEY_A));
        assert_eq!(verdict, Ok(KeyCheck::Match));
        let text = std::fs::read_to_string(&path).expect("read back");
        assert!(text.ends_with('\n'), "appended line must end with newline");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "created file must be 0600");
        }
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn append_to_file_without_trailing_newline_stays_on_its_own_line() {
        let path = scratch("no-newline");
        std::fs::write(&path, format!("athena.example.net {KEY_B}")).expect("seed");
        append_trusted(&path, "hermes.example.net", 2222, &key(KEY_A)).expect("append");
        let text = std::fs::read_to_string(&path).expect("read back");
        assert_eq!(text.lines().count(), 2, "entries must not merge: {text:?}");
        assert_eq!(
            check_key_file(&path, "hermes.example.net", 2222, &key(KEY_A)),
            Ok(KeyCheck::Match)
        );
        // The seeded entry survives untouched (append-only guarantee).
        assert_eq!(
            check_key_file(&path, "athena.example.net", 22, &key(KEY_B)),
            Ok(KeyCheck::Match)
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_is_an_empty_trust_store() {
        let path = scratch("missing");
        assert_eq!(
            check_key_file(&path, "hermes.example.net", 22, &key(KEY_A)),
            Ok(KeyCheck::Unknown)
        );
    }
}
