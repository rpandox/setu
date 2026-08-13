//! Live end-to-end suite for the SFTP engine (F5) against a **real**
//! OpenSSH server on localhost — the machine-checkable half of the Phase 5
//! acceptance checklist, no remote host required.
//!
//! The harness starts a throwaway, unprivileged `sshd` on a random
//! 127.0.0.1 port (fresh host key, pubkey-only, `/usr/libexec/sftp-server`
//! subsystem) and points `$HOME` at a scratch directory so the trust flow
//! writes a scratch `known_hosts`, never the real one. It then walks:
//!
//! - unknown host key → prompt (auto-trusted) → append → silent reconnect
//! - the auth ladder's agent rung (a private `ssh-agent` holding the key)
//! - listings (dotfiles, unicode, symlinks-as-links), stat-follow, mkdir,
//!   rename, chmod, recursive delete that must NOT follow links, realpath
//! - a 10k-entry directory listing (count + latency)
//! - a patterned 200 MB upload and download with byte-exact round-trip,
//!   monotonic progress, and correct terminal totals
//! - cancel mid-transfer with partial-file cleanup
//! - the server dying mid-transfer → a **retryable** failure
//! - a changed host key → hard refusal, no prompt
//!
//! Ignored by default (it spawns processes and moves gigabytes); run with:
//!
//! ```sh
//! cargo test --test live_sftp -- --ignored --nocapture
//! ```

use std::io::Write as _;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use setu_lib::sftp::{self, HostTarget, SftpEvents, SftpManager};
use sha1::{Digest, Sha1};
use tokio::sync::mpsc;

/// One recorded `hostkey:prompt`.
#[derive(Debug, Clone)]
struct Prompt {
    host_id: String,
    algorithm: String,
    fingerprint: String,
}

/// One transfer event, as the frontend would see it.
#[derive(Debug, Clone)]
enum Xfer {
    Progress { bytes: u64, total: u64 },
    Done { bytes: u64, total: u64 },
    Failed { error: String, retryable: bool },
    Cancelled,
}

/// Event sink standing in for the Tauri bridge: records prompts (and
/// answers them with "trust" straight away, like a user clicking through
/// the FingerprintDialog) and streams transfer events to the test.
struct Recorder {
    /// Set after the manager exists (the manager owns this recorder).
    manager: Mutex<Option<Arc<SftpManager>>>,
    prompts: Mutex<Vec<Prompt>>,
    xfer_tx: mpsc::UnboundedSender<Xfer>,
}

impl SftpEvents for Recorder {
    fn on_hostkey_prompt(&self, host_id: &str, _label: &str, algorithm: &str, fingerprint: &str) {
        self.prompts.lock().unwrap().push(Prompt {
            host_id: host_id.to_string(),
            algorithm: algorithm.to_string(),
            fingerprint: fingerprint.to_string(),
        });
        // The pending entry exists before this callback fires, so the
        // verdict can be delivered synchronously — the "user" trusts.
        let manager = self.manager.lock().unwrap().clone().expect("manager set");
        manager
            .resolve_trust(host_id, true)
            .expect("resolve pending prompt");
    }

    fn on_progress(&self, _id: &str, bytes: u64, total: u64) {
        let _ = self.xfer_tx.send(Xfer::Progress { bytes, total });
    }

    fn on_done(&self, _id: &str, bytes: u64, total: u64) {
        let _ = self.xfer_tx.send(Xfer::Done { bytes, total });
    }

    fn on_failed(&self, _id: &str, error: &str, retryable: bool) {
        let _ = self.xfer_tx.send(Xfer::Failed {
            error: error.to_string(),
            retryable,
        });
    }

    fn on_cancelled(&self, _id: &str) {
        let _ = self.xfer_tx.send(Xfer::Cancelled);
    }
}

/// A running throwaway sshd; the whole process group dies on drop.
struct Sshd {
    child: Child,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        kill_group(self.child.id());
        let _ = self.child.wait();
    }
}

/// SIGKILLs a process group (sshd forks one child per connection; the
/// group sweep gets those too).
fn kill_group(pgid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-9", &format!("-{pgid}")])
        .stderr(Stdio::null())
        .status();
}

/// Picks a free localhost port by binding :0 and letting it go.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind :0")
        .local_addr()
        .expect("local addr")
        .port()
}

