//! Managed `ssh -N` port-forward children (F7, Phase 6).
//!
//! A forward rule (`Host.forwards`: `L`/`R`/`D` + spec) toggles a dedicated
//! system-`ssh` child running `-N` — no shell, no PTY, just the tunnel. The
//! [`ForwardManager`] owns those children: it pre-flights local ports (the
//! F7 port-conflict helper), spawns each child in **its own process group**,
//! health-checks the tunnel, and guarantees the group dies on toggle-off and
//! app exit — no orphans in `ps` (`PLAN.md` §10 Phase 6, `CLAUDE.md` hard
//! rule).
//!
//! Health model (`forward:update` events, one channel for all rules):
//!
//! - `starting` — the toggle was accepted, the child is being spawned.
//! - `amber` — the child is up; the tunnel hasn't answered a probe yet.
//! - `green` — `L`/`D`: a TCP connect to the local bind port succeeded
//!   (reusing [`crate::reach::probe_one`]); `R`: the child survived its
//!   startup grace (`ExitOnForwardFailure=yes` makes a failed remote bind
//!   exit fast, so surviving IS the signal).
//! - `red` — the child exited (reason carries the exit status and an
//!   in-memory stderr tail — never written to logs), or the local port
//!   stopped answering.
//!
//! Every child runs `-o ExitOnForwardFailure=yes -o BatchMode=yes`
//! (`PLAN.md` §5): silent bind failures and hanging auth or host-key
//! prompts all become fast exits the monitor can read. A host whose key
//! isn't in `known_hosts` yet must be trusted via a terminal connect first
//! (documented in F07).

use std::collections::{HashMap, VecDeque};
use std::net::TcpListener;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::connect;
use crate::reach::{self, ReachState};
use crate::store::{Forward, Host};

/// Seconds between health probes once a tunnel has gone green.
const PROBE_STEADY_SECS: u64 = 5;

/// Per-probe TCP connect timeout, matching the reachability prober's default.
const PROBE_TIMEOUT_MS: u64 = 1500;

/// Consecutive probe failures before a live child's tunnel reports red.
const PROBE_FAIL_THRESHOLD: u8 = 3;

/// Startup grace for `R` rules: surviving this long means the remote bind
/// succeeded (`ExitOnForwardFailure=yes` exits fast when it doesn't).
const REMOTE_GRACE_MS: u64 = 2000;

/// Kept stderr lines per child — the in-memory red-reason tail.
const STDERR_TAIL_LINES: usize = 5;

/// A rule's health as reported over `forward:update`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForwardHealth {
    /// Toggle accepted; the child is being spawned.
    Starting,
    /// Child alive; no successful probe yet.
    Amber,
    /// Tunnel verified (or, for `R`, the child outlived its grace).
    Green,
    /// Child exited, or the tunnel stopped answering.
    Red,
}

impl ForwardHealth {
    /// The wire name used in event payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            ForwardHealth::Starting => "starting",
            ForwardHealth::Amber => "amber",
            ForwardHealth::Green => "green",
            ForwardHealth::Red => "red",
        }
    }
}

/// One `forward:update` payload from the manager's point of view.
#[derive(Debug, Clone)]
pub struct ForwardUpdate {
    /// The rule's registry key (`{hostId}:{kind}:{spec}`).
    pub rule_key: String,
    /// The owning host's id.
    pub host_id: String,
    /// Current health.
    pub state: ForwardHealth,
    /// Why the rule is red (exit status + stderr tail); red only.
    pub reason: Option<String>,
    /// The copyable SOCKS string for `D` rules, once green.
    pub proxy: Option<String>,
}

/// Sink for forward status updates; the Tauri bridge in [`crate::ipc`]
/// emits them as `forward:update` events.
pub trait ForwardEvents: Send + Sync + 'static {
    /// One health transition for one rule.
    fn on_update(&self, update: &ForwardUpdate);
}

