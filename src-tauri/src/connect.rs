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

/// Flags applied to every managed `ssh -N` forward child (F7, `PLAN.md` §5):
/// a failed bind exits ssh instead of limping on, and BatchMode turns any
/// would-be interactive prompt (auth, unknown host key) into a fast failure
/// the health machine can read — a `-N` child has no terminal to ask in.
const FORWARD_ARGS: [&str; 4] = ["-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes"];

/// The destination tail of an ssh argv: the bare alias for imported rows
/// (system ssh applies the user's real config — ProxyJump included), or
/// explicit `-p`/`-i`/`user@hostname` flags for Setu-owned rows.
fn destination_args(host: &Host) -> Vec<String> {
    let mut argv: Vec<String> = Vec::new();
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
    argv
}

/// Builds the exact `ssh` argv for `host` (see module docs for the shape).
///
/// Pure and fully unit-tested; [`ssh_command`] wraps the result in a
/// [`CommandBuilder`] for spawning.
pub fn ssh_argv(host: &Host) -> Vec<String> {
    let mut argv: Vec<String> = vec!["ssh".into(), "-tt".into()];
    argv.extend(KEEPALIVE_ARGS.iter().map(|s| s.to_string()));
    argv.extend(destination_args(host));

    let startup = host.startup.trim();
    if !startup.is_empty() {
        argv.push("--".into());
        // One argv entry: ssh joins remaining args with spaces and hands
        // them to the remote shell, so no local quoting is needed.
        argv.push(startup.to_string());
    }
    argv
}

/// Builds the argv for a managed `ssh -N` forward child (F7):
///
/// ```text
/// ssh -N -o ExitOnForwardFailure=yes -o BatchMode=yes \
///     [-o UserKnownHostsFile="$HOME/.ssh/known_hosts"] \
///     -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
///     -L|-R|-D <spec> <host flags | bare alias>
/// ```
///
/// No `-tt` (there is no terminal) and no `-- <startup>` (nothing runs
/// remotely). `kind` is `"L"`, `"R"`, or `"D"` — validated upstream by
/// [`crate::forwards::parse_forward_spec`].
///
/// The explicit `UserKnownHostsFile` pins the child's trust database to
/// the **process environment's** home (`$HOME/.ssh/known_hosts`) instead
/// of ssh's passwd-database lookup. For a normal launch the two are the
/// same file; the difference is that the app's whole view of "home" —
/// store paths included — follows `$HOME`, so its ssh children should
/// too (and the live e2e suite relies on it to stay hermetic).
pub fn forward_argv(host: &Host, kind: &str, spec: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec!["ssh".into(), "-N".into()];
    argv.extend(FORWARD_ARGS.iter().map(|s| s.to_string()));
    if let Some(home) = dirs::home_dir() {
        argv.push("-o".into());
        // Quoted so a home path containing spaces stays one file name.
        argv.push(format!(
            "UserKnownHostsFile=\"{}\"",
            home.join(".ssh/known_hosts").display()
        ));
    }
    argv.extend(KEEPALIVE_ARGS.iter().map(|s| s.to_string()));
    argv.push(format!("-{kind}"));
    argv.push(spec.to_string());
    argv.extend(destination_args(host));
    argv
}

/// Builds the spawnable command for `host`: [`ssh_argv`] plus the standard
/// terminal environment ([`apply_terminal_env`]).
pub fn ssh_command(host: &Host) -> CommandBuilder {
    command_from(ssh_argv(host))
}

/// Builds the exact `mosh` argv for `host` (F3 matrix row, Phase 7):
///
/// ```text
/// mosh [--ssh=ssh -p N -i <key>] <user@hostname | alias> [-- <startup…>]
/// ```
///
/// No `-tt` and no keepalive flags — mosh manages its own terminal and
/// runs over UDP with built-in roaming (that's the point). Port and
/// identity travel inside `--ssh` (mosh only uses ssh for the initial
/// handshake); imported rows keep their bare alias. The startup command
/// splits on whitespace into separate args after `--`, exactly as it
/// would be typed on a mosh command line.
pub fn mosh_argv(host: &Host, mosh_path: &str) -> Vec<String> {
    let mut argv: Vec<String> = vec![mosh_path.to_string()];
    if host.source != HostSource::SshConfig {
        let mut ssh_parts: Vec<String> = Vec::new();
        if host.port != 22 {
            ssh_parts.push(format!("-p {}", host.port));
        }
        let identity = host.identity.trim();
        if identity != "agent" && !identity.is_empty() {
            let expanded = expand_tilde(identity).to_string_lossy().into_owned();
            // mosh shell-splits the --ssh value; a space in the path must
            // stay one word.
            if expanded.contains(' ') {
                ssh_parts.push(format!("-i '{expanded}'"));
            } else {
                ssh_parts.push(format!("-i {expanded}"));
            }
        }
        if !ssh_parts.is_empty() {
            argv.push(format!("--ssh=ssh {}", ssh_parts.join(" ")));
        }
    }
    if host.source == HostSource::SshConfig {
        argv.push(host.label.clone());
    } else if host.user.is_empty() {
        argv.push(host.hostname.clone());
    } else {
        argv.push(format!("{}@{}", host.user, host.hostname));
    }
    let startup = host.startup.trim();
    if !startup.is_empty() {
        argv.push("--".into());
        argv.extend(startup.split_whitespace().map(String::from));
    }
    argv
}

