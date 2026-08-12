//! A deliberately small `~/.ssh/config` reader for the F1 import flow.
//!
//! Setu never re-implements ssh's config semantics — connections to imported
//! rows pass the **bare alias** to system `ssh`, which applies the real
//! config (ProxyJump, IdentityFile, wildcard `Host *` options, Match blocks,
//! Include files, …) itself. This parser only needs enough to *show* the
//! user their aliases and prefill the Adopt flow, so it reads the §9 F1
//! subset: `Host` blocks and their `HostName`, `User`, `Port`,
//! `IdentityFile`, and `ProxyJump` values.
//!
//! Parsing rules:
//! - One row per concrete alias; a `Host` line may declare several.
//! - Wildcard patterns (`*`, `?`, `!` negations) never become rows — their
//!   options still apply at connect time via system ssh (F1 edge case).
//! - The first value of an option wins within a block, matching ssh.
//! - `Match` blocks and unknown directives (including `Include`) are
//!   skipped without error.
//!
//! Imported rows are ephemeral: re-parsed on every listing, never persisted
//! (`PLAN.md` §4) — "Adopt" copies a row into `hosts.toml`.

use std::path::{Path, PathBuf};

use crate::store::{Host, HostSource};

/// Prefix of the stable synthetic id given to imported rows
/// (`sshcfg:<alias>`).
pub const ID_PREFIX: &str = "sshcfg:";

/// One concrete `Host` alias parsed from an ssh config file.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConfigEntry {
    /// The alias — the word after `Host` and what `ssh` is invoked with.
    pub alias: String,
    /// `HostName`, when present (absent = ssh uses the alias itself).
    pub hostname: Option<String>,
    /// `User`, when present.
    pub user: Option<String>,
    /// `Port`, when present and numeric.
    pub port: Option<u16>,
    /// First `IdentityFile`, when present.
    pub identity: Option<String>,
    /// `ProxyJump`, when present. Display-only: the jump itself is always
    /// performed by system ssh via the alias.
    pub proxy_jump: Option<String>,
}

/// The canonical config location: `~/.ssh/config`.
pub fn default_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh/config"))
}

/// Reads and parses `path`. A missing or unreadable file is an empty list —
/// importing is best-effort by design.
pub fn load(path: &Path) -> Vec<ConfigEntry> {
    std::fs::read_to_string(path)
        .map(|text| parse(&text))
        .unwrap_or_default()
}

/// Parses ssh config text into concrete host entries (see module docs for
/// exactly what subset is honored).
pub fn parse(text: &str) -> Vec<ConfigEntry> {
    let mut entries: Vec<ConfigEntry> = Vec::new();
    // Indices into `entries` for the aliases of the current Host block;
    // empty while outside any block or inside a skipped Match block.
    let mut current: Vec<usize> = Vec::new();

    for line in text.lines() {
        let Some((key, value)) = split_directive(line) else {
            continue;
        };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                current.clear();
                for pattern in value.split_whitespace() {
                    let alias = unquote(pattern);
                    if alias.contains(['*', '?']) || alias.starts_with('!') {
                        continue; // wildcards never become rows (F1)
                    }
                    current.push(entries.len());
                    entries.push(ConfigEntry {
                        alias: alias.to_string(),
                        ..ConfigEntry::default()
                    });
                }
            }
            // A Match block ends the current Host block; its options must
            // not leak into rows.
            "match" => current.clear(),
            "hostname" => set_all(&mut entries, &current, |e| &mut e.hostname, value),
            "user" => set_all(&mut entries, &current, |e| &mut e.user, value),
            "port" => {
                if let Ok(port) = unquote(value).parse::<u16>() {
                    for &i in &current {
                        entries[i].port.get_or_insert(port);
                    }
                }
            }
            "identityfile" => set_all(&mut entries, &current, |e| &mut e.identity, value),
            "proxyjump" => set_all(&mut entries, &current, |e| &mut e.proxy_jump, value),
            _ => {} // unknown directives (Include, ForwardAgent, …) are fine
        }
    }
    entries
}

/// Converts a parsed entry to the read-only [`Host`] row shown in the
/// sidebar: `source = "ssh_config"`, id `sshcfg:<alias>`, connectable via
/// the bare alias.
pub fn to_host(entry: &ConfigEntry) -> Host {
    Host {
        id: format!("{ID_PREFIX}{}", entry.alias),
        label: entry.alias.clone(),
        // Absent HostName means ssh resolves the alias itself; the row shows
        // that truthfully as an empty hostname.
        hostname: entry.hostname.clone().unwrap_or_default(),
        user: entry.user.clone().unwrap_or_default(),
        port: entry.port.unwrap_or(22),
        identity: entry.identity.clone().unwrap_or_else(|| "agent".into()),
        source: HostSource::SshConfig,
        ..Host::default()
    }
}

