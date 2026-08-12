//! The reachability prober behind the LED board (F1, Phase 4).
//!
//! Every visible host with `reachability = true` gets a **bare TCP connect**
//! to its configured port — no banner read, no auth attempted, connection
//! dropped the instant it opens (`CLAUDE.md` hard rule). A sweep probes the
//! whole board: tasks are staggered with a small random jitter and capped by
//! a semaphore (`max_concurrent`), each guarded by `timeout_ms`. The first
//! sweep starts the moment [`ReachProber::start`] is called so a 20-host
//! board lights within seconds; later sweeps repeat every `interval_s`.
//!
//! Sweeping pauses once the app has been hidden longer than
//! [`PAUSE_AFTER_HIDDEN`] and resumes with an immediate sweep on refocus
//! (the frontend reports visibility via `reach_set_visible`). Kill switches:
//! global (`settings.reachability.enabled`, checked by the `reach_start`
//! command) and per host (`Host.reachability`, applied by
//! [`probe_targets`]).
//!
//! Like [`crate::pty`], the module talks to the outside world through small
//! traits — [`ReachEvents`] for probe results and [`TargetSource`] for the
//! host list — so everything but the Tauri event bridge is unit-testable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinSet;

use crate::settings::ReachabilitySettings;
use crate::store::{Host, HostSource};

/// How long the app must stay hidden before sweeping pauses (F1).
pub const PAUSE_AFTER_HIDDEN: Duration = Duration::from_secs(60);

/// Upper bound of the per-probe start jitter within a sweep. Small on
/// purpose: jitter staggers connects inside a sweep without delaying the
/// board (the ~3s light-up budget is the acceptance bar).
const JITTER_MS: u64 = 250;

/// Result of one probe, as reported to [`ReachEvents`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReachState {
    /// The TCP connect succeeded — the host answers on its ssh port right
    /// now. (Reachability, not auth: a host that refuses ssh logins still
    /// probes `Up`.)
    Up,
    /// The connect timed out or was refused.
    Down,
}

/// Sink for probe results. Implemented by the Tauri event bridge in
/// [`crate::ipc`] and by channel doubles in tests.
pub trait ReachEvents: Send + Sync + 'static {
    /// One probe finished: `rtt_ms` is the connect latency for [`ReachState::Up`],
    /// `None` for [`ReachState::Down`].
    fn on_update(&self, host_id: &str, state: ReachState, rtt_ms: Option<u32>);
}

/// Where the prober's host list comes from. The production implementation
/// (in [`crate::ipc`]) re-derives the same union `hosts_list` returns —
/// persisted records plus live `~/.ssh/config` rows — so a sweep always
/// sees host CRUD that happened since the last one.
pub trait TargetSource: Send + Sync + 'static {
    /// The current probe targets (already filtered via [`probe_targets`]).
    fn targets(&self) -> Vec<ProbeTarget>;
}

/// One host the prober will connect to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeTarget {
    /// The host's id — names the `reach:update` payload.
    pub host_id: String,
    /// Display label, used in log lines (never the PTY, never secrets).
    pub label: String,
    /// Hostname or IP to connect to.
    pub hostname: String,
    /// TCP port to connect to.
    pub port: u16,
}

/// Filters a host list down to probe targets (the per-host kill switch).
///
/// Skipped: hosts with `reachability = false`, alias-only imports with an
/// empty `hostname` (their LED stays hollow — F1 edge case), and tailnet
/// rows (Phase 7 mirrors Tailscale's own state instead of probing).
pub fn probe_targets(hosts: &[Host]) -> Vec<ProbeTarget> {
    hosts
        .iter()
        .filter(|h| h.reachability)
        .filter(|h| !h.hostname.trim().is_empty())
        .filter(|h| h.source != HostSource::Tailscale)
        .map(|h| ProbeTarget {
            host_id: h.id.clone(),
            label: h.label.clone(),
            hostname: h.hostname.clone(),
            port: h.port,
        })
        .collect()
}

