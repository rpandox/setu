//! ssh-agent introspection (F8, Phase 7): who's loaded, per `ssh-add -l`.
//!
//! The Keys panel lists the agent's identities with fingerprints, and an
//! unreachable/absent agent becomes a guidance banner rather than a silent
//! failure (PLAN.md §9 F8 edge case). This module only *reads* — Setu
//! never adds or removes agent identities on its own.

use std::process::Command;

/// One identity the agent holds, as `ssh-add -l` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentKey {
    /// Key algorithm from the trailing parens, e.g. `"ED25519"` or
    /// `"ED25519-SK"` (hardware-backed).
    pub algorithm: String,
    /// OpenSSH `SHA256:<base64>` fingerprint.
    pub fingerprint: String,
    /// The key's comment — usually a path or `user@host`.
    pub comment: String,
}

/// What the agent looks like right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStatus {
    /// Whether an agent is reachable at all.
    pub available: bool,
    /// Loaded identities (empty is a normal state for a fresh agent).
    pub keys: Vec<AgentKey>,
    /// One plain sentence for the banner when something's off.
    pub note: Option<String>,
}

/// Queries the ssh-agent via `ssh-add -l`.
///
/// No `SSH_AUTH_SOCK` means no agent (the F8 guidance banner); exit code 1
/// is the agent's own "no identities" answer — available, just empty.
pub fn list() -> AgentStatus {
    if std::env::var_os("SSH_AUTH_SOCK").is_none() {
        return AgentStatus {
            available: false,
            keys: Vec::new(),
            note: Some("No ssh-agent is running (SSH_AUTH_SOCK is unset).".to_string()),
        };
    }
    let output = match Command::new("ssh-add").arg("-l").output() {
        Ok(output) => output,
        Err(e) => {
            return AgentStatus {
                available: false,
                keys: Vec::new(),
                note: Some(format!("Couldn't run ssh-add: {e}")),
            };
        }
    };
    match output.status.code() {
        Some(0) => AgentStatus {
            available: true,
            keys: parse_list(&String::from_utf8_lossy(&output.stdout)),
            note: None,
        },
        Some(1) => AgentStatus {
            available: true,
            keys: Vec::new(),
            note: None,
        },
        _ => AgentStatus {
            available: false,
            keys: Vec::new(),
            note: Some("Couldn't reach the ssh-agent behind SSH_AUTH_SOCK.".to_string()),
        },
    }
}

/// Parses `ssh-add -l` lines: `<bits> <fingerprint> <comment…> (<TYPE>)`.
/// Unrecognizable lines are skipped — a listing must never fail over one
/// odd row.
fn parse_list(text: &str) -> Vec<AgentKey> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let mut parts = line.split_whitespace();
            let _bits = parts.next()?;
            let fingerprint = parts.next()?.to_string();
            let rest: Vec<&str> = parts.collect();
            let (comment, algorithm) = match rest.split_last() {
                Some((last, front)) if last.starts_with('(') && last.ends_with(')') => (
                    front.join(" "),
                    last.trim_matches(|c| c == '(' || c == ')').to_string(),
                ),
                _ => (rest.join(" "), String::new()),
            };
            if !fingerprint.contains(':') {
                return None;
            }
            Some(AgentKey {
                algorithm,
                fingerprint,
                comment,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_listing_lines() {
        let text = "\
256 SHA256:Yk3yqJDVCyDzx0Qw5cqX0Zl4Yl0m0kq6cW9nQ4b7f2M /Users/pandox/.ssh/id_ed25519 (ED25519)
256 SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA pandox@hermes (ED25519-SK)
3072 SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB legacy deploy key (RSA)
";
        let keys = parse_list(text);
        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0].algorithm, "ED25519");
        assert_eq!(keys[0].comment, "/Users/pandox/.ssh/id_ed25519");
        assert_eq!(keys[1].algorithm, "ED25519-SK");
        assert_eq!(keys[2].comment, "legacy deploy key");
        assert!(keys[2].fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn skips_lines_that_are_not_keys() {
        assert!(parse_list("The agent has no identities.\n").is_empty());
        assert!(parse_list("").is_empty());
    }
}
