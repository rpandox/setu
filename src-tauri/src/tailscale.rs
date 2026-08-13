//! Tailscale awareness (F9, Phase 7): the tailnet as a host source.
//!
//! When the `tailscale` binary is present (PATH, Homebrew, or inside the
//! Tailscale.app bundle — [`crate::binaries::find`]), `tailscale status
//! --json` yields the peer list the sidebar's Tailnet section renders.
//! Peer LEDs mirror Tailscale's **own** online state — these rows are
//! never TCP-probed (PLAN.md §3). Peers are ephemeral (`source =
//! "tailscale"`, never persisted); "Adopt as host" copies one into
//! `hosts.toml`.
//!
//! Resolution is stateless on purpose (PLAN.md §5, Phase 7 row): a peer's
//! host id is `ts:{stableId}`, and every spawn re-runs `status --json` —
//! the exact mirror of the `sshcfg:` fresh-parse. Spawns are rare; a
//! cache would only add an invalidation problem.
//!
//! Parsing is deliberately defensive: every field except the id is
//! optional with a default, the self node is excluded, and a logged-out
//! or stopped daemon is a normal `available: false` answer — the section
//! hides, nothing errors (F9 edge case).

use serde::Deserialize;

use crate::binaries;
use crate::store::{Host, HostSource};

/// Host-id prefix for tailnet peers (mirrors `sshcfg:`).
pub const ID_PREFIX: &str = "ts:";

/// One tailnet peer, ready for the frontend (mirrors `TailscalePeer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    /// Stable host id: `ts:{Tailscale node id}`.
    pub id: String,
    /// MagicDNS name without the trailing dot, e.g.
    /// `hermes.tail1234.ts.net`.
    pub dns_name: String,
    /// The device's short hostname, the row's display label.
    pub host_name: String,
    /// Operating system as Tailscale reports it (`linux`, `macOS`, …).
    pub os: String,
    /// Tailscale's own online state — the LED, no probe.
    pub online: bool,
    /// RFC 3339 last-seen timestamp for dimmed offline rows, when known.
    pub last_seen: Option<String>,
    /// ACL tags (`tag:prod`, …), possibly empty.
    pub tags: Vec<String>,
    /// Whether the peer runs Tailscale SSH (the `ts-ssh` badge: key-free
    /// connect).
    pub ts_ssh: bool,
}

/// What the tailnet looks like right now (mirrors `TailscalePeersResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailnetStatus {
    /// Whether the section should exist at all: binary present, daemon
    /// running, logged in.
    pub available: bool,
    /// One plain sentence when unavailable (`"not installed"`,
    /// `"logged out"`, `"stopped"`).
    pub reason: Option<String>,
    /// The default login user for one-click connects (`[tailnet]` in
    /// settings.toml, falling back to the local `$USER`).
    pub default_user: String,
    /// Live peers, self excluded, MagicDNS-sorted.
    pub peers: Vec<Peer>,
}

/// `tailscale status --json`, the parts Setu reads (ipnstate.Status).
#[derive(Debug, Deserialize)]
struct StatusJson {
    /// `"Running"`, `"Stopped"`, `"NeedsLogin"`, …
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    /// This machine — excluded from the peer list.
    #[serde(rename = "Self", default)]
    self_node: Option<PeerJson>,
    /// Peers keyed by node public key; the key itself is unused.
    #[serde(rename = "Peer", default)]
    peer: Option<std::collections::BTreeMap<String, PeerJson>>,
}

/// One ipnstate.PeerStatus, defensively optional except the id.
#[derive(Debug, Default, Deserialize)]
struct PeerJson {
    /// The stable node id (`"nXXXX"` / numeric string).
    #[serde(rename = "ID", default)]
    id: String,
    /// MagicDNS FQDN, usually with a trailing dot.
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    /// Short device hostname.
    #[serde(rename = "HostName", default)]
    host_name: String,
    /// `"linux"`, `"macOS"`, `"windows"`, `"iOS"`, `"android"`, …
    #[serde(rename = "OS", default)]
    os: String,
    /// Tailscale's own online verdict.
    #[serde(rename = "Online", default)]
    online: bool,
    /// RFC 3339; `0001-01-01T00:00:00Z` means "never"/currently online.
    #[serde(rename = "LastSeen", default)]
    last_seen: Option<String>,
    /// ACL tags, when the node has any.
    #[serde(rename = "Tags", default)]
    tags: Option<Vec<String>>,
    /// Present and non-empty when the peer runs Tailscale SSH.
    #[serde(rename = "sshHostKeys", default)]
    ssh_host_keys: Option<Vec<String>>,
}