/// Probes one target: a bare TCP connect guarded by `timeout`.
///
/// Returns the state plus the connect latency for successful probes. The
/// connection is dropped immediately — nothing is read or written. DNS
/// resolution happens inside the timeout window, so the first probe of a
/// cold name can report a slightly higher latency than steady state.
pub async fn probe_one(hostname: &str, port: u16, timeout: Duration) -> (ReachState, Option<u32>) {
    let started = Instant::now();
    match tokio::time::timeout(timeout, TcpStream::connect((hostname, port))).await {
        Ok(Ok(stream)) => {
            // Explicit drop right away: the probe must never linger on the
            // remote sshd's accept queue longer than the handshake itself.
            drop(stream);
            let rtt = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
            (ReachState::Up, Some(rtt))
        }
        Ok(Err(_)) | Err(_) => (ReachState::Down, None),
    }
}

/// Runs one full sweep: every target probed, staggered by jitter and capped
/// by a `max_concurrent` semaphore. Emits one [`ReachEvents::on_update`]
/// per target and returns `(up, down)` counts.
pub async fn sweep_once(
    targets: Vec<ProbeTarget>,
    config: ReachabilitySettings,
    events: Arc<dyn ReachEvents>,
) -> (usize, usize) {
    if targets.is_empty() {
        return (0, 0);
    }
    let started = Instant::now();
    eprintln!(
        "[reach] sweep start: {} target(s), max {} concurrent, {}ms timeout",
        targets.len(),
        config.max_concurrent,
        config.timeout_ms
    );
    let semaphore = Arc::new(Semaphore::new(config.max_concurrent.max(1)));
    let timeout = Duration::from_millis(u64::from(config.timeout_ms));
    let mut tasks = JoinSet::new();
    for target in targets {
        let semaphore = Arc::clone(&semaphore);
        let events = Arc::clone(&events);
        let jitter = Duration::from_millis(fastrand::u64(0..=JITTER_MS));
        tasks.spawn(async move {
            tokio::time::sleep(jitter).await;
            let _permit = semaphore.acquire().await.expect("semaphore never closed");
            let (state, rtt_ms) = probe_one(&target.hostname, target.port, timeout).await;
            match (state, rtt_ms) {
                (ReachState::Up, Some(ms)) => eprintln!("[reach] {}: up {}ms", target.label, ms),
                _ => eprintln!("[reach] {}: down", target.label),
            }
            events.on_update(&target.host_id, state, rtt_ms);
            state
        });
    }
    let (mut up, mut down) = (0, 0);
    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(ReachState::Up) => up += 1,
            Ok(ReachState::Down) => down += 1,
            Err(_) => down += 1, // A panicked probe task counts as down.
        }
    }
    eprintln!(
        "[reach] sweep done: {up} up / {down} down in {}ms",
        started.elapsed().as_millis()
    );
    (up, down)
}

/// App visibility as the pause logic sees it (pure, injectable clock).
#[derive(Debug, Clone, Copy)]
struct Visibility {
    /// When the app became hidden; `None` while visible.
    hidden_since: Option<Instant>,
}

impl Visibility {
    /// Whether sweeping should pause at `now` (hidden longer than the F1
    /// threshold).
    fn should_pause(&self, now: Instant) -> bool {
        self.hidden_for(now) > PAUSE_AFTER_HIDDEN
    }

    /// How long the app has been hidden at `now`; zero while visible.
    fn hidden_for(&self, now: Instant) -> Duration {
        self.hidden_since
            .map(|since| now.duration_since(since))
            .unwrap_or(Duration::ZERO)
    }
}

/// Shared state between the prober handle and its loop task.
struct Shared {
    /// The host list provider.
    source: Arc<dyn TargetSource>,
    /// The probe-result sink.
    events: Arc<dyn ReachEvents>,
    /// Config captured at the latest [`ReachProber::start`] call.
    config: Mutex<ReachabilitySettings>,
    /// Whether the loop should keep running.
    running: AtomicBool,
    /// Visibility for the pause-when-hidden rule.
    visibility: Mutex<Visibility>,
    /// Wakes the loop early: stop, restart-with-fresh-targets, or resume.
    notify: Notify,
}

