//! Vault export (F8, Phase 7): an age-encrypted tarball of the config dir.
//!
//! `~/.config/setu` — hosts, snippets, settings — tars into one stream,
//! encrypted with an age passphrase (scrypt recipient, pure Rust) and
//! written as `*.tar.age`. Decrypt anywhere with the standard tool:
//!
//! ```sh
//! age -d setu-vault.tar.age | tar -x
//! ```
//!
//! **Secrets are excluded by default** (PLAN.md §9 F8): only the second,
//! explicit toggle bundles the known Keychain entries as a
//! `keychain-secrets.toml` inside the encrypted tarball — collected by
//! the IPC layer, never written to disk unencrypted. The `.git` directory
//! (the Phase 8 sync spine) is always skipped: a vault is a backup, not a
//! repository clone.

use std::fs::File;
use std::io::{BufWriter, Write as _};
use std::path::Path;

use age::secrecy::Secret;

/// One Keychain entry bound for `keychain-secrets.toml` (collected by
/// the IPC layer when — and only when — the user flips the second
/// toggle).
#[derive(Debug, Clone)]
pub struct SecretEntry {
    /// The deterministic Keychain account (`password:{uuid}` /
    /// `passphrase:{path}`).
    pub account: String,
    /// The secret itself. Lives on this struct only for the duration of
    /// the export call.
    pub secret: String,
}

/// Exports `config_dir` as an age-encrypted tarball at `dest`.
///
/// Returns the encrypted byte count. `secrets` — already read by the
/// caller — become `keychain-secrets.toml` inside the tarball; `None`
/// means the default secrets-excluded export.
///
/// # Errors
///
/// Fails when the passphrase is empty, the config dir doesn't exist, or
/// any IO/encryption step fails. A partial destination file is removed
/// on failure.
pub fn export(
    config_dir: &Path,
    dest: &Path,
    passphrase: &str,
    secrets: Option<Vec<SecretEntry>>,
) -> Result<u64, String> {
    if passphrase.is_empty() {
        return Err("the vault passphrase must not be empty".to_string());
    }
    if !config_dir.is_dir() {
        return Err(format!(
            "{} doesn't exist — nothing to export",
            config_dir.display()
        ));
    }
    let outcome = write_vault(config_dir, dest, passphrase, secrets);
    if outcome.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    outcome
}

