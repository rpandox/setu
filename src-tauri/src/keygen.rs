//! SSH key generation (F8, Phase 7): `ssh-keygen -t ed25519`, driven safely.
//!
//! The spec shells the system tool (PLAN.md §9 F8) — but a passphrase must
//! never appear on the argv, where `ps` could read it, and never on disk.
//! So there are two paths (PLAN.md §5, Phase 7 row):
//!
//! - **No passphrase:** plain `ssh-keygen … -N ""` — nothing secret exists.
//! - **With passphrase:** ssh-keygen runs inside a hidden PTY and the
//!   passphrase is typed into its own prompts, exactly as a user would —
//!   argv-free, echo-free, log-free.
//!
//! Existing files are never overwritten: a taken path is an expected
//! outcome ([`GenOutcome::Refused`]), not an error. Storing the passphrase
//! in the Keychain is the IPC layer's job — this module only makes keys.

use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::store::expand_tilde;

/// How long the whole generation may take before the child is killed.
const TIMEOUT: Duration = Duration::from_secs(15);

/// What a generation attempt produced (mirrors `KeysGenerateResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenOutcome {
    /// The keypair exists; here is `{path}.pub`'s content, for the
    /// clipboard and the ssh-copy-id helper.
    Generated {
        /// The public key line, trimmed.
        public_key: String,
    },
    /// Expected refusal — nothing was written.
    Refused {
        /// `"file_exists"` or `"no_parent"`.
        kind: &'static str,
        /// One plain sentence naming the path.
        message: String,
    },
}

/// Generates an ed25519 keypair at `path` (tilde-expanded).
///
/// `comment` becomes the key's `-C` comment when non-empty. An empty
/// `passphrase` produces an unencrypted key via `-N ""`; a non-empty one
/// drives ssh-keygen's own prompts through a hidden PTY so the secret
/// never touches argv or disk.
///
/// # Errors
///
/// Fails when ssh-keygen can't be spawned, exits non-zero, stalls past
/// the timeout, or the generated `.pub` can't be read back. A taken path
/// or missing parent directory is an expected [`GenOutcome::Refused`],
/// not an error.
pub fn generate(path: &str, passphrase: &str, comment: &str) -> Result<GenOutcome, String> {
    let expanded = expand_tilde(path);
    if expanded.exists() || expanded.with_extension("pub").exists() {
        return Ok(GenOutcome::Refused {
            kind: "file_exists",
            message: format!(
                "{} already exists — pick another filename (existing keys are never overwritten)",
                expanded.display()
            ),
        });
    }
    match expanded.parent() {
        Some(parent) if parent.as_os_str().is_empty() || parent.is_dir() => {}
        Some(parent) => {
            return Ok(GenOutcome::Refused {
                kind: "no_parent",
                message: format!("{} doesn't exist — create it first", parent.display()),
            });
        }
        None => {
            return Ok(GenOutcome::Refused {
                kind: "no_parent",
                message: "the key path has no parent directory".to_string(),
            });
        }
    }

    if passphrase.is_empty() {
        generate_plain(&expanded, comment)?;
    } else {
        generate_via_pty(&expanded, passphrase, comment)?;
    }

    let public_key = std::fs::read_to_string(expanded.with_extension("pub"))
        .map_err(|e| format!("key generated but couldn't read the public key: {e}"))?
        .trim()
        .to_string();
    Ok(GenOutcome::Generated { public_key })
}

/// Shared argv prefix: quiet, ed25519, optional comment, the filename.
fn keygen_args(path: &Path, comment: &str) -> Vec<String> {
    let mut args = vec!["-q".into(), "-t".into(), "ed25519".into()];
    if !comment.is_empty() {
        args.push("-C".into());
        args.push(comment.to_string());
    }
    args.push("-f".into());
    args.push(path.display().to_string());
    args
}