/// Outcome of [`ForwardManager::start`] — expected results, not errors
/// (mirrors the result-side `forward_start` contract).
#[derive(Debug)]
pub enum StartOutcome {
    /// The child is up; updates follow on `forward:update`.
    Started {
        /// The rule's registry key.
        rule_key: String,
    },
    /// The rule was already running — a no-op, reported as started.
    AlreadyRunning {
        /// The rule's registry key.
        rule_key: String,
    },
    /// The local bind port is taken (F7 conflict helper).
    PortInUse {
        /// Human-readable message naming the owning process when known.
        message: String,
        /// The next free local port, when one exists.
        suggested_port: Option<u16>,
    },
    /// The child could not be spawned (e.g. no `ssh` binary).
    SpawnFailed {
        /// Human-readable failure message.
        message: String,
    },
}

/// The local-bind half of a parsed forward spec — everything the conflict
/// helper and the prober need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSpec {
    /// Explicit bind address, when the spec carries one.
    pub bind_addr: Option<String>,
    /// The bind port (`L`/`D`: local; `R`: remote).
    pub bind_port: u16,
}

/// Parses and validates a forward spec against the F7 grammar:
///
/// ```text
/// L | R:  [bind-addr:]port:target-host:target-port
/// D:      [bind-addr:]port
/// ```
///
/// Ports are 1–65535; host parts must be non-empty. IPv6 bracket syntax is
/// not supported in v1 (colons are the separator).
///
/// # Errors
///
/// Fails with a human-readable message naming what's wrong — an unknown
/// kind, a malformed shape, a bad port, or an empty host part.
pub fn parse_forward_spec(kind: &str, spec: &str) -> Result<ParsedSpec, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    let parse_port = |part: &str| -> Result<u16, String> {
        let port: u16 = part
            .parse()
            .map_err(|_| format!("\"{part}\" is not a port (1–65535)"))?;
        if port == 0 {
            return Err("port 0 is not usable".to_string());
        }
        Ok(port)
    };
    match kind {
        "L" | "R" => match parts.as_slice() {
            [port, host, target_port] => {
                if host.trim().is_empty() {
                    return Err("target host is empty".to_string());
                }
                parse_port(target_port)?;
                Ok(ParsedSpec {
                    bind_addr: None,
                    bind_port: parse_port(port)?,
                })
            }
            [bind, port, host, target_port] => {
                if bind.trim().is_empty() {
                    return Err("bind address is empty".to_string());
                }
                if host.trim().is_empty() {
                    return Err("target host is empty".to_string());
                }
                parse_port(target_port)?;
                Ok(ParsedSpec {
                    bind_addr: Some((*bind).to_string()),
                    bind_port: parse_port(port)?,
                })
            }
            _ => Err(format!(
                "{kind} spec must be [bind-addr:]port:target-host:target-port"
            )),
        },
        "D" => match parts.as_slice() {
            [port] => Ok(ParsedSpec {
                bind_addr: None,
                bind_port: parse_port(port)?,
            }),
            [bind, port] => {
                if bind.trim().is_empty() {
                    return Err("bind address is empty".to_string());
                }
                Ok(ParsedSpec {
                    bind_addr: Some((*bind).to_string()),
                    bind_port: parse_port(port)?,
                })
            }
            _ => Err("D spec must be [bind-addr:]port".to_string()),
        },
        other => Err(format!("unknown forward type \"{other}\" (L, R, or D)")),
    }
}

/// The stable registry key for a rule instance: `{hostId}:{kind}:{spec}`.
pub fn rule_key(host_id: &str, rule: &Forward) -> String {
    format!("{host_id}:{}:{}", rule.kind, rule.spec)
}

/// One live forward child.
struct Entry {
    /// The child's process-group id (== its pid, thanks to
    /// `process_group(0)`); killing the group covers ProxyJump helpers.
    pgid: i32,
    /// Cancels the monitor task on toggle-off / app exit.
    cancel: CancellationToken,
}

/// Owns every running forward child: registry, health monitors, and the
/// no-orphans guarantees. One instance lives in Tauri managed state.
pub struct ForwardManager {
    /// Status sink (the `forward:update` Tauri bridge).
    events: Arc<dyn ForwardEvents>,
    /// Live children by rule key.
    entries: Arc<Mutex<HashMap<String, Entry>>>,
}

