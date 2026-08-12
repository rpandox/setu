# PTY pipeline

How Setu spawns shells inside a portable-pty, batches output to xterm.js,
propagates resizes, and guarantees child reaping. The Rust side lives in
[`src-tauri/src/pty.rs`](../../src-tauri/src/pty.rs); the frontend side in
[`src/features/terminal/stream.ts`](../../src/features/terminal/stream.ts).
The IPC surface between them is documented in [ipc.md](ipc.md).

## The pipeline

```
$SHELL -l  ←──  portable-pty master  ←──  PtyManager (Rust)
    │                                        │ reader thread per session
    │ output (bytes)                         │ 16 KB reads → base64
    ▼                                        ▼
kernel PTY buffer ──► pty:data:{id} events ──► stream buffer (WebView)
                                                │ rAF-coalesced flush
                                                │ 256 KB/64 KB watermarks
                                                ▼
                                            term.write(chunk, callback)
```

### Spawning

`pty_spawn` runs `$SHELL` (fallback `/bin/zsh`) with `-l` — a login shell, so
`~/.zprofile` and friends run exactly as in Terminal.app — or, for
`kind: "ssh"`, the system `ssh` with an argv built by
[`src-tauri/src/connect.rs`](../../src-tauri/src/connect.rs) (see
[ipc.md](ipc.md#pty_spawn)). Either way the child gets:

- `TERM=xterm-256color`, `COLORTERM=truecolor`
- `LANG=en_US.UTF-8` **only if unset** — GUI-launched apps inherit no locale,
  and a C-locale shell breaks wide-character output
- cwd `$HOME`

### Batching and backpressure (PLAN.md §3)

- The Rust reader thread reads in **16 KB** chunks (`READ_BUF_BYTES`) and
  emits each as one base64 `pty:data` event — bytes, not text, because a
  chunk boundary may split a UTF-8 sequence.
- The frontend queues decoded chunks and flushes **once per animation
  frame** (a timer stands in while the window is hidden, where rAF pauses).
- Backpressure honors xterm's write callback: bytes written but not yet
  parsed count as _outstanding_; above **256 KB** the flush loop stops, and
  it resumes when the callbacks drain outstanding below **64 KB**. A `cat`
  of a 50 MB file therefore saturates the parser without ever flooding it,
  and typing stays responsive.

### Resizes

`FitAddon.fit()` runs on container resize (coalesced to animation frames)
and on tab activation; the resulting `term.onResize` invokes `pty_resize`,
and the kernel delivers `SIGWINCH` to the child.

### Exit, close, and reaping

The lifecycle invariant, in order, per session (the order is load-bearing on
macOS — see the pitfalls below):

1. The reader hits EOF (or `EIO`) when the last slave fd closes.
2. The reader thread calls `child.wait()` — the child is reaped; no zombie.
3. `pty:exit:{sessionId}` is emitted with the exit code (`null` for signal
   deaths).
4. The session is removed from the map, dropping the master **last**.

`pty_kill` just signals the child; cleanup always flows through the same
four steps. Closing a tab in the UI removes it immediately and lets the
backend finish asynchronously — `pty_kill` on an unknown id is a no-op, so
the UI can never race the child's own exit. On app exit, `kill_all()` runs
from Tauri's exit events: no orphaned children, ever.

## Pitfalls this design encodes

- **Never close the master before `wait()`** — waitpid can hang, and a
  command's final output bytes can be lost. The final-bytes ordering is
  covered by a unit test (`output_arrives_before_exit_and_session_is_reaped`).
- **A panicking reader must still clean up** — the read loop runs under
  `catch_unwind`, and the reap/exit/removal steps run regardless.
- **Writes happen outside the session-map lock** — a child stopped with
  `^S` blocks writes to it; holding the map lock through that would freeze
  every other session.
- **A theoretical first-bytes race exists on spawn**: the WebView subscribes
  to `pty:data:{id}` right after `pty_spawn` resolves, so a shell that
  prints within ~a millisecond could emit before the listener lands. In
  practice login shells take tens of milliseconds to first output. If it
  ever bites, the escape hatch is a frontend-supplied session id (subscribe
  before spawn) — a contract change to log in PLAN.md §5 first.

## Testing

`cargo test --manifest-path src-tauri/Cargo.toml` covers the Rust half via a
channel-backed `PtyEvents` sink (no Tauri runtime needed): spawn → output →
exit ordering, exit codes, kill/kill-all reaping, resize, and unknown-session
behavior. `pnpm vitest run` covers the frontend half: watermark pacing with a
mocked `term.write`, base64 round-trips (including split UTF-8 sequences),
and session/tab state transitions.