/// Queries the tailnet: binary discovery, `status --json`, parse.
///
/// # Errors
///
/// Fails only on infrastructure problems (the command couldn't run at
/// all in an unexpected way). Absent binary / stopped daemon / logged-out
/// states are `available: false` answers, not errors.
pub async fn status(settings_user: &str) -> Result<TailnetStatus, String> {
    let default_user = default_user(settings_user);
    let Some(binary) = binaries::find("tailscale") else {
        return Ok(unavailable("not installed", default_user));
    };
    let output = tokio::process::Command::new(&binary)
        .args(["status", "--json"])
        .output()
        .await
        .map_err(|e| format!("couldn't run tailscale: {e}"))?;
    // `tailscale status` exits non-zero for stopped/logged-out states but
    // still prints the JSON with BackendState — parse whatever came out,
    // and only fall back to a generic reason when there's nothing to parse.
    let text = String::from_utf8_lossy(&output.stdout);
    match parse_status(&text, default_user.clone()) {
        Some(status) => Ok(status),
        None => Ok(unavailable("not responding", default_user)),
    }
}

/// Resolves a `ts:` host id to an ephemeral [`Host`] record via a fresh
/// `status --json` — the `sshcfg:` mirror (PLAN.md §5).
///
/// # Errors
///
/// Fails when the tailnet is unavailable or the peer is gone.
pub async fn resolve_peer_host(host_id: &str, settings_user: &str) -> Result<Host, String> {
    let peer_id = host_id
        .strip_prefix(ID_PREFIX)
        .ok_or_else(|| format!("not a tailnet host: {host_id}"))?;
    let tailnet = status(settings_user).await?;
    if !tailnet.available {
        return Err(format!(
            "tailscale is {}",
            tailnet.reason.as_deref().unwrap_or("unavailable")
        ));
    }
    tailnet
        .peers
        .iter()
        .find(|peer| peer.id == format!("{ID_PREFIX}{peer_id}"))
        .map(|peer| peer_host(peer, &tailnet.default_user))
        .ok_or_else(|| format!("unknown tailnet peer: {peer_id}"))
}

/// Builds the ephemeral [`Host`] record behind a peer row: MagicDNS
/// hostname, the default tailnet user, agent identity, port 22. The hue
/// derives stably from the id so tabs get consistent accents.
pub fn peer_host(peer: &Peer, default_user: &str) -> Host {
    Host {
        id: peer.id.clone(),
        label: peer.host_name.clone(),
        hostname: peer.dns_name.clone(),
        user: default_user.to_string(),
        port: 22,
        identity: "agent".into(),
        hue: stable_hue(&peer.id),
        source: HostSource::Tailscale,
        // Tailnet rows are never TCP-probed — the LED is Tailscale's own
        // online state (PLAN.md §3).
        reachability: false,
        ..Host::default()
    }
}

/// The `[tailnet] default_user` fallback chain: setting → `$USER`.
fn default_user(settings_user: &str) -> String {
    if !settings_user.trim().is_empty() {
        return settings_user.trim().to_string();
    }
    std::env::var("USER").unwrap_or_else(|_| "root".into())
}

/// An `available: false` answer with its one-line reason.
fn unavailable(reason: &str, default_user: String) -> TailnetStatus {
    TailnetStatus {
        available: false,
        reason: Some(reason.to_string()),
        default_user,
        peers: Vec::new(),
    }
}

/// Parses a `status --json` document into a [`TailnetStatus`]. `None`
/// when the text isn't the expected JSON at all.
fn parse_status(text: &str, default_user: String) -> Option<TailnetStatus> {
    let parsed: StatusJson = serde_json::from_str(text).ok()?;
    match parsed.backend_state.as_str() {
        "Running" => {}
        "NeedsLogin" | "NoState" => return Some(unavailable("logged out", default_user)),
        _ => return Some(unavailable("stopped", default_user)),
    }
    let self_id = parsed
        .self_node
        .as_ref()
        .map(|node| node.id.clone())
        .unwrap_or_default();
    let mut peers: Vec<Peer> = parsed
        .peer
        .unwrap_or_default()
        .into_values()
        .filter(|node| !node.id.is_empty() && node.id != self_id)
        .map(|node| Peer {
            id: format!("{ID_PREFIX}{}", node.id),
            dns_name: node.dns_name.trim_end_matches('.').to_string(),
            host_name: if node.host_name.is_empty() {
                node.dns_name
                    .split('.')
                    .next()
                    .unwrap_or_default()
                    .to_string()
            } else {
                node.host_name
            },
            os: node.os,
            online: node.online,
            last_seen: node
                .last_seen
                .filter(|seen| !seen.starts_with("0001-01-01")),
            tags: node.tags.unwrap_or_default(),
            ts_ssh: node
                .ssh_host_keys
                .map(|keys| !keys.is_empty())
                .unwrap_or(false),
        })
        .collect();
    peers.sort_by(|a, b| a.dns_name.cmp(&b.dns_name));
    Some(TailnetStatus {
        available: true,
        reason: None,
        default_user,
        peers,
    })
}