impl ForwardManager {
    /// Creates a manager emitting through `events`.
    pub fn new(events: Arc<dyn ForwardEvents>) -> Self {
        Self {
            events,
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// How many rules are currently running (status-bar chip, tests).
    pub fn running_count(&self) -> usize {
        self.entries
            .lock()
            .expect("forwards registry poisoned")
            .len()
    }

    /// Starts a rule's `ssh -N` child: pre-flights the local port (`L`/`D`),
    /// spawns the child in its own process group, and hands it to a monitor
    /// task that emits `forward:update` transitions until it dies.
    ///
    /// Starting an already-running rule is a no-op reported as started.
    ///
    /// # Errors
    ///
    /// Fails only on a malformed spec (the editor validates on save, so
    /// reaching this is a bug or a hand-edited `hosts.toml`). Expected
    /// failures — port in use, spawn failure — are [`StartOutcome`]
    /// variants, not errors.
    pub async fn start(&self, host: &Host, rule: &Forward) -> Result<StartOutcome, String> {
        let key = rule_key(&host.id, rule);
        let parsed = parse_forward_spec(&rule.kind, &rule.spec)?;
        {
            let entries = self.entries.lock().expect("forwards registry poisoned");
            if entries.contains_key(&key) {
                return Ok(StartOutcome::AlreadyRunning { rule_key: key });
            }
        }
        self.emit(&key, &host.id, ForwardHealth::Starting, None, None);

        // F7 conflict helper: bind-test the local port before spawning, so
        // "port already in use" names the owner and offers the next free
        // port instead of surfacing as an opaque child exit. `R` binds
        // remotely — ExitOnForwardFailure covers it.
        let probe_local = rule.kind != "R";
        if probe_local {
            if let Err(message) = local_bind_check(parsed.bind_port).await {
                self.emit(&key, &host.id, ForwardHealth::Red, Some(&message), None);
                return Ok(StartOutcome::PortInUse {
                    message,
                    suggested_port: next_free_port(parsed.bind_port),
                });
            }
        }

        let argv = connect::forward_argv(host, &rule.kind, &rule.spec);
        let mut cmd = tokio::process::Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // Its own group: killpg reaps ssh plus anything it spawned
            // (ProxyCommand, ProxyJump helpers) — the no-orphans guarantee.
            .process_group(0)
            .kill_on_drop(false);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                let message = format!("couldn't spawn ssh: {e}");
                self.emit(&key, &host.id, ForwardHealth::Red, Some(&message), None);
                return Ok(StartOutcome::SpawnFailed { message });
            }
        };
        let pgid = child.id().map(|pid| pid as i32).unwrap_or(0);
        let cancel = CancellationToken::new();
        {
            let mut entries = self.entries.lock().expect("forwards registry poisoned");
            entries.insert(
                key.clone(),
                Entry {
                    pgid,
                    cancel: cancel.clone(),
                },
            );
        }
        self.emit(&key, &host.id, ForwardHealth::Amber, None, None);

        // The stderr tail lives only in memory, only for the red reason —
        // never in logs (CLAUDE.md: redact diagnostics).
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = tail.lock().expect("stderr tail poisoned");
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }

        let events = Arc::clone(&self.events);
        let entries = Arc::clone(&self.entries);
        let host_id = host.id.clone();
        let kind = rule.kind.clone();
        let bind_port = parsed.bind_port;
        tokio::spawn(async move {
            monitor(
                child, cancel, events, entries, key, host_id, kind, bind_port, tail,
            )
            .await;
        });
        Ok(StartOutcome::Started {
            rule_key: rule_key(&host.id, rule),
        })
    }

    /// Stops a rule: cancels its monitor and SIGTERMs the whole process
    /// group. Unknown keys are a no-op (idempotent toggle-off).
    pub fn stop(&self, key: &str) {
        let entry = {
            let mut entries = self.entries.lock().expect("forwards registry poisoned");
            entries.remove(key)
        };
        if let Some(entry) = entry {
            entry.cancel.cancel();
            kill_group(entry.pgid);
        }
    }

    /// Kills every running child — the app-exit hook (`CLAUDE.md`: no
    /// orphans). Synchronous and idempotent; dead groups are ignored.
    pub fn kill_all(&self) {
        let drained: Vec<Entry> = {
            let mut entries = self.entries.lock().expect("forwards registry poisoned");
            entries.drain().map(|(_, entry)| entry).collect()
        };
        for entry in drained {
            entry.cancel.cancel();
            kill_group(entry.pgid);
        }
    }

    /// Emits one transition through the sink.
    fn emit(
        &self,
        rule_key: &str,
        host_id: &str,
        state: ForwardHealth,
        reason: Option<&str>,
        proxy: Option<&str>,
    ) {
        self.events.on_update(&ForwardUpdate {
            rule_key: rule_key.to_string(),
            host_id: host_id.to_string(),
            state,
            reason: reason.map(str::to_string),
            proxy: proxy.map(str::to_string),
        });
    }
}