/// Converts a parsed entry to an adoptable draft: `source = "setu"`, empty
/// id (the store assigns a UUID), and — because an adopted row no longer
/// connects via the alias — an absent `HostName` falls back to the alias,
/// which is exactly what ssh would have resolved.
pub fn to_adoptable_host(entry: &ConfigEntry) -> Host {
    Host {
        id: String::new(),
        hostname: entry
            .hostname
            .clone()
            .unwrap_or_else(|| entry.alias.clone()),
        source: HostSource::Setu,
        ..to_host(entry)
    }
}

/// Splits a config line into `(keyword, rest)`, honoring both `Key value`
/// and `Key=value` forms. Comments and blank lines return `None`.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let split_at = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (key, rest) = line.split_at(split_at);
    let value = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    if value.is_empty() {
        return None;
    }
    Some((key, value))
}

/// Strips one pair of surrounding double quotes, if present.
fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
}

/// Sets an optional string field on every current entry, first value wins.
fn set_all(
    entries: &mut [ConfigEntry],
    current: &[usize],
    field: impl Fn(&mut ConfigEntry) -> &mut Option<String>,
    value: &str,
) {
    for &i in current {
        field(&mut entries[i]).get_or_insert_with(|| unquote(value).to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_simple_block() {
        let entries = parse(
            "Host hermes\n  HostName hermes.tailnet.ts.net\n  User pandox\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519\n",
        );
        assert_eq!(
            entries,
            vec![ConfigEntry {
                alias: "hermes".into(),
                hostname: Some("hermes.tailnet.ts.net".into()),
                user: Some("pandox".into()),
                port: Some(2222),
                identity: Some("~/.ssh/id_ed25519".into()),
                proxy_jump: None,
            }]
        );
    }

    #[test]
    fn wildcard_patterns_never_become_rows_but_concrete_siblings_do() {
        let entries =
            parse("Host * !prod-* web-?\n  User nobody\nHost atlas *.internal\n  User deploy\n");
        let aliases: Vec<&str> = entries.iter().map(|e| e.alias.as_str()).collect();
        assert_eq!(aliases, vec!["atlas"]);
        assert_eq!(entries[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn multiple_aliases_share_one_block() {
        let entries = parse("Host web1 web2\n  HostName web.internal\n  ProxyJump bastion\n");
        assert_eq!(entries.len(), 2);
        for (entry, alias) in entries.iter().zip(["web1", "web2"]) {
            assert_eq!(entry.alias, alias);
            assert_eq!(entry.hostname.as_deref(), Some("web.internal"));
            assert_eq!(entry.proxy_jump.as_deref(), Some("bastion"));
        }
    }

    #[test]
    fn first_value_wins_and_equals_form_is_honored() {
        let entries = parse("Host dev\nUser=first\nUser second\nPort = 22022\n");
        assert_eq!(entries[0].user.as_deref(), Some("first"));
        assert_eq!(entries[0].port, Some(22022));
    }

    #[test]
    fn comments_blanks_match_blocks_and_unknown_directives_are_skipped() {
        let entries = parse(
            "# global\nInclude config.d/*\n\nHost jump\n  HostName jump.example.net\n\nMatch user root\n  HostName should-not-leak\n\nHost after-match\n",
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].alias, "jump");
        assert_eq!(entries[0].hostname.as_deref(), Some("jump.example.net"));
        // Options inside the Match block must not attach to any row.
        assert_eq!(entries[1].alias, "after-match");
        assert_eq!(entries[1].hostname, None);
    }

    #[test]
    fn quoted_values_are_unquoted() {
        let entries = parse("Host padded\n  IdentityFile \"~/.ssh/key with spaces\"\n");
        assert_eq!(
            entries[0].identity.as_deref(),
            Some("~/.ssh/key with spaces")
        );
    }

    #[test]
    fn alias_only_entries_are_kept_and_adoptable() {
        let entries = parse("Host bare\n");
        assert_eq!(entries[0].hostname, None);

        let row = to_host(&entries[0]);
        assert_eq!(row.id, "sshcfg:bare");
        assert_eq!(row.hostname, "");
        assert_eq!(row.source, HostSource::SshConfig);

        let draft = to_adoptable_host(&entries[0]);
        assert_eq!(draft.id, "");
        assert_eq!(draft.hostname, "bare", "adopt falls back to the alias");
        assert_eq!(draft.source, HostSource::Setu);
    }

    #[test]
    fn missing_file_loads_as_empty() {
        assert_eq!(load(Path::new("/definitely/not/here")), Vec::new());
    }
}
