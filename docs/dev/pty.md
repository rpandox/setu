# PTY pipeline

How Setu spawns shells (`$SHELL`, system `ssh`, `mosh`) inside a
portable-pty, batches output to xterm.js, propagates resizes, and guarantees
child reaping.

**Stub — filled in by Phase 1**, when the pipeline lands in
[`src-tauri/src/pty.rs`](../../src-tauri/src/pty.rs). Performance
requirements are specified in [PLAN.md](../../PLAN.md) §3.
