//! PTY lifecycle: spawning shells, streaming I/O, resizing, and reaping.
//!
//! Interactive sessions in Setu drive the *system* `ssh` (or `mosh`, or
//! `$SHELL` for local tabs) inside a portable-pty pseudo-terminal — the app
//! never implements the SSH protocol for terminals (`PLAN.md` §3). This module
//! owns that pipeline: spawn, batched reads, writes, resize propagation, and
//! guaranteed child reaping on close.
//!
//! The module is deliberately Tauri-free. Output and exit notifications flow
//! through the [`PtyEvents`] trait; the Tauri layer (`ipc.rs`) implements it
//! with `AppHandle::emit`, and unit tests implement it with an mpsc channel.
//!
//! Lifecycle invariants (load-bearing on macOS):
//! 1. One reader thread per session reads the master in [`READ_BUF_BYTES`]
//!    chunks (PLAN.md §3: batched 8–16 KB reads).
//! 2. On EOF the reader calls `child.wait()` *before* anything else — reaping
//!    the child so no zombie survives.
//! 3. Only then is [`PtyEvents::on_exit`] emitted and the session removed
//!    from the map, which drops the master **last**. Closing the master
//!    before `wait()` can hang the wait or drop a command's final bytes.
//!
//! Per the hard rules in `CLAUDE.md`, PTY contents are never logged; errors
//! carry session ids only.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize,
};

/// Size of the reader buffer, and therefore the maximum bytes per
/// `pty:data` chunk (PLAN.md §3 requires 8–16 KB batches).
pub const READ_BUF_BYTES: usize = 16 * 1024;

/// Where PTY output and exit notifications go.
///
/// Implementations must be cheap and non-blocking: `on_data` is called from
/// the session's reader thread between reads, so a slow sink stalls that
/// session's output (and only that session's).
pub trait PtyEvents: Send + Sync + 'static {
    /// A chunk of raw PTY output, base64-encoded, for session `session_id`.
    fn on_data(&self, session_id: &str, chunk_base64: &str);

    /// Session `session_id`'s child exited. `code` is the exit code, or
    /// `None` when the child died from a signal (or the code is unknown).
    /// This is the final callback for the session.
    fn on_exit(&self, session_id: &str, code: Option<i32>);
}

/// A live PTY session: the master side, a shared writer, and a kill handle.
///
/// The child itself is owned by the session's reader thread, which needs it
/// for the EOF → `wait()` reap; the map holds a [`ChildKiller`] clone so
/// `kill` works without touching the child.
struct PtySession {
    /// Master side of the PTY. Held here so it drops when the session is
    /// removed — which the reader thread does only *after* reaping.
    master: Box<dyn MasterPty + Send>,
    /// Writer to the child's stdin. Shared so writes happen outside the
    /// session-map lock (a blocked write must not freeze other sessions).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Kill handle cloned from the child at spawn time.
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Owns every live PTY session and enforces the lifecycle invariants.
///
/// One instance lives in Tauri managed state for the whole app run. All
/// methods take `&self`; interior mutability is a mutex over the session map.
///
/// # Examples
///
/// ```
/// use std::sync::Arc;
/// use setu_lib::pty::{PtyEvents, PtyManager};
///
/// struct NullEvents;
/// impl PtyEvents for NullEvents {
///     fn on_data(&self, _: &str, _: &str) {}
///     fn on_exit(&self, _: &str, _: Option<i32>) {}
/// }
///
/// let manager = PtyManager::new(Arc::new(NullEvents));
/// assert_eq!(manager.session_count(), 0);
/// ```
pub struct PtyManager {
    /// Sink for output and exit notifications.
    events: Arc<dyn PtyEvents>,
    /// Live sessions by id. `Arc` so reader threads can remove themselves.
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    /// Creates a manager that reports through `events`.
    pub fn new(events: Arc<dyn PtyEvents>) -> Self {
        Self {
            events,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawns `$SHELL` (fallback `/bin/zsh`) as a login shell in a new PTY
    /// sized `cols` × `rows`, and returns the new session id.
    ///
    /// The child gets `TERM=xterm-256color`, `COLORTERM=truecolor`, a UTF-8
    /// `LANG` when none is set (GUI-launched apps inherit no locale, which
    /// would break wide-character handling), and `$HOME` as its cwd.
    ///
    /// # Errors
    ///
    /// Returns a message when the PTY cannot be opened or the shell cannot
    /// be spawned (for example, `$SHELL` points at a missing binary).
    pub fn spawn_local(&self, cols: u16, rows: u16) -> Result<String, String> {
        self.spawn_command(login_shell_command(), cols, rows)
    }

    /// Spawns an arbitrary command in a new PTY — the primitive under
    /// [`PtyManager::spawn_local`], used directly by tests (and by later
    /// phases for `ssh`/`mosh`).
    ///
    /// # Errors
    ///
    /// Returns a message when opening the PTY, spawning the child, or
    /// cloning its I/O handles fails.
    pub fn spawn_command(
        &self,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn child: {e}"))?;
        // Drop our slave handle now: the child holds its own, and a lingering
        // copy here would keep the reader from ever seeing EOF.
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {e}"))?;

        let session_id = uuid::Uuid::new_v4().to_string();
        self.sessions
            .lock()
            .expect("pty session map poisoned")
            .insert(
                session_id.clone(),
                PtySession {
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    killer,
                },
            );

        let events = Arc::clone(&self.events);
        let sessions = Arc::clone(&self.sessions);
        let id = session_id.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                // A panic in the read loop must not leave a silently dead
                // session: fall through to the same reap + exit + cleanup.
                let _ = catch_unwind(AssertUnwindSafe(|| {
                    let mut buf = [0u8; READ_BUF_BYTES];
                    loop {
                        match reader.read(&mut buf) {
                            // 0 = EOF; Err = EIO when the last slave fd
                            // closes on macOS. Both mean the child is done.
                            Ok(0) | Err(_) => break,
                            Ok(n) => events.on_data(&id, &BASE64.encode(&buf[..n])),
                        }
                    }
                }));
                // Reap first (waitpid), then announce, then drop the master
                // by removing the session — strictly in that order.
                let code = child.wait().ok().map(exit_code_of).unwrap_or(None);
                events.on_exit(&id, code);
                sessions
                    .lock()
                    .expect("pty session map poisoned")
                    .remove(&id);
            })
            .map_err(|e| format!("failed to start reader thread: {e}"))?;

        Ok(session_id)
    }