/// The no-passphrase path: `-N ""` on the argv is harmless (there is no
/// secret), so a plain child process suffices.
fn generate_plain(path: &Path, comment: &str) -> Result<(), String> {
    let output = std::process::Command::new("ssh-keygen")
        .args(keygen_args(path, comment))
        .args(["-N", ""])
        .output()
        .map_err(|e| format!("couldn't run ssh-keygen: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh-keygen failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// The passphrase path: ssh-keygen inside a hidden PTY, its two
/// passphrase prompts answered by writes to the master side. The prompts
/// disable echo, so the secret never appears in the captured output
/// either.
fn generate_via_pty(path: &Path, passphrase: &str, comment: &str) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("couldn't open a pty for ssh-keygen: {e}"))?;

    let mut cmd = CommandBuilder::new("ssh-keygen");
    for arg in keygen_args(path, comment) {
        cmd.arg(arg);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("couldn't run ssh-keygen: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("couldn't read ssh-keygen's pty: {e}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("couldn't write ssh-keygen's pty: {e}"))?;

    // Reader thread: accumulate output so the prompt matcher (and error
    // reporting) can see it. Passphrase prompts don't echo, so the buffer
    // never contains the secret.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let deadline = Instant::now() + TIMEOUT;
    let mut seen = String::new();
    let outcome = drive_prompts(&rx, &mut writer, passphrase, deadline, &mut seen)
        .and_then(|()| wait_for_exit(&mut child, &rx, deadline, &mut seen));
    if outcome.is_err() {
        let _ = child.kill();
    }
    outcome
}

/// Answers ssh-keygen's two prompts in order. The first prompt line
/// ("Enter passphrase (empty for no passphrase):") is matched on
/// `passphrase`, the confirm ("Enter same passphrase again:") on `again`
/// — the confirm must not be answered early, because readpassphrase
/// flushes pending tty input between prompts.
fn drive_prompts(
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    writer: &mut Box<dyn std::io::Write + Send>,
    passphrase: &str,
    deadline: Instant,
    seen: &mut String,
) -> Result<(), String> {
    for marker in ["passphrase", "again"] {
        while !seen.to_ascii_lowercase().contains(marker) {
            match rx.recv_timeout(remaining(deadline)?) {
                Ok(chunk) => seen.push_str(&String::from_utf8_lossy(&chunk)),
                Err(_) => {
                    return Err(format!("ssh-keygen never showed its \"{marker}\" prompt"));
                }
            }
        }
        seen.clear();
        writer
            .write_all(passphrase.as_bytes())
            .and_then(|()| writer.write_all(b"\r"))
            .map_err(|e| format!("couldn't answer ssh-keygen: {e}"))?;
    }
    Ok(())
}

/// Waits for the child to exit, draining output for error reporting.
fn wait_for_exit(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
    seen: &mut String,
) -> Result<(), String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(format!("ssh-keygen failed: {}", last_line(seen))),
            Ok(None) => {
                if Instant::now() >= deadline {
                    return Err("ssh-keygen timed out".to_string());
                }
                if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(50)) {
                    seen.push_str(&String::from_utf8_lossy(&chunk));
                }
            }
            Err(e) => return Err(format!("couldn't wait for ssh-keygen: {e}")),
        }
    }
}

/// Time left until `deadline`, or a timeout error.
fn remaining(deadline: Instant) -> Result<Duration, String> {
    let now = Instant::now();
    if now >= deadline {
        return Err("ssh-keygen timed out".to_string());
    }
    Ok(deadline - now)
}

/// The last non-empty line of captured output, for error messages.
fn last_line(seen: &str) -> &str {
    seen.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("no output")
        .trim()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("setu-keygen-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn plain_generation_makes_a_usable_keypair() {
        let dir = scratch("plain");
        let key = dir.join("id_ed25519");
        let outcome = generate(key.to_str().unwrap(), "", "setu-test").expect("generate");
        let GenOutcome::Generated { public_key } = outcome else {
            panic!("expected Generated, got {outcome:?}");
        };
        assert!(public_key.starts_with("ssh-ed25519 "));
        assert!(public_key.ends_with("setu-test"));
        // The private half parses without a passphrase.
        russh::keys::load_secret_key(&key, None).expect("unencrypted key loads");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn passphrase_generation_encrypts_via_the_pty() {
        let dir = scratch("pty");
        let key = dir.join("id_ed25519");
        let outcome =
            generate(key.to_str().unwrap(), "quartz-battery-staple", "").expect("generate");
        assert!(matches!(outcome, GenOutcome::Generated { .. }));
        // Without the passphrase the key must refuse to load…
        assert!(matches!(
            russh::keys::load_secret_key(&key, None),
            Err(russh::keys::Error::KeyIsEncrypted)
        ));
        // …and with it, load fine.
        russh::keys::load_secret_key(&key, Some("quartz-battery-staple"))
            .expect("passphrase unlocks");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = scratch("exists");
        let key = dir.join("id_ed25519");
        std::fs::write(&key, "not really a key").unwrap();
        let outcome = generate(key.to_str().unwrap(), "", "").expect("generate");
        assert!(matches!(
            outcome,
            GenOutcome::Refused {
                kind: "file_exists",
                ..
            }
        ));
        assert_eq!(
            std::fs::read_to_string(&key).unwrap(),
            "not really a key",
            "the existing file is untouched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_parent_directories_refuse() {
        let dir = scratch("noparent");
        let key = dir.join("nope").join("id_ed25519");
        let outcome = generate(key.to_str().unwrap(), "", "").expect("generate");
        assert!(matches!(
            outcome,
            GenOutcome::Refused {
                kind: "no_parent",
                ..
            }
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
