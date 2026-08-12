//! PTY lifecycle: spawning shells, streaming I/O, resizing, and reaping.
//!
//! Interactive sessions in Setu drive the *system* `ssh` (or `mosh`, or
//! `$SHELL` for local tabs) inside a portable-pty pseudo-terminal — the app
//! never implements the SSH protocol for terminals (`PLAN.md` §3). This module
//! will own that pipeline: spawn, batched reads to the WebView, writes,
//! resize propagation, and guaranteed child reaping on close.
//!
//! Empty in Phase 0; Phase 1 lands `pty_spawn` / `pty_write` / `pty_resize` /
//! `pty_kill` here.