/// Waits until nothing is listening on `port` (old listener fully gone).
fn wait_port_closed(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        assert!(Instant::now() < deadline, "port {port} never closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A TCP proxy in front of the sshd whose connections the test can sever
/// on demand — the deterministic way to simulate a dropped link
/// mid-transfer (killing sshd doesn't work: its per-connection children
/// escape the process group and finish the transfer).
struct SeverableProxy {
    port: u16,
    accept_task: tokio::task::JoinHandle<()>,
    conns: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl SeverableProxy {
    /// Starts forwarding `127.0.0.1:{self.port}` → `127.0.0.1:{upstream}`.
    async fn start(upstream: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind proxy");
        let port = listener.local_addr().expect("proxy addr").port();
        let conns: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));
        let conns_in_loop = Arc::clone(&conns);
        let accept_task = tokio::spawn(async move {
            loop {
                let Ok((mut inbound, _)) = listener.accept().await else {
                    break;
                };
                let copy = tokio::spawn(async move {
                    let Ok(mut outbound) =
                        tokio::net::TcpStream::connect(("127.0.0.1", upstream)).await
                    else {
                        return;
                    };
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                });
                conns_in_loop.lock().unwrap().push(copy);
            }
        });
        Self {
            port,
            accept_task,
            conns,
        }
    }

    /// Drops every forwarded connection (and stops accepting new ones):
    /// both endpoints see the socket die immediately.
    fn sever(&self) {
        self.accept_task.abort();
        for task in self.conns.lock().unwrap().drain(..) {
            task.abort();
        }
    }
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

/// Starts an unprivileged sshd on `port` with `host_key`, serving the
/// invoking user with pubkey auth and the stock sftp subsystem.
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

    // Wait for the listener.
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

/// Streaming SHA-1 of a file (integrity check for the 200 MB round-trip).
fn sha1_of(path: &Path) -> String {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).expect("open for hashing");
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf).expect("read for hashing");
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    format!("{:x}", hasher.finalize())
}

/// Writes a 200 MB patterned file (each MiB chunk stamped with its index,
/// so a torn or reordered transfer cannot hash equal).
fn write_patterned_200mb(path: &Path) {
    let mut file = std::fs::File::create(path).expect("create patterned file");
    let mut chunk = vec![0xABu8; 1 << 20];
    for index in 0u64..200 {
        chunk[..8].copy_from_slice(&index.to_le_bytes());
        file.write_all(&chunk).expect("write chunk");
    }
    file.flush().expect("flush patterned file");
}