/// The reachability prober — managed Tauri state, one per app.
///
/// [`start`](Self::start) is idempotent: the first call spawns the sweep
/// loop, later calls update the config and trigger an immediate sweep (the
/// frontend calls it again after host CRUD so a new host lights up without
/// waiting a full interval).
pub struct ReachProber {
    /// State shared with the loop task.
    shared: Arc<Shared>,
}

impl ReachProber {
    /// Creates a prober over `source` and `events`. No work happens until
    /// [`start`](Self::start).
    pub fn new(source: Arc<dyn TargetSource>, events: Arc<dyn ReachEvents>) -> Self {
        Self {
            shared: Arc::new(Shared {
                source,
                events,
                config: Mutex::new(ReachabilitySettings::default()),
                running: AtomicBool::new(false),
                visibility: Mutex::new(Visibility { hidden_since: None }),
                notify: Notify::new(),
            }),
        }
    }

    /// Starts the sweep loop (first call) or refreshes it (later calls):
    /// `config` replaces the active settings and a sweep fires immediately,
    /// picking up the current host list from the [`TargetSource`].
    pub fn start(&self, config: ReachabilitySettings) {
        *self.shared.config.lock().expect("reach config poisoned") = config;
        if self.shared.running.swap(true, Ordering::SeqCst) {
            // Already looping — just wake it for an immediate fresh sweep.
            self.shared.notify.notify_one();
            return;
        }
        let shared = Arc::clone(&self.shared);
        tauri::async_runtime::spawn(async move { run_loop(shared).await });
    }

    /// Stops the loop. In-flight probes finish on their own (each is bounded
    /// by the probe timeout); no further sweeps or events follow.
    pub fn stop(&self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.notify.notify_one();
    }

    /// Records app visibility (frontend `document.visibilitychange`).
    ///
    /// Becoming visible after a pause-long hide wakes the loop for the F1
    /// "immediate sweep on refocus"; shorter hides don't disturb the rhythm.
    pub fn set_visible(&self, visible: bool) {
        let mut vis = self.shared.visibility.lock().expect("visibility poisoned");
        if visible {
            let was_paused = vis.should_pause(Instant::now());
            vis.hidden_since = None;
            if was_paused {
                self.shared.notify.notify_one();
            }
        } else if vis.hidden_since.is_none() {
            vis.hidden_since = Some(Instant::now());
        }
    }
}