/// A stable 0–7 hue from a peer id (FNV-1a folded to 3 bits).
fn stable_hue(id: &str) -> u8 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in id.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
    }
    (hash % 8) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic Running document: self + three peers (offline w/
    /// last-seen, ts-ssh + tags, minimal fields).
    const RUNNING: &str = r#"{
      "BackendState": "Running",
      "Self": {
        "ID": "self1",
        "DNSName": "this-mac.tail1234.ts.net.",
        "HostName": "this-mac",
        "OS": "macOS",
        "Online": true
      },
      "Peer": {
        "nodekey:aaa": {
          "ID": "peer-a",
          "DNSName": "hermes.tail1234.ts.net.",
          "HostName": "hermes",
          "OS": "linux",
          "Online": true,
          "Tags": ["tag:prod"],
          "sshHostKeys": ["ssh-ed25519 AAAA..."]
        },
        "nodekey:bbb": {
          "ID": "peer-b",
          "DNSName": "laptop.tail1234.ts.net.",
          "HostName": "laptop",
          "OS": "windows",
          "Online": false,
          "LastSeen": "2026-08-10T09:00:00Z"
        },
        "nodekey:ccc": {
          "ID": "peer-c",
          "DNSName": "bare.tail1234.ts.net."
        }
      }
    }"#;

    #[test]
    fn running_status_parses_peers_and_excludes_self() {
        let status = parse_status(RUNNING, "ops".into()).expect("parses");
        assert!(status.available);
        assert_eq!(status.peers.len(), 3, "self is excluded");
        assert!(status.peers.iter().all(|p| p.id != "ts:self1"));

        let hermes = &status.peers[1];
        assert_eq!(hermes.id, "ts:peer-a");
        assert_eq!(hermes.dns_name, "hermes.tail1234.ts.net");
        assert!(hermes.online);
        assert!(hermes.ts_ssh, "sshHostKeys ⇒ ts-ssh badge");
        assert_eq!(hermes.tags, vec!["tag:prod"]);

        let laptop = &status.peers[2];
        assert!(!laptop.online);
        assert_eq!(laptop.last_seen.as_deref(), Some("2026-08-10T09:00:00Z"));
        assert!(!laptop.ts_ssh);
    }

    #[test]
    fn minimal_peer_fields_default_cleanly() {
        let status = parse_status(RUNNING, "ops".into()).expect("parses");
        let bare = &status.peers[0];
        assert_eq!(bare.id, "ts:peer-c");
        assert_eq!(bare.host_name, "bare", "label falls back to DNS label");
        assert!(!bare.online);
        assert!(bare.tags.is_empty());
    }

    #[test]
    fn logged_out_and_stopped_hide_the_section() {
        let logged_out = parse_status(r#"{"BackendState":"NeedsLogin"}"#, "u".into()).unwrap();
        assert!(!logged_out.available);
        assert_eq!(logged_out.reason.as_deref(), Some("logged out"));

        let stopped = parse_status(r#"{"BackendState":"Stopped"}"#, "u".into()).unwrap();
        assert!(!stopped.available);
        assert_eq!(stopped.reason.as_deref(), Some("stopped"));
    }

    #[test]
    fn garbage_is_none_not_a_panic() {
        assert!(parse_status("not json at all", "u".into()).is_none());
    }

    #[test]
    fn never_seen_timestamps_are_dropped() {
        let doc = r#"{
          "BackendState": "Running",
          "Peer": { "k": { "ID": "x", "DNSName": "x.ts.net.", "LastSeen": "0001-01-01T00:00:00Z" } }
        }"#;
        let status = parse_status(doc, "u".into()).unwrap();
        assert_eq!(status.peers[0].last_seen, None);
    }

    #[test]
    fn peer_hosts_are_ephemeral_agent_first_records() {
        let status = parse_status(RUNNING, "ops".into()).unwrap();
        let host = peer_host(&status.peers[1], &status.default_user);
        assert_eq!(host.id, "ts:peer-a");
        assert_eq!(host.hostname, "hermes.tail1234.ts.net");
        assert_eq!(host.user, "ops");
        assert_eq!(host.identity, "agent");
        assert_eq!(host.source, HostSource::Tailscale);
        assert_eq!(host.port, 22);
        // Stable hue: same id, same hue, every time.
        assert_eq!(host.hue, peer_host(&status.peers[1], "other").hue);
        assert!(host.hue < 8);
    }

    #[test]
    fn default_user_prefers_the_setting_then_env() {
        assert_eq!(default_user("ops"), "ops");
        assert_eq!(default_user("  "), std::env::var("USER").unwrap());
    }
}