/// The happy-path body of [`export`] (split so cleanup stays in one spot).
fn write_vault(
    config_dir: &Path,
    dest: &Path,
    passphrase: &str,
    secrets: Option<Vec<SecretEntry>>,
) -> Result<u64, String> {
    let file =
        File::create(dest).map_err(|e| format!("couldn't create {}: {e}", dest.display()))?;
    let encryptor = age::Encryptor::with_user_passphrase(Secret::new(passphrase.to_string()));
    let mut encrypted = encryptor
        .wrap_output(BufWriter::new(file))
        .map_err(|e| format!("couldn't start encryption: {e}"))?;
    {
        let mut tar = tar::Builder::new(&mut encrypted);
        append_dir_filtered(&mut tar, config_dir, Path::new("setu-config"))?;
        if let Some(entries) = secrets {
            append_secrets_toml(&mut tar, &entries)?;
        }
        tar.finish()
            .map_err(|e| format!("couldn't finish the tar stream: {e}"))?;
    }
    let mut writer = encrypted
        .finish()
        .map_err(|e| format!("couldn't finish encryption: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("couldn't flush the vault: {e}"))?;
    std::fs::metadata(dest)
        .map(|meta| meta.len())
        .map_err(|e| format!("exported, but couldn't stat {}: {e}", dest.display()))
}

/// Recursively appends `dir` under `prefix`, skipping `.git` at any depth
/// and symlinks (a backup must not wander outside the config dir). Shared
/// with [`crate::snapshots`] — the scheduled tar.gz uses the same rules.
pub(crate) fn append_dir_filtered<W: std::io::Write>(
    tar: &mut tar::Builder<W>,
    dir: &Path,
    prefix: &Path,
) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("couldn't read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("couldn't read {}: {e}", dir.display()))?;
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        let arch_path = prefix.join(&name);
        let kind = entry
            .file_type()
            .map_err(|e| format!("couldn't stat {}: {e}", path.display()))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            append_dir_filtered(tar, &path, &arch_path)?;
        } else {
            tar.append_path_with_name(&path, &arch_path)
                .map_err(|e| format!("couldn't add {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Serializes the Keychain entries as `setu-config/keychain-secrets.toml`
/// inside the (already encrypted) stream.
fn append_secrets_toml<W: std::io::Write>(
    tar: &mut tar::Builder<W>,
    entries: &[SecretEntry],
) -> Result<(), String> {
    let mut text = String::from(
        "# Keychain entries exported by Setu's vault (F8). Re-add via the\n\
         # app's Keychain fields — this file exists only inside the\n\
         # age-encrypted vault.\n",
    );
    for entry in entries {
        text.push_str("\n[[secret]]\n");
        text.push_str(&format!("account = {}\n", toml_string(&entry.account)));
        text.push_str(&format!("secret = {}\n", toml_string(&entry.secret)));
    }
    let bytes = text.as_bytes();
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_mtime(0);
    header.set_cksum();
    tar.append_data(
        &mut header,
        "setu-config/keychain-secrets.toml",
        std::io::Cursor::new(bytes),
    )
    .map_err(|e| format!("couldn't add the secrets file: {e}"))
}

/// A TOML basic string with the two characters that need escaping.
fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;
    use std::path::PathBuf;

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("setu-vault-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Decrypts a vault and lists its entry paths (and one file's text).
    fn decrypt_entries(vault: &Path, passphrase: &str) -> (Vec<String>, Option<String>) {
        let file = File::open(vault).expect("open vault");
        let decryptor = match age::Decryptor::new(file).expect("age header") {
            age::Decryptor::Passphrase(d) => d,
            age::Decryptor::Recipients(_) => panic!("expected a passphrase vault"),
        };
        let reader = decryptor
            .decrypt(&Secret::new(passphrase.to_string()), None)
            .expect("decrypt");
        let mut archive = tar::Archive::new(reader);
        let mut names = Vec::new();
        let mut secrets_text = None;
        for entry in archive.entries().expect("entries") {
            let mut entry = entry.expect("entry");
            let name = entry.path().expect("path").display().to_string();
            if name.ends_with("keychain-secrets.toml") {
                let mut text = String::new();
                entry.read_to_string(&mut text).expect("read secrets");
                secrets_text = Some(text);
            }
            names.push(name);
        }
        names.sort();
        (names, secrets_text)
    }

    #[test]
    fn export_round_trips_and_skips_git() {
        let dir = scratch("roundtrip");
        let config = dir.join("config");
        std::fs::create_dir_all(config.join("themes")).unwrap();
        std::fs::create_dir_all(config.join(".git/objects")).unwrap();
        std::fs::write(config.join("hosts.toml"), "[[host]]\n").unwrap();
        std::fs::write(config.join("themes/basalt.json"), "{}").unwrap();
        std::fs::write(config.join(".git/HEAD"), "ref: main").unwrap();

        let vault = dir.join("setu-vault.tar.age");
        let bytes = export(&config, &vault, "quartz-battery", None).expect("export");
        assert!(bytes > 0);

        let (names, secrets) = decrypt_entries(&vault, "quartz-battery");
        assert_eq!(
            names,
            vec!["setu-config/hosts.toml", "setu-config/themes/basalt.json"],
            ".git never rides along"
        );
        assert_eq!(secrets, None, "secrets are excluded by default");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn secrets_toggle_bundles_keychain_entries() {
        let dir = scratch("secrets");
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("hosts.toml"), "").unwrap();

        let vault = dir.join("vault.tar.age");
        export(
            &config,
            &vault,
            "pw",
            Some(vec![SecretEntry {
                account: "password:abc".into(),
                secret: "hunter\"2\\".into(),
            }]),
        )
        .expect("export");

        let (names, secrets) = decrypt_entries(&vault, "pw");
        assert!(names.contains(&"setu-config/keychain-secrets.toml".to_string()));
        let text = secrets.expect("secrets file present");
        assert!(text.contains("account = \"password:abc\""));
        assert!(
            text.contains("secret = \"hunter\\\"2\\\\\""),
            "escaped: {text}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_passphrase_fails_to_decrypt() {
        let dir = scratch("wrongpw");
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("hosts.toml"), "").unwrap();
        let vault = dir.join("vault.tar.age");
        export(&config, &vault, "right", None).expect("export");

        let file = File::open(&vault).unwrap();
        let age::Decryptor::Passphrase(d) = age::Decryptor::new(file).unwrap() else {
            panic!("expected passphrase vault");
        };
        assert!(d.decrypt(&Secret::new("wrong".into()), None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_passphrase_and_missing_dir_refuse() {
        let dir = scratch("refuse");
        let config = dir.join("config");
        std::fs::create_dir_all(&config).unwrap();
        let vault = dir.join("vault.tar.age");
        assert!(export(&config, &vault, "", None).is_err());
        assert!(export(&dir.join("nope"), &vault, "pw", None).is_err());
        assert!(!vault.exists(), "no partial file left behind");
        std::fs::remove_dir_all(&dir).ok();
    }
}