/// The sweep loop: probe, sleep an interval (or wake early), repeat —
/// skipping sweeps while the app counts as hidden.
async fn run_loop(shared: Arc<Shared>) {
    let mut was_paused = false;
    loop {
        if !shared.running.load(Ordering::SeqCst) {
            eprintln!("[reach] stopped");
            return;
        }
        let paused = {
            let vis = shared.visibility.lock().expect("visibility poisoned");
            vis.should_pause(Instant::now())
        };
        if paused {
            if !was_paused {
                let hidden = {
                    let vis = shared.visibility.lock().expect("visibility poisoned");
                    vis.hidden_for(Instant::now()).as_secs()
                };
                eprintln!("[reach] paused — app hidden for {hidden}s");
                was_paused = true;
            }
            // Sleep until something changes: refocus, stop, or restart.
            shared.notify.notified().await;
            continue;
        }
        if was_paused {
            eprintln!("[reach] resumed — sweeping immediately");
            was_paused = false;
        }
        let config = *shared.config.lock().expect("reach config poisoned");
        let targets = shared.source.targets();
        sweep_once(targets, config, Arc::clone(&shared.events)).await;
        let interval = {
            let config = shared.config.lock().expect("reach config poisoned");
            Duration::from_secs(u64::from(config.interval_s.max(1)))
        };
        tokio::select! {
            _ = tokio::time::sleep(interval) => {}
            _ = shared.notify.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// [`ReachEvents`] double that forwards every update into a channel.
    struct ChannelEvents {
        tx: mpsc::Sender<(String, ReachState, Option<u32>)>,
    }

    impl ReachEvents for ChannelEvents {
        fn on_update(&self, host_id: &str, state: ReachState, rtt_ms: Option<u32>) {
            let _ = self.tx.send((host_id.to_string(), state, rtt_ms));
        }
    }

    fn host(label: &str, hostname: &str) -> Host {
        Host {
            id: format!("id-{label}"),
            label: label.into(),
            hostname: hostname.into(),
            ..Host::default()
        }
    }

    fn target(label: &str, hostname: &str, port: u16) -> ProbeTarget {
        ProbeTarget {
            host_id: format!("id-{label}"),
            label: label.into(),
            hostname: hostname.into(),
            port,
        }
    }

    #[test]
    fn probe_targets_applies_the_per_host_kill_switch() {
        let mut off = host("off", "off.example.net");
        off.reachability = false;
        let hosts = vec![host("on", "on.example.net"), off];
        let targets = probe_targets(&hosts);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].label, "on");
    }

    #[test]
    fn probe_targets_skips_alias_only_and_tailscale_rows() {
        let alias_only = host("alias", "");
        let blank = host("blank", "   ");
        let mut peer = host("peer", "peer.ts.net");
        peer.source = HostSource::Tailscale;
        let mut imported = host("imported", "real.example.net");
        imported.source = HostSource::SshConfig;
        let targets = probe_targets(&[alias_only, blank, peer, imported]);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].label, "imported");
    }

    #[tokio::test]
    async fn probe_one_reports_up_with_latency_for_a_listening_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (state, rtt) = probe_one("127.0.0.1", port, Duration::from_millis(1500)).await;
        assert_eq!(state, ReachState::Up);
        let rtt = rtt.expect("up probes carry latency");
        assert!(rtt < 1500, "loopback rtt should be near-zero, got {rtt}ms");
    }

    #[tokio::test]
    async fn probe_one_reports_down_for_a_refused_port() {
        // Bind-then-drop guarantees the port exists but nothing listens.
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);
        let (state, rtt) = probe_one("127.0.0.1", port, Duration::from_millis(1500)).await;
        assert_eq!(state, ReachState::Down);
        assert_eq!(rtt, None);
    }

    #[tokio::test]
    async fn probe_one_times_out_instead_of_hanging() {
        // An unresolvable name fails inside the timeout window either way;
        // the assertion is that we return promptly with Down.
        let started = Instant::now();
        let (state, _) = probe_one("setu-invalid.invalid", 22, Duration::from_millis(300)).await;
        assert_eq!(state, ReachState::Down);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "probe must return promptly"
        );
    }

    #[tokio::test]
    async fn sweep_once_emits_one_update_per_target() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let up_port = listener.local_addr().expect("addr").port();
        let closed = TcpListener::bind("127.0.0.1:0").expect("bind");
        let down_port = closed.local_addr().expect("addr").port();
        drop(closed);

        let (tx, rx) = mpsc::channel();
        let events: Arc<dyn ReachEvents> = Arc::new(ChannelEvents { tx });
        let targets = vec![
            target("up", "127.0.0.1", up_port),
            target("down", "127.0.0.1", down_port),
        ];
        let (up, down) = sweep_once(targets, ReachabilitySettings::default(), events).await;
        assert_eq!((up, down), (1, 1));

        let mut updates: Vec<_> = rx.try_iter().collect();
        updates.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].0, "id-down");
        assert_eq!(updates[0].1, ReachState::Down);
        assert_eq!(updates[0].2, None);
        assert_eq!(updates[1].0, "id-up");
        assert_eq!(updates[1].1, ReachState::Up);
        assert!(updates[1].2.is_some());
    }

    #[tokio::test]
    async fn sweep_once_with_no_targets_is_a_quiet_no_op() {
        let (tx, rx) = mpsc::channel();
        let events: Arc<dyn ReachEvents> = Arc::new(ChannelEvents { tx });
        let (up, down) = sweep_once(vec![], ReachabilitySettings::default(), events).await;
        assert_eq!((up, down), (0, 0));
        assert_eq!(rx.try_iter().count(), 0);
    }

    #[test]
    fn visibility_pauses_only_after_the_threshold() {
        let now = Instant::now();
        let visible = Visibility { hidden_since: None };
        assert!(!visible.should_pause(now));

        let hidden = Visibility {
            hidden_since: Some(now),
        };
        assert!(!hidden.should_pause(now + Duration::from_secs(59)));
        assert!(hidden.should_pause(now + PAUSE_AFTER_HIDDEN + Duration::from_secs(1)));
    }
}