/// Waits for the next transfer event, failing loudly on a stall.
async fn next_xfer(rx: &mut mpsc::UnboundedReceiver<Xfer>, what: &str) -> Xfer {
    tokio::time::timeout(Duration::from_secs(120), rx.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
        .unwrap_or_else(|| panic!("event channel closed waiting for {what}"))
}

/// Drains events until a terminal one, asserting progress is monotonic
/// and the reported total never drifts mid-stream.
async fn run_to_terminal(rx: &mut mpsc::UnboundedReceiver<Xfer>, what: &str) -> (Xfer, usize) {
    let mut last_bytes = 0u64;
    let mut first_total: Option<u64> = None;
    let mut running = 0usize;
    loop {
        match next_xfer(rx, what).await {
            Xfer::Progress { bytes, total } => {
                assert!(bytes >= last_bytes, "{what}: progress went backwards");
                assert_eq!(
                    *first_total.get_or_insert(total),
                    total,
                    "{what}: total drifted mid-stream"
                );
                last_bytes = bytes;
                running += 1;
            }
            terminal => return (terminal, running),
        }
    }
}

/// The full live walk. One test on purpose: it mutates process-global
/// environment (`HOME`, `SSH_AUTH_SOCK`), so steps must run serially.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "spawns sshd and moves gigabytes; run with --ignored"]
async fn live_acceptance_walk() {
    let scratch = std::env::temp_dir().join(format!("setu-live-sftp-{}", std::process::id()));
    std::fs::create_dir_all(scratch.join(".ssh")).expect("scratch .ssh");
    let scratch = scratch.canonicalize().expect("canonical scratch");

    // --- server + client keys -------------------------------------------
    let host_key = scratch.join("host_key");
    let host_key2 = scratch.join("host_key2");
    let user_key = scratch.join("user_key");
    keygen(&host_key);
    keygen(&host_key2);
    keygen(&user_key);
    let authorized = scratch.join("authorized_keys");
    std::fs::copy(user_key.with_extension("pub"), &authorized).expect("authorized_keys");

    let port = free_port();
    let sshd = start_sshd(&scratch, port, &host_key, &authorized);

    // The trust flow must write a scratch known_hosts, never the real one.
    std::env::set_var("HOME", &scratch);
    std::env::remove_var("SSH_AUTH_SOCK");

    let (xfer_tx, mut xfer_rx) = mpsc::unbounded_channel();
    let recorder = Arc::new(Recorder {
        manager: Mutex::new(None),
        prompts: Mutex::new(Vec::new()),
        xfer_tx,
    });
    let manager = Arc::new(SftpManager::new(recorder.clone()));
    *recorder.manager.lock().unwrap() = Some(manager.clone());

    let user = std::env::var("USER").expect("USER set");
    let target = |identity: &str| HostTarget {
        host_id: "qa-host".into(),
        label: "qa".into(),
        hostname: "127.0.0.1".into(),
        user: user.clone(),
        port,
        identity: identity.into(),
    };

    // === Acceptance item 3: unknown key → SHA256 prompt → trust appends ==
    let session = manager
        .connect(target(user_key.to_str().unwrap()))
        .await
        .expect("first connect (unknown key, then trusted)");
    {
        let prompts = recorder.prompts.lock().unwrap();
        assert_eq!(prompts.len(), 1, "exactly one prompt for the unknown key");
        let prompt = &prompts[0];
        assert_eq!(prompt.host_id, "qa-host");
        assert_eq!(prompt.algorithm, "ssh-ed25519");
        // The dialog's fingerprint must be exactly what ssh-keygen -lf says.
        let pub_text = std::fs::read_to_string(host_key.with_extension("pub")).unwrap();
        let key: russh::keys::PublicKey = pub_text.parse().expect("parse host pubkey");
        assert_eq!(
            prompt.fingerprint,
            setu_lib::known_hosts::sha256_fingerprint(&key),
            "prompt fingerprint matches the server host key"
        );
    }
    let kh_text = std::fs::read_to_string(scratch.join(".ssh/known_hosts"))
        .expect("known_hosts was created by the trust");
    assert!(
        kh_text.contains(&format!("[127.0.0.1]:{port} ssh-ed25519 ")),
        "trust appended the bracketed host line: {kh_text:?}"
    );
    eprintln!("[ok] item 3 — unknown key prompted once, trust appended known_hosts");

    // A second connect must be silent (the key now matches).
    manager.disconnect(&session).await;
    let session = manager
        .connect(target(user_key.to_str().unwrap()))
        .await
        .expect("second connect (known key)");
    assert_eq!(
        recorder.prompts.lock().unwrap().len(),
        1,
        "no prompt on reconnect"
    );
    eprintln!("[ok] item 3 — reconnect with the trusted key is silent");

    // === Acceptance item 1: connect via the AGENT rung, browse home ======
    let agent_out = Command::new("/usr/bin/ssh-agent")
        .arg("-c")
        .output()
        .expect("spawn ssh-agent");
    let agent_text = String::from_utf8_lossy(&agent_out.stdout).to_string();
    let sock = agent_text
        .lines()
        .find_map(|l| l.strip_prefix("setenv SSH_AUTH_SOCK "))
        .map(|s| s.trim_end_matches(';').to_string())
        .expect("agent socket in output");
    let agent_pid = agent_text
        .lines()
        .find_map(|l| l.strip_prefix("setenv SSH_AGENT_PID "))
        .map(|s| s.trim_end_matches(';').to_string())
        .expect("agent pid in output");
    let added = Command::new("ssh-add")
        .arg(&user_key)
        .env("SSH_AUTH_SOCK", &sock)
        .stderr(Stdio::null())
        .status()
        .expect("run ssh-add");
    assert!(added.success(), "ssh-add failed");
    std::env::set_var("SSH_AUTH_SOCK", &sock);

    let agent_session = manager
        .connect(target("agent"))
        .await
        .expect("connect via ssh-agent identities");
    let sftp = manager.session(&agent_session).await.expect("live session");
    let home = sftp::remote_realpath(&sftp, ".").await.expect("realpath .");
    assert!(home.starts_with('/'), "home is absolute: {home}");
    let home_listing = sftp::remote_list(&sftp, &home).await.expect("list home");
    eprintln!(
        "[ok] item 1 — agent auth connected; home {home} lists {} entries",
        home_listing.len()
    );
    manager.disconnect(&agent_session).await;

    // === Pane ops on a scratch tree (dotfiles, unicode, symlinks) ========
    let sftp = manager.session(&session).await.expect("ops session");
    let work = scratch.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let work_str = work.to_str().unwrap();

    std::fs::write(work.join("plain.txt"), b"12345").unwrap();
    std::fs::write(work.join(".hidden-qa"), b"dot").unwrap();
    std::fs::write(work.join("café-📁-日誌.txt"), b"unicode").unwrap();
    std::os::unix::fs::symlink(work.join("plain.txt"), work.join("link-to-plain")).unwrap();

    let listing = sftp::remote_list(&sftp, work_str).await.expect("list work");
    let names: Vec<&str> = listing.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.contains(&".hidden-qa"),
        "dotfiles are listed (the toggle filters in the UI)"
    );
    assert!(
        names.contains(&"café-📁-日誌.txt"),
        "unicode names round-trip"
    );
    let link = listing.iter().find(|e| e.name == "link-to-plain").unwrap();
    assert!(
        link.is_symlink && !link.is_dir,
        "symlink rows describe the link"
    );
    assert!(
        link.link_target
            .as_deref()
            .unwrap_or("")
            .ends_with("plain.txt"),
        "link target is shown"
    );
    let plain = listing.iter().find(|e| e.name == "plain.txt").unwrap();
    assert_eq!(plain.size, 5, "sizes come through");

    // stat follows the link (the double-click behavior).
    let followed = sftp::remote_stat(&sftp, &format!("{work_str}/link-to-plain"))
        .await
        .expect("stat through link");
    assert!(!followed.is_symlink && followed.size == 5);

    // mkdir / rename / chmod.
    sftp::remote_mkdir(&sftp, &format!("{work_str}/made"))
        .await
        .expect("mkdir");
    sftp::remote_rename(
        &sftp,
        &format!("{work_str}/made"),
        &format!("{work_str}/moved"),
    )
    .await
    .expect("rename");
    assert!(work.join("moved").is_dir());
    sftp::remote_chmod(&sftp, &format!("{work_str}/plain.txt"), 0o640)
        .await
        .expect("chmod");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(work.join("plain.txt"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o640, "chmod applied");
    }

    // Recursive delete must remove links as links, never follow them.
    let del = work.join("del");
    std::fs::create_dir_all(del.join("sub")).unwrap();
    std::fs::write(del.join("sub/deep.txt"), b"x").unwrap();
    std::fs::write(work.join("keep.txt"), b"survives").unwrap();
    std::os::unix::fs::symlink(work.join("keep.txt"), del.join("trap-link")).unwrap();
    sftp::remote_delete(&sftp, del.to_str().unwrap(), true)
        .await
        .expect("recursive delete");
    assert!(!del.exists(), "tree removed");
    assert!(
        work.join("keep.txt").exists(),
        "delete never followed the symlink"
    );
    eprintln!("[ok] ops — list/stat/mkdir/rename/chmod/recursive-delete verified");

    // === Acceptance item 4 (backend half): a 10k-entry listing ===========
    let many = work.join("many10k");
    std::fs::create_dir_all(&many).unwrap();
    for i in 0..10_000 {
        std::fs::File::create(many.join(format!("f{i:05}"))).unwrap();
    }
    let started = Instant::now();
    let big_listing = sftp::remote_list(&sftp, many.to_str().unwrap())
        .await
        .expect("list 10k dir");
    let elapsed = started.elapsed();
    assert_eq!(big_listing.len(), 10_000);
    assert!(
        elapsed < Duration::from_secs(10),
        "10k listing took {elapsed:?} (expected well under 10s)"
    );
    eprintln!("[ok] item 4 — 10,000-entry listing returned in {elapsed:?}");

    // === Acceptance item 2: 200 MB upload — progress, integrity ==========
    let big_local = scratch.join("upload-200m.bin");
    write_patterned_200mb(&big_local);
    let local_hash = sha1_of(&big_local);
    let remote_big = format!("{work_str}/upload-200m.bin");

    let started = Instant::now();
    manager
        .upload(
            &session,
            big_local.to_str().unwrap(),
            &remote_big,
            "up-200m",
        )
        .await
        .expect("start 200MB upload");
    let (terminal, progress_events) = run_to_terminal(&mut xfer_rx, "200MB upload").await;
    let Xfer::Done { bytes, total } = terminal else {
        panic!("upload ended in {terminal:?}");
    };
    assert_eq!(bytes, 200 * 1024 * 1024);
    assert_eq!(total, 200 * 1024 * 1024);
    assert!(
        progress_events >= 2,
        "throttled progress streamed ({progress_events} events)"
    );
    assert_eq!(
        sha1_of(&work.join("upload-200m.bin")),
        local_hash,
        "byte-exact upload"
    );
    eprintln!(
        "[ok] item 2 — 200 MB uploaded byte-exact in {:?} with {} progress events",
        started.elapsed(),
        progress_events
    );

    // ... and the download back.
    let restored = scratch.join("restored-200m.bin");
    manager
        .download(
            &session,
            &remote_big,
            restored.to_str().unwrap(),
            "down-200m",
        )
        .await
        .expect("start 200MB download");
    let (terminal, _) = run_to_terminal(&mut xfer_rx, "200MB download").await;
    assert!(matches!(terminal, Xfer::Done { bytes, .. } if bytes == 200 * 1024 * 1024));
    assert_eq!(sha1_of(&restored), local_hash, "byte-exact download");
    eprintln!("[ok] item 2 — 200 MB downloaded byte-exact");

    // === Acceptance item 2: cancel mid-flight, partial file cleaned ======
    let sparse = scratch.join("cancel-4g.bin");
    {
        let file = std::fs::File::create(&sparse).unwrap();
        file.set_len(4 * 1024 * 1024 * 1024).unwrap(); // sparse: reads as zeros
    }
    let remote_partial = format!("{work_str}/cancel-4g.bin");
    let transfer_id = manager
        .upload(
            &session,
            sparse.to_str().unwrap(),
            &remote_partial,
            "cancel-4g",
        )
        .await
        .expect("start cancellable upload");
    // Wait until it is demonstrably mid-flight, then cancel.
    let first = next_xfer(&mut xfer_rx, "first progress of cancellable upload").await;
    assert!(matches!(first, Xfer::Progress { .. }));
    manager.cancel(&transfer_id);
    let (terminal, _) = run_to_terminal(&mut xfer_rx, "cancelled upload").await;
    assert!(matches!(terminal, Xfer::Cancelled), "ended in {terminal:?}");
    // Cleanup is part of the cancel path.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !work.join("cancel-4g.bin").exists(),
        "partial remote file removed on cancel"
    );
    eprintln!("[ok] item 2 — cancel mid-flight removed the partial file");

    // === Edge case: the link dies mid-transfer → Failed, retryable =======
    // A severable TCP proxy fronts the sshd; the doomed session connects
    // through it (a new [127.0.0.1]:{proxy} key prompt — auto-trusted).
    let proxy = SeverableProxy::start(port).await;
    let mut doomed_target = target(user_key.to_str().unwrap());
    doomed_target.port = proxy.port;
    let doomed_session = manager
        .connect(doomed_target)
        .await
        .expect("connect through the proxy");
    assert_eq!(
        recorder.prompts.lock().unwrap().len(),
        2,
        "the proxy port is a new known_hosts identity"
    );
    manager
        .upload(
            &doomed_session,
            sparse.to_str().unwrap(),
            &remote_partial,
            "doomed-4g",
        )
        .await
        .expect("start doomed upload");
    let first = next_xfer(&mut xfer_rx, "first progress of doomed upload").await;
    assert!(matches!(first, Xfer::Progress { .. }));
    proxy.sever();
    let (terminal, _) = run_to_terminal(&mut xfer_rx, "doomed upload").await;
    let Xfer::Failed { error, retryable } = terminal else {
        panic!("expected a failure after the link died, got {terminal:?}");
    };
    assert!(
        retryable,
        "a dropped connection must classify retryable (F5 auto-retry) — error was {error:?}"
    );
    eprintln!("[ok] edge — dropped link mid-transfer failed retryable: {error}");
    manager.disconnect(&doomed_session).await;
    manager.disconnect(&session).await;

    // === Security: a CHANGED host key refuses, never prompts =============
    drop(sshd);
    wait_port_closed(port);
    let sshd2 = start_sshd(&scratch, port, &host_key2, &authorized);
    let refused = manager.connect(target(user_key.to_str().unwrap())).await;
    let message = refused.expect_err("changed key must refuse the connection");
    assert!(
        message.contains("HOST KEY CHANGED"),
        "refusal names the mismatch: {message}"
    );
    assert_eq!(
        recorder.prompts.lock().unwrap().len(),
        2,
        "a mismatch never prompts"
    );
    eprintln!("[ok] security — changed host key hard-failed with no prompt");
    drop(sshd2);

    // === Teardown =========================================================
    manager.kill_all().await;
    let _ = Command::new("/bin/kill").args(["-9", &agent_pid]).status();
    std::fs::remove_dir_all(&scratch).ok();
    eprintln!("[done] live acceptance walk complete");
}
