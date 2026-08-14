//! macOS Keychain access for Setu's secrets (F8, Phase 7).
//!
//! Secrets — a host's SFTP password, a private key's passphrase — live only
//! in the user's Keychain under the service `dev.pandox.setu` (PLAN.md §3;
//! `CLAUDE.md` hard rule: never on disk, never in logs). This module is the
//! single doorway to that service, and it is deliberately asymmetric: the
//! IPC surface exposes `set` / `delete` / `has`, while `get` is
//! crate-internal — a stored secret is read only inside the Rust core (the
//! SFTP auth ladder, F8) and never flows toward the WebView (PLAN.md §5,
//! Phase 7 decision row).
//!
//! Accounts are deterministic so an entry can always be re-addressed:
//!
//! - `password:{host_uuid}` — the host's SFTP password (host-scoped).
//! - `passphrase:{path}` — a key file's passphrase, keyed by the
//!   tilde-expanded path so two hosts sharing a key share one entry.

use crate::store::expand_tilde;

/// The Keychain service every Setu entry lives under (PLAN.md §4).
pub const SERVICE: &str = "dev.pandox.setu";

/// Addresses one Keychain entry (mirrors `KeychainSecretRef` in
/// `contract.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretRef {
    /// A host's SFTP password.
    Password {
        /// The owning host (`Host.id`).
        host_id: String,
    },
    /// A private key's passphrase.
    Passphrase {
        /// Path to the key file; tilde-expanded before keying so `~/…` and
        /// its absolute form address the same entry.
        key_path: String,
    },
}

impl SecretRef {
    /// The deterministic Keychain account string for this secret.
    pub fn account(&self) -> String {
        match self {
            SecretRef::Password { host_id } => format!("password:{host_id}"),
            SecretRef::Passphrase { key_path } => {
                format!("passphrase:{}", expand_tilde(key_path).display())
            }
        }
    }
}

/// Opens the Keychain entry behind `reference`.
fn entry(reference: &SecretRef) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &reference.account())
        .map_err(|e| format!("keychain unavailable: {e}"))
}

/// Stores a secret, replacing any existing entry at the same address.
///
/// # Errors
///
/// Fails when the Keychain refuses the write (locked keychain, denied
/// authorization). The error message never contains the secret.
pub fn set(reference: &SecretRef, secret: &str) -> Result<(), String> {
    entry(reference)?
        .set_password(secret)
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Deletes a secret. A missing entry is a no-op (idempotent delete).
///
/// # Errors
///
/// Fails when the Keychain refuses the delete for any reason other than
/// the entry not existing.
pub fn delete(reference: &SecretRef) -> Result<(), String> {
    match entry(reference)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

/// Whether an entry exists at the address — only the boolean leaves this
/// module; the secret read to answer it is dropped on the spot.
///
/// # Errors
///
/// Fails when the Keychain cannot be queried at all.
pub fn has(reference: &SecretRef) -> Result<bool, String> {
    Ok(get(reference)?.is_some())
}

/// Reads a secret. Crate-internal by design (PLAN.md §5, Phase 7 row):
/// the only callers live in the Rust core — secrets never cross IPC.
///
/// # Errors
///
/// Fails when the Keychain refuses the read; a missing entry is
/// `Ok(None)`, not an error.
pub(crate) fn get(reference: &SecretRef) -> Result<Option<String>, String> {
    match entry(reference)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{LazyLock, Mutex};

    use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};

    use super::*;

    /// The shared map behind [`SharedMockCredential`] — keyring's own mock
    /// gives every `Entry` an *independent* in-memory slot, which can't
    /// exercise set-then-reopen flows, so tests bring their own store.
    static STORE: LazyLock<Mutex<BTreeMap<String, Vec<u8>>>> =
        LazyLock::new(|| Mutex::new(BTreeMap::new()));

    /// A credential backed by [`STORE`], keyed by `service\0account`.
    struct SharedMockCredential {
        key: String,
    }

    impl CredentialApi for SharedMockCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            STORE
                .lock()
                .unwrap()
                .insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            STORE
                .lock()
                .unwrap()
                .get(&self.key)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            STORE
                .lock()
                .unwrap()
                .remove(&self.key)
                .map(|_| ())
                .ok_or(keyring::Error::NoEntry)
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    /// Builds [`SharedMockCredential`]s for whatever service/account the
    /// code under test asks for.
    struct SharedMockBuilder;

    impl CredentialBuilderApi for SharedMockBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(SharedMockCredential {
                key: format!("{service}\u{0}{user}"),
            }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    /// Swaps the process-global credential store for the shared in-memory
    /// mock — exactly once, before the first `Entry` is created. Unit tests
    /// must never touch the real login keychain.
    fn use_mock_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            keyring::set_default_credential_builder(Box::new(SharedMockBuilder));
        });
    }

    #[test]
    fn password_accounts_are_host_scoped() {
        let reference = SecretRef::Password {
            host_id: "9f2c-uuid".into(),
        };
        assert_eq!(reference.account(), "password:9f2c-uuid");
    }

    #[test]
    fn passphrase_accounts_expand_tilde() {
        let tilded = SecretRef::Passphrase {
            key_path: "~/.ssh/id_ed25519".into(),
        };
        let absolute = SecretRef::Passphrase {
            key_path: expand_tilde("~/.ssh/id_ed25519").display().to_string(),
        };
        assert!(!tilded.account().contains('~'));
        assert_eq!(tilded.account(), absolute.account());
    }

    #[test]
    fn set_has_get_delete_roundtrip() {
        use_mock_store();
        let reference = SecretRef::Password {
            host_id: "roundtrip-host".into(),
        };
        assert!(!has(&reference).unwrap());
        assert_eq!(get(&reference).unwrap(), None);

        set(&reference, "s3cret").unwrap();
        assert!(has(&reference).unwrap());
        assert_eq!(get(&reference).unwrap().as_deref(), Some("s3cret"));

        set(&reference, "rotated").unwrap();
        assert_eq!(get(&reference).unwrap().as_deref(), Some("rotated"));

        delete(&reference).unwrap();
        assert!(!has(&reference).unwrap());
        // Idempotent: deleting a missing entry is a no-op.
        delete(&reference).unwrap();
    }
}