    /// Writes `data` (UTF-8 keystrokes/paste text) to a session's stdin.
    ///
    /// The write happens outside the session-map lock so one stalled child
    /// (e.g. stopped with `^S`) cannot freeze operations on other sessions.
    ///
    /// # Errors
    ///
    /// Returns a message when the session id is unknown or the write fails.
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let sessions = self.sessions.lock().expect("pty session map poisoned");
            let session = sessions
                .get(session_id)
                .ok_or_else(|| format!("unknown session: {session_id}"))?;
            Arc::clone(&session.writer)
        };
        let mut writer = writer.lock().expect("pty writer poisoned");
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("write to session {session_id} failed: {e}"))
    }

    /// Resizes a session's PTY to `cols` × `rows`; the kernel delivers
    /// `SIGWINCH` to the child.
    ///
    /// # Errors
    ///
    /// Returns a message when the session id is unknown or the resize fails.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().expect("pty session map poisoned");
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown session: {session_id}"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize of session {session_id} failed: {e}"))
    }

    /// Terminates a session's child. Cleanup (reap, `on_exit`, removal)
    /// follows asynchronously via the reader thread, exactly as when the
    /// child exits on its own.
    ///
    /// Unknown ids are a **no-op**, making close race-free: the child may
    /// have already exited between the UI's close action and this call.
    ///
    /// # Errors
    ///
    /// Never fails today; the `Result` keeps the signature stable for later
    /// phases.
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().expect("pty session map poisoned");
        if let Some(session) = sessions.get_mut(session_id) {
            // The child may have died a moment ago; that race is fine.
            let _ = session.killer.kill();
        }
        Ok(())
    }

    /// Terminates every live session — wired to app exit so no child ever
    /// outlives the app (hard rule: no orphans).
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().expect("pty session map poisoned");
        for session in sessions.values_mut() {
            let _ = session.killer.kill();
        }
    }

    /// Number of currently live sessions.
    pub fn session_count(&self) -> usize {
        self.sessions
            .lock()
            .expect("pty session map poisoned")
            .len()
    }
}

/// Maps a child's [`ExitStatus`] to the IPC contract's `code` field:
/// the exit code, or `None` for signal deaths.
fn exit_code_of(status: ExitStatus) -> Option<i32> {
    if status.signal().is_some() {
        None
    } else {
        Some(status.exit_code() as i32)
    }
}

/// Builds the login-shell command for local tabs: `$SHELL -l` (fallback
/// `/bin/zsh`), with the environment described on [`PtyManager::spawn_local`].
fn login_shell_command() -> CommandBuilder {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    apply_terminal_env(&mut cmd);
    cmd
}

