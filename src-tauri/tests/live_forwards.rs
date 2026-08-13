//! Live end-to-end suite for the forward engine (F7) against a **real**
//! OpenSSH server on localhost — the machine-checkable half of the Phase 6
//! forwards acceptance list, no remote host required.
//!
//! The harness reuses the `live_sftp` recipe: a throwaway, unprivileged
//! `sshd` on a random 127.0.0.1 port with a fresh host key, `$HOME`
//! pointed at a scratch directory whose `known_hosts` pre-trusts that key
//! (forward children run `BatchMode=yes` and cannot prompt). It then
//! walks:
//!
//! - toggle an `L` rule on → the local port answers and speaks SSH
//!   (the curl-equivalent of the §10 checklist) → toggle off → connection
//!   refused, zero `ssh -N` processes left
//! - starting the same rule twice is a no-op (started, not duplicated)
//! - an occupied local port → `PortInUse` naming the owner with a usable
//!   next-free-port suggestion (the F7 conflict helper)
//! - a remote bind that cannot succeed → `ExitOnForwardFailure` exits the
//!   child and the rule reports **red** with a reason
//! - `kill_all` with live `L` + `D` rules → every child (and its process
//!   group) is gone — the no-orphans acceptance item
//!
//! Ignored by default (it spawns sshd and ssh children); run with:
//!
//! ```sh
//! cargo test --test live_forwards -- --ignored --nocapture
//! ```

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use setu_lib::forwards::{
    ForwardEvents, ForwardHealth, ForwardManager, ForwardUpdate, StartOutcome,
};
use setu_lib::store::{Forward, Host};
use tokio::sync::mpsc;

/// Event sink standing in for the Tauri bridge: streams updates to the test.
struct Recorder {
    tx: mpsc::UnboundedSender<ForwardUpdate>,
}

impl ForwardEvents for Recorder {
    fn on_update(&self, update: &ForwardUpdate) {
        let _ = self.tx.send(update.clone());
    }
}

/// A running throwaway sshd; the whole process group dies on drop.
struct Sshd {
    child: Child,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = Command::new("/bin/kill")
            .args(["-9", &format!("-{}", self.child.id())])
            .stderr(Stdio::null())
            .status();
        let _ = self.child.wait();
    }
}

/// Picks a free localhost port by binding :0 and letting it go.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind :0")
        .local_addr()
        .expect("local addr")
        .port()
}

/// Generates a passphrase-less ed25519 keypair at `path`.
fn keygen(path: &Path) {
    let status = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(path)
        .status()
        .expect("run ssh-keygen");
    assert!(status.success(), "ssh-keygen failed");
}

/// Starts an unprivileged sshd on `port` (same recipe as `live_sftp`).
fn start_sshd(dir: &Path, port: u16, host_key: &Path, authorized_keys: &Path) -> Sshd {
    use std::os::unix::process::CommandExt as _;
    let config = dir.join(format!("sshd_config_{port}"));
    std::fs::write(
        &config,
        format!(
            "Port {port}\n\
             ListenAddress 127.0.0.1\n\
             HostKey {host_key}\n\
             PidFile {pid}\n\
             UsePAM no\n\
             PasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n\
             PubkeyAuthentication yes\n\
             AuthorizedKeysFile {auth}\n\
             StrictModes no\n\
             LogLevel ERROR\n\
             Subsystem sftp /usr/libexec/sftp-server\n",
            host_key = host_key.display(),
            pid = dir.join(format!("sshd_{port}.pid")).display(),
            auth = authorized_keys.display(),
        ),
    )
    .expect("write sshd_config");

    let mut command = Command::new("/usr/sbin/sshd");
    command
        .arg("-f")
        .arg(&config)
        .args(["-D", "-e"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.process_group(0);
    let child = command.spawn().expect("spawn sshd");

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "sshd never listened on {port}");
        std::thread::sleep(Duration::from_millis(50));
    }
    Sshd { child }
}