/// Builds the spawnable mosh command for `host`. `mosh_path` is the
/// absolute path from [`crate::binaries::find`] — a GUI app's minimal
/// `PATH` usually can't see Homebrew's mosh, so the resolved path is used
/// for spawning too.
pub fn mosh_command(host: &Host, mosh_path: &str) -> CommandBuilder {
    command_from(mosh_argv(host, mosh_path))
}

/// Wraps an argv in a [`CommandBuilder`] with the standard terminal
/// environment (UTF-8 locale included — mosh refuses to start without
/// one).
fn command_from(argv: Vec<String>) -> CommandBuilder {
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
        let tail: Vec<&str> = argv
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(String::as_str)
            .collect();
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

    #[test]
    fn forward_argv_has_no_tty_and_fails_fast() {
        let argv = forward_argv(&setu_host(), "L", "8080:localhost:8080");
        let mut expected: Vec<String> = [
            "ssh",
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "BatchMode=yes",
        ]
        .map(String::from)
        .to_vec();
        // The child's trust database follows the process's $HOME (module docs).
        let home = dirs::home_dir().expect("home dir in tests");
        expected.push("-o".into());
        expected.push(format!(
            "UserKnownHostsFile=\"{}\"",
            home.join(".ssh/known_hosts").display()
        ));
        expected.extend(KEEPALIVE.map(String::from));
        expected
            .extend(["-L", "8080:localhost:8080", "pandox@hermes.example.net"].map(String::from));
        assert_eq!(argv, expected);
    }

    #[test]
    fn mosh_argv_uses_plain_destination_without_tty_flags() {
        let argv = mosh_argv(&setu_host(), "/opt/homebrew/bin/mosh");
        assert_eq!(
            argv,
            vec!["/opt/homebrew/bin/mosh", "pandox@hermes.example.net"]
        );
    }

    #[test]
    fn mosh_argv_carries_port_and_identity_inside_ssh() {
        let mut host = setu_host();
        host.port = 2222;
        host.identity = "/tmp/id_ed25519".into();
        let argv = mosh_argv(&host, "mosh");
        assert_eq!(
            argv,
            vec![
                "mosh",
                "--ssh=ssh -p 2222 -i /tmp/id_ed25519",
                "pandox@hermes.example.net",
            ]
        );
    }

    #[test]
    fn mosh_argv_quotes_identity_paths_with_spaces() {
        let mut host = setu_host();
        host.identity = "/tmp/my keys/id".into();
        let argv = mosh_argv(&host, "mosh");
        assert_eq!(argv[1], "--ssh=ssh -i '/tmp/my keys/id'");
    }

    #[test]
    fn mosh_argv_splits_startup_into_separate_args() {
        let mut host = setu_host();
        host.startup = "tmux new -A -s main".into();
        let argv = mosh_argv(&host, "mosh");
        let tail: Vec<&str> = argv.iter().skip(2).map(String::as_str).collect();
        assert_eq!(tail, vec!["--", "tmux", "new", "-A", "-s", "main"]);
    }

    #[test]
    fn mosh_argv_keeps_the_bare_alias_for_imports() {
        let mut host = setu_host();
        host.source = HostSource::SshConfig;
        host.port = 2222;
        host.identity = "~/.ssh/id_ed25519".into();
        let argv = mosh_argv(&host, "mosh");
        // The alias carries the user's real ssh config — no --ssh flags.
        assert_eq!(argv, vec!["mosh", "hermes"]);
    }

    #[test]
    fn forward_argv_ignores_startup_and_uses_bare_alias_for_imports() {
        let mut host = setu_host();
        host.startup = "tmux new -A -s main".into();
        let argv = forward_argv(&host, "D", "1080");
        assert!(!argv.contains(&"--".to_string()), "no remote command");
        assert_eq!(argv.last().unwrap(), "pandox@hermes.example.net");

        host.source = HostSource::SshConfig;
        let argv = forward_argv(&host, "R", "9000:localhost:3000");
        assert_eq!(
            argv.last().unwrap(),
            "hermes",
            "imported rows use the alias"
        );
        assert!(argv.contains(&"-R".to_string()));
    }
}