/// Applies the environment every Setu PTY child gets: `TERM=xterm-256color`,
/// `COLORTERM=truecolor`, a UTF-8 `LANG` when none is set (GUI-launched apps
/// inherit no locale, which would break wide-character handling), and `$HOME`
/// as the working directory. Used by local shells and `ssh` spawns alike.
pub fn apply_terminal_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// What a [`ChannelEvents`] sink observed, in order.
    enum Event {
        Data(Vec<u8>),
        Exit(Option<i32>),
    }

    /// Test sink: decodes chunks and forwards everything over a channel.
    struct ChannelEvents {
        tx: mpsc::Sender<Event>,
    }

    impl PtyEvents for ChannelEvents {
        fn on_data(&self, _session_id: &str, chunk_base64: &str) {
            let bytes = BASE64.decode(chunk_base64).expect("valid base64");
            let _ = self.tx.send(Event::Data(bytes));
        }

        fn on_exit(&self, _session_id: &str, code: Option<i32>) {
            let _ = self.tx.send(Event::Exit(code));
        }
    }

    fn manager_with_channel() -> (PtyManager, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel();
        (PtyManager::new(Arc::new(ChannelEvents { tx })), rx)
    }

    fn sh(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd
    }

    /// Drains events until `Exit`, returning (all output bytes, exit code).
    /// Panics if no exit arrives within `timeout`.
    fn collect_until_exit(rx: &mpsc::Receiver<Event>, timeout: Duration) -> (Vec<u8>, Option<i32>) {
        let deadline = Instant::now() + timeout;
        let mut output = Vec::new();
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("timed out waiting for pty:exit");
            match rx.recv_timeout(remaining).expect("event before timeout") {
                Event::Data(bytes) => output.extend_from_slice(&bytes),
                Event::Exit(code) => return (output, code),
            }
        }
    }

    /// Polls until the reader thread has removed the session (cleanup runs
    /// after `on_exit`, so allow a grace period).
    fn assert_eventually_empty(manager: &PtyManager) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.session_count() > 0 {
            assert!(Instant::now() < deadline, "session was never cleaned up");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn output_arrives_before_exit_and_session_is_reaped() {
        let (manager, rx) = manager_with_channel();
        manager
            .spawn_command(sh("printf 'final-bytes'"), 80, 24)
            .expect("spawn");
        let (output, code) = collect_until_exit(&rx, Duration::from_secs(10));
        // The final bytes of output must be delivered before the exit event —
        // this is the master-dropped-last ordering invariant.
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("final-bytes"), "lost final output: {text:?}");
        assert_eq!(code, Some(0));
        assert_eventually_empty(&manager);
    }

    #[test]
    fn nonzero_exit_code_is_reported() {
        let (manager, rx) = manager_with_channel();
        manager.spawn_command(sh("exit 3"), 80, 24).expect("spawn");
        let (_, code) = collect_until_exit(&rx, Duration::from_secs(10));
        assert_eq!(code, Some(3));
        assert_eventually_empty(&manager);
    }

    #[test]
    fn kill_terminates_and_cleans_up() {
        let (manager, rx) = manager_with_channel();
        let id = manager
            .spawn_command(sh("sleep 30"), 80, 24)
            .expect("spawn");
        assert_eq!(manager.session_count(), 1);
        manager.kill(&id).expect("kill");
        // Signal death: exit must still arrive and the session must go away.
        let (_, _code) = collect_until_exit(&rx, Duration::from_secs(10));
        assert_eventually_empty(&manager);
    }

    #[test]
    fn kill_all_terminates_every_session() {
        let (manager, rx) = manager_with_channel();
        manager
            .spawn_command(sh("sleep 30"), 80, 24)
            .expect("spawn");
        manager
            .spawn_command(sh("sleep 30"), 80, 24)
            .expect("spawn");
        assert_eq!(manager.session_count(), 2);
        manager.kill_all();
        let _ = collect_until_exit(&rx, Duration::from_secs(10));
        let _ = collect_until_exit(&rx, Duration::from_secs(10));
        assert_eventually_empty(&manager);
    }

    #[test]
    fn resize_succeeds_on_live_session() {
        let (manager, rx) = manager_with_channel();
        let id = manager.spawn_command(sh("sleep 2"), 80, 24).expect("spawn");
        manager.resize(&id, 120, 40).expect("resize");
        manager.kill(&id).expect("kill");
        let _ = collect_until_exit(&rx, Duration::from_secs(10));
    }

    #[test]
    fn unknown_session_ops_behave_as_documented() {
        let (manager, _rx) = manager_with_channel();
        assert!(manager.write("nope", "x").is_err());
        assert!(manager.resize("nope", 80, 24).is_err());
        // kill is idempotent by contract.
        assert!(manager.kill("nope").is_ok());
    }

    #[test]
    fn write_reaches_the_child() {
        let (manager, rx) = manager_with_channel();
        // `cat` echoes stdin back through the PTY until EOF/kill.
        let id = manager.spawn_command(sh("cat"), 80, 24).expect("spawn");
        manager.write(&id, "marco\n").expect("write");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = Vec::new();
        while !String::from_utf8_lossy(&seen).contains("marco") {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("echo never arrived");
            match rx.recv_timeout(remaining).expect("event before timeout") {
                Event::Data(bytes) => seen.extend_from_slice(&bytes),
                Event::Exit(_) => panic!("cat exited before echoing"),
            }
        }
        manager.kill(&id).expect("kill");
        let _ = collect_until_exit(&rx, Duration::from_secs(10));
    }
}