/// Waits until nothing answers on `port`.
fn wait_port_closed(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        assert!(Instant::now() < deadline, "port {port} never closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Reads the first bytes a listener sends — an sshd answers with its
/// `SSH-2.0-…` version string, proving the tunnel reaches the real server
/// (the test-suite stand-in for the checklist's `curl localhost:8080`).
fn banner_of(port: u16) -> String {
    use std::io::Read as _;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("read timeout");
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).expect("read banner");
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

/// Live `ssh -N` children matching `marker` (a spec string unique to this
/// test run), per `ps` — the no-orphans check.
fn ssh_n_processes(marker: &str) -> Vec<String> {
    let output = Command::new("ps")
        .args(["axww", "-o", "command"])
        .output()
        .expect("run ps");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.contains("ssh") && line.contains("-N") && line.contains(marker))
        .map(str::to_string)
        .collect()
}

/// Waits for the rule to report `wanted`, failing on a 30 s stall or an
/// intervening `Red` (unless red is what's wanted — then its reason returns).
async fn wait_for_state(
    rx: &mut mpsc::UnboundedReceiver<ForwardUpdate>,
    rule_key: &str,
    wanted: ForwardHealth,
) -> Option<String> {
    loop {
        let update = tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {wanted:?} on {rule_key}"))
            .expect("event channel open");
        if update.rule_key != rule_key {
            continue;
        }
        if update.state == wanted {
            return update.reason;
        }
        assert!(
            update.state != ForwardHealth::Red,
            "{rule_key} went red instead of {wanted:?}: {:?}",
            update.reason
        );
    }
}

/// The full live walk. One test on purpose: it mutates the process-global
/// `HOME`, so steps must run serially.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns sshd and ssh children; run with --ignored"]
async fn live_forwards_walk() {
    let scratch = std::env::temp_dir().join(format!("setu-live-fwd-{}", std::process::id()));
    std::fs::create_dir_all(scratch.join(".ssh")).expect("scratch .ssh");
    let scratch = scratch.canonicalize().expect("canonical scratch");

    // --- server + client keys, pre-trusted known_hosts ------------------
    let host_key = scratch.join("host_key");
    let user_key = scratch.join("user_key");
    keygen(&host_key);
    keygen(&user_key);
    let authorized = scratch.join("authorized_keys");
    std::fs::copy(user_key.with_extension("pub"), &authorized).expect("authorized_keys");

    let sshd_port = free_port();
    let _sshd = start_sshd(&scratch, sshd_port, &host_key, &authorized);

    // Forward children run BatchMode=yes and cannot prompt, so the host
    // key must already be trusted — exactly the F07-documented workflow.
    // $HOME points at scratch so the real known_hosts is never touched.
    let host_pub = std::fs::read_to_string(host_key.with_extension("pub")).expect("host pub");
    let host_pub = host_pub.trim();
    std::fs::write(
        scratch.join(".ssh/known_hosts"),
        format!("[127.0.0.1]:{sshd_port} {host_pub}\n"),
    )
    .expect("write known_hosts");
    std::env::set_var("HOME", &scratch);

    let host = Host {
        id: "live-fwd-host".into(),
        label: "fwd-qa".into(),
        hostname: "127.0.0.1".into(),
        user: whoami(),
        port: sshd_port,
        identity: user_key.to_string_lossy().into_owned(),
        ..Host::default()
    };

    let (tx, mut rx) = mpsc::unbounded_channel();
    let manager = ForwardManager::new(Arc::new(Recorder { tx }));

    // --- L rule: toggle on → tunnel works → toggle off → refused --------
    let lport = free_port();
    let l_rule = Forward {
        kind: "L".into(),
        spec: format!("{lport}:127.0.0.1:{sshd_port}"),
        auto: false,
    };
    let outcome = manager.start(&host, &l_rule).await.expect("start L");
    let StartOutcome::Started { rule_key: l_key } = outcome else {
        panic!("expected Started, got {outcome:?}");
    };
    wait_for_state(&mut rx, &l_key, ForwardHealth::Green).await;
    let banner = banner_of(lport);
    assert!(
        banner.starts_with("SSH-2.0"),
        "tunnel must reach the sshd, got banner {banner:?}"
    );

    // Starting the same rule again is a started no-op, not a second child.
    let again = manager.start(&host, &l_rule).await.expect("re-start L");
    assert!(
        matches!(again, StartOutcome::AlreadyRunning { .. }),
        "expected AlreadyRunning, got {again:?}"
    );
    assert_eq!(manager.running_count(), 1);
    assert_eq!(ssh_n_processes(&l_rule.spec).len(), 1, "exactly one child");

    manager.stop(&l_key);
    wait_port_closed(lport);
    assert!(
        std::net::TcpStream::connect(("127.0.0.1", lport)).is_err(),
        "toggled-off port must refuse"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ssh_n_processes(&l_rule.spec).is_empty() {
        assert!(Instant::now() < deadline, "ssh -N survived its stop");
        std::thread::sleep(Duration::from_millis(50));
    }

    // --- the conflict helper: occupied port names owner + next free -----
    let holder = std::net::TcpListener::bind("127.0.0.1:0").expect("hold a port");
    let held = holder.local_addr().expect("addr").port();
    let conflicted = Forward {
        kind: "L".into(),
        spec: format!("{held}:127.0.0.1:{sshd_port}"),
        auto: false,
    };
    let outcome = manager
        .start(&host, &conflicted)
        .await
        .expect("start conflicted");
    let StartOutcome::PortInUse {
        message,
        suggested_port,
    } = outcome
    else {
        panic!("expected PortInUse, got {outcome:?}");
    };
    assert!(
        message.contains(&format!("Port {held} is in use")),
        "message names the port: {message}"
    );
    let suggested = suggested_port.expect("a next free port exists");
    assert!(suggested > held, "suggestion must be above the taken port");
    assert!(
        std::net::TcpListener::bind(("127.0.0.1", suggested)).is_ok(),
        "suggested port must actually bind"
    );
    drop(holder);

    // --- a doomed remote bind → ExitOnForwardFailure → red --------------
    // Port 1 is privileged; the unprivileged sshd user cannot bind it.
    let doomed = Forward {
        kind: "R".into(),
        spec: format!("1:127.0.0.1:{sshd_port}"),
        auto: false,
    };
    let outcome = manager.start(&host, &doomed).await.expect("start doomed R");
    let StartOutcome::Started { rule_key: r_key } = outcome else {
        panic!("expected Started (the failure is asynchronous), got {outcome:?}");
    };
    let reason = wait_red(&mut rx, &r_key).await;
    assert!(
        reason.contains("ssh exited") || reason.contains("ssh was killed"),
        "red reason describes the exit: {reason}"
    );

    // --- kill_all: no orphans in ps (the §10 acceptance item) -----------
    let l2_port = free_port();
    let l2 = Forward {
        kind: "L".into(),
        spec: format!("{l2_port}:127.0.0.1:{sshd_port}"),
        auto: false,
    };
    let d_port = free_port();
    let d = Forward {
        kind: "D".into(),
        spec: format!("{d_port}"),
        auto: false,
    };
    let StartOutcome::Started { rule_key: l2_key } =
        manager.start(&host, &l2).await.expect("start L2")
    else {
        panic!("L2 must start");
    };
    let StartOutcome::Started { rule_key: d_key } =
        manager.start(&host, &d).await.expect("start D")
    else {
        panic!("D must start");
    };
    wait_for_state(&mut rx, &l2_key, ForwardHealth::Green).await;
    wait_for_state(&mut rx, &d_key, ForwardHealth::Green).await;
    assert_eq!(manager.running_count(), 2);

    manager.kill_all();
    assert_eq!(manager.running_count(), 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let leftovers: Vec<String> = [l2.spec.as_str(), d.spec.as_str()]
            .iter()
            .flat_map(|marker| ssh_n_processes(marker))
            .collect();
        if leftovers.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "orphaned ssh -N children after kill_all: {leftovers:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    wait_port_closed(l2_port);
    wait_port_closed(d_port);

    std::fs::remove_dir_all(&scratch).ok();
}

/// Waits for `rule_key` to go red and returns its reason.
async fn wait_red(rx: &mut mpsc::UnboundedReceiver<ForwardUpdate>, rule_key: &str) -> String {
    loop {
        let update = tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for red on {rule_key}"))
            .expect("event channel open");
        if update.rule_key == rule_key && update.state == ForwardHealth::Red {
            return update.reason.unwrap_or_default();
        }
    }
}

/// The invoking user's name (`sshd` serves the invoking user).
fn whoami() -> String {
    String::from_utf8_lossy(
        &Command::new("id")
            .arg("-un")
            .output()
            .expect("id -un")
            .stdout,
    )
    .trim()
    .to_string()
}
