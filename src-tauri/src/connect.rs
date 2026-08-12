//! The SSH spawn pipeline: turning a [`Host`] into an `ssh` argv.
//!
//! Setu never implements the SSH protocol for interactive sessions — it
//! spawns the *system* `ssh` inside a PTY (`PLAN.md` §5), which inherits the
//! user's config, agent, jump hosts, `known_hosts`, and Tailscale SSH for
//! free. First-connect host-key prompts therefore appear *in the terminal*
//! and work like they always have.
//!
//! The argv shape is fixed by §9 F3:
//!
//! ```text
//! ssh -tt -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
//!     <host flags | bare alias> [-- <startup>]
//! ```
//!
//! Rows imported from `~/.ssh/config` (`source = "ssh_config"`) pass only
//! their **bare alias**, so system ssh applies the real config semantics —
//! ProxyJump included. Setu-owned rows pass explicit `-p`/`-i`/destination
//! flags built from the record.

use portable_pty::CommandBuilder;

use crate::pty::apply_terminal_env;
use crate::store::{expand_tilde, Host, HostSource};

/// Keepalive flags applied to every SSH session (F3): drop dead links after
/// 30 s × 3 missed probes.
const KEEPALIVE_ARGS: [&str; 4] = [
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
];

/// Builds the exact `ssh` argv for `host` (see module docs for the shape).
///
/// Pure and fully unit-tested; [`ssh_command`] wraps the result in a
/// [`CommandBuilder`] for spawning.
pub fn ssh_argv(host: &Host) -> Vec<String> {
    let mut argv: Vec<String> = vec!["ssh".into(), "-tt".into()];
    argv.extend(KEEPALIVE_ARGS.iter().map(|s| s.to_string()));

    if host.source == HostSource::SshConfig {
        // The alias is the whole point: system ssh applies the user's real
        // config (ProxyJump, IdentityFile, wildcard options, …) itself.
        argv.push(host.label.clone());
    } else {
        if host.port != 22 {
            argv.push("-p".into());
            argv.push(host.port.to_string());
        }
        let identity = host.identity.trim();
        if identity != "agent" && !identity.is_empty() {
            argv.push("-i".into());
            argv.push(expand_tilde(identity).to_string_lossy().into_owned());
        }
        if host.user.is_empty() {
            argv.push(host.hostname.clone());
        } else {
            argv.push(format!("{}@{}", host.user, host.hostname));
        }
    }

    let startup = host.startup.trim();
    if !startup.is_empty() {
        argv.push("--".into());
        // One argv entry: ssh joins remaining args with spaces and hands
        // them to the remote shell, so no local quoting is needed.
        argv.push(startup.to_string());
    }
    argv
}

/// Builds the spawnable command for `host`: [`ssh_argv`] plus the standard
/// terminal environment ([`apply_terminal_env`]).
pub fn ssh_command(host: &Host) -> CommandBuilder {
    let argv = ssh_argv(host);
    let mut cmd = CommandBuilder::new(&argv[0]);
    for arg in &argv[1..] {
        cmd.arg(arg);
    }
    apply_terminal_env(&mut cmd);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setu_host() -> Host {
        Host {
            id: "id-1".into(),
            label: "hermes".into(),
            hostname: "hermes.example.net".into(),
            user: "pandox".into(),
            ..Host::default()
        }
    }

    const KEEPALIVE: [&str; 4] = [
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
    ];

    #[test]
    fn setu_host_uses_explicit_destination_with_keepalives() {
        let argv = ssh_argv(&setu_host());
        let mut expected = vec!["ssh", "-tt"];
        expected.extend(KEEPALIVE);
        expected.push("pandox@hermes.example.net");
        assert_eq!(argv, expected);
    }

    #[test]
    fn non_default_port_and_key_identity_add_flags() {
        let mut host = setu_host();
        host.port = 2222;
        host.identity = "/tmp/id_ed25519".into();
        let argv = ssh_argv(&host);
        let mut expected = vec!["ssh", "-tt"];
        expected.extend(KEEPALIVE);
        expected.extend([
            "-p",
            "2222",
            "-i",
            "/tmp/id_ed25519",
            "pandox@hermes.example.net",
        ]);
        assert_eq!(argv, expected);
    }

    #[test]
    fn tilde_identity_is_expanded() {
        let mut host = setu_host();
        host.identity = "~/.ssh/id_ed25519".into();
        let argv = ssh_argv(&host);
        let identity = &argv[argv.iter().position(|a| a == "-i").expect("-i flag") + 1];
        assert!(
            !identity.starts_with('~'),
            "identity must be expanded, got {identity}"
        );
        assert!(identity.ends_with(".ssh/id_ed25519"));
    }

    #[test]
    fn empty_user_omits_the_at_sign() {
        let mut host = setu_host();
        host.user = String::new();
        assert_eq!(ssh_argv(&host).last().unwrap(), "hermes.example.net");
    }

    #[test]
    fn startup_is_appended_after_double_dash_as_one_arg() {
        let mut host = setu_host();
        host.startup = "tmux new -A -s main".into();
        let argv = ssh_argv(&host);
        let tail: Vec<&str> = argv.iter().rev().take(3).rev().map(String::as_str).collect();
        assert_eq!(
            tail,
            vec!["pandox@hermes.example.net", "--", "tmux new -A -s main"]
        );
    }

    #[test]
    fn ssh_config_host_connects_via_bare_alias_only() {
        let host = Host {
            id: "sshcfg:hermes".into(),
            label: "hermes".into(),
            // Parsed metadata must NOT become flags: the alias carries the
            // user's real config, ProxyJump included.
            hostname: "hermes.tailnet.ts.net".into(),
            user: "pandox".into(),
            port: 2222,
            identity: "~/.ssh/id_ed25519".into(),
            source: HostSource::SshConfig,
            ..Host::default()
        };
        let mut expected = vec!["ssh", "-tt"];
        expected.extend(KEEPALIVE);
        expected.push("hermes");
        assert_eq!(ssh_argv(&host), expected);
    }

    #[test]
    fn agent_identity_adds_no_flag() {
        let argv = ssh_argv(&setu_host());
        assert!(!argv.contains(&"-i".to_string()));
    }
}