/// The monitor task for one child: watches for exit, probes the tunnel
/// (`L`/`D`), grants `R` rules green after their startup grace, and emits
/// transitions. Ends when the child dies or the rule is stopped.
#[allow(clippy::too_many_arguments)]
async fn monitor(
    mut child: tokio::process::Child,
    cancel: CancellationToken,
    events: Arc<dyn ForwardEvents>,
    entries: Arc<Mutex<HashMap<String, Entry>>>,
    key: String,
    host_id: String,
    kind: String,
    bind_port: u16,
    tail: Arc<Mutex<VecDeque<String>>>,
) {
    let probe_local = kind != "R";
    let proxy = (kind == "D").then(|| format!("socks5://localhost:{bind_port}"));
    let mut state = ForwardHealth::Amber;
    let mut fails: u8 = 0;
    let emit = |state: ForwardHealth, reason: Option<String>| {
        events.on_update(&ForwardUpdate {
            rule_key: key.clone(),
            host_id: host_id.clone(),
            state,
            reason,
            proxy: proxy.clone(),
        });
    };
    loop {
        // Probe eagerly until green, then settle into the steady cadence;
        // R rules just wait out their grace once.
        let delay = if !probe_local && state != ForwardHealth::Amber {
            Duration::from_secs(3600)
        } else if !probe_local {
            Duration::from_millis(REMOTE_GRACE_MS)
        } else if state == ForwardHealth::Green {
            Duration::from_secs(PROBE_STEADY_SECS)
        } else {
            Duration::from_millis(800)
        };
        tokio::select! {
            _ = cancel.cancelled() => return,
            status = child.wait() => {
                if cancel.is_cancelled() {
                    return; // Raced a stop: the toggle-off already owns this.
                }
                entries
                    .lock()
                    .expect("forwards registry poisoned")
                    .remove(&key);
                let stderr_tail = tail
                    .lock()
                    .expect("stderr tail poisoned")
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" · ");
                let status_text = match status {
                    Ok(status) => status
                        .code()
                        .map(|code| format!("exited with status {code}"))
                        .unwrap_or_else(|| "was killed by a signal".to_string()),
                    Err(e) => format!("could not be awaited: {e}"),
                };
                let mut reason = format!("ssh {status_text}");
                if !stderr_tail.is_empty() {
                    reason.push_str(&format!(" — {stderr_tail}"));
                }
                reason.truncate(300);
                emit(ForwardHealth::Red, Some(reason));
                return;
            }
            _ = tokio::time::sleep(delay) => {
                if !probe_local {
                    // R: the child outlived ExitOnForwardFailure's window.
                    if state == ForwardHealth::Amber {
                        state = ForwardHealth::Green;
                        emit(state, None);
                    }
                    continue;
                }
                let (reach, _) = reach::probe_one(
                    "127.0.0.1",
                    bind_port,
                    Duration::from_millis(PROBE_TIMEOUT_MS),
                )
                .await;
                match reach {
                    ReachState::Up => {
                        fails = 0;
                        if state != ForwardHealth::Green {
                            state = ForwardHealth::Green;
                            emit(state, None);
                        }
                    }
                    ReachState::Down => {
                        fails = fails.saturating_add(1);
                        if fails >= PROBE_FAIL_THRESHOLD && state != ForwardHealth::Red {
                            state = ForwardHealth::Red;
                            emit(
                                state,
                                Some(format!(
                                    "local port {bind_port} stopped answering (child still running)"
                                )),
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Bind-tests a local port; on conflict the error names the owning process
/// via `lsof` when it answers within 2 s ("unknown process" otherwise).
async fn local_bind_check(port: u16) -> Result<(), String> {
    if TcpListener::bind(("127.0.0.1", port)).is_ok() {
        return Ok(());
    }
    let owner = port_owner(port).await;
    Err(match owner {
        Some(owner) => format!("Port {port} is in use by {owner}"),
        None => format!("Port {port} is in use"),
    })
}

/// Asks `lsof` who listens on `port`. Best effort: a missing binary, a
/// timeout, or unparseable output all yield `None`.
async fn port_owner(port: u16) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpc"])
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pid: Option<&str> = None;
    let mut name: Option<&str> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = Some(rest);
        } else if let Some(rest) = line.strip_prefix('c') {
            name = Some(rest);
            break; // First process is enough for the message.
        }
    }
    match (name, pid) {
        (Some(name), Some(pid)) => Some(format!("{name} (pid {pid})")),
        _ => None,
    }
}

/// The next local port above `taken` that binds cleanly, if any.
pub fn next_free_port(taken: u16) -> Option<u16> {
    ((taken + 1)..=u16::MAX).find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok())
}

/// SIGTERMs a process group. Idempotent: a dead or unknown group (ESRCH)
/// is silently fine, so stop/exit paths can never race a child's own death.
fn kill_group(pgid: i32) {
    if pgid <= 0 {
        return;
    }
    // SAFETY: killpg only delivers a signal; no memory is touched. ESRCH
    // (group already gone) is the expected benign failure.
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_l_and_r_specs_with_optional_bind() {
        assert_eq!(
            parse_forward_spec("L", "8080:localhost:8080").expect("plain"),
            ParsedSpec {
                bind_addr: None,
                bind_port: 8080
            }
        );
        assert_eq!(
            parse_forward_spec("R", "0.0.0.0:9000:web:3000").expect("bound"),
            ParsedSpec {
                bind_addr: Some("0.0.0.0".into()),
                bind_port: 9000
            }
        );
    }

    #[test]
    fn parses_d_specs() {
        assert_eq!(
            parse_forward_spec("D", "1080").expect("plain").bind_port,
            1080
        );
        assert_eq!(
            parse_forward_spec("D", "127.0.0.1:1080")
                .expect("bound")
                .bind_addr,
            Some("127.0.0.1".into())
        );
    }

    #[test]
    fn rejects_malformed_specs() {
        for (kind, spec) in [
            ("L", "8080"),                  // L needs a target
            ("L", "8080:localhost"),        // missing target port
            ("L", "0:localhost:80"),        // port 0
            ("L", "eighty:localhost:80"),   // not a number
            ("L", "8080::80"),              // empty target host
            ("L", "a:b:8080:localhost:80"), // too many parts
            ("R", "9000"),                  // R needs a target
            ("D", "1080:localhost:1080"),   // D takes no target
            ("D", "socks"),                 // not a number
            ("X", "8080:localhost:8080"),   // unknown kind
        ] {
            assert!(
                parse_forward_spec(kind, spec).is_err(),
                "{kind} {spec} must be rejected"
            );
        }
    }

    #[test]
    fn rule_keys_are_stable_and_distinct() {
        let rule = Forward {
            kind: "L".into(),
            spec: "8080:localhost:8080".into(),
            auto: false,
        };
        assert_eq!(rule_key("h1", &rule), "h1:L:8080:localhost:8080");
        let dynamic = Forward {
            kind: "D".into(),
            spec: "8080".into(),
            auto: false,
        };
        assert_ne!(rule_key("h1", &rule), rule_key("h1", &dynamic));
    }

    #[test]
    fn next_free_port_skips_occupied_ones() {
        // Occupy an ephemeral port, then ask for the next free one above
        // the port just below it — the occupied port must be skipped.
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let taken = holder.local_addr().expect("addr").port();
        let next = next_free_port(taken - 1).expect("a free port exists");
        assert_ne!(next, taken, "the held port must be skipped");
        assert!(next > taken - 1);
    }

    #[tokio::test]
    async fn local_bind_check_reports_occupied_ports() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let taken = holder.local_addr().expect("addr").port();
        let err = local_bind_check(taken).await.expect_err("must conflict");
        assert!(err.contains(&format!("Port {taken} is in use")), "{err}");
        drop(holder);
        assert!(local_bind_check(taken).await.is_ok(), "freed port binds");
    }

    #[test]
    fn kill_group_ignores_dead_and_invalid_groups() {
        kill_group(0); // guard path
        kill_group(-1); // guard path
                        // A wildly unlikely-to-exist pgid: must not panic.
        kill_group(i32::MAX - 7);
    }
}
