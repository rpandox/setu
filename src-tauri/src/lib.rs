//! Setu application core.
//!
//! Setu is an open-source SSH command center for macOS. This crate is the Rust
//! side of a Tauri 2 app: it owns process lifecycle, PTY management, the host
//! store, and every IPC command the WebView can invoke. The frontend
//! (React + xterm.js) renders the cockpit; this crate does the work.
//!
//! Module map (mirrors `PLAN.md` §3):
//! - [`pty`] — PTY lifecycle: spawning `$SHELL` / `ssh` / `mosh`, I/O, resize, reaping.
//! - [`store`] — plain-TOML persistence for hosts, snippets, and settings.
//! - [`ipc`] — the Tauri command surface, mirrored by `src/ipc/contract.ts`.

#![deny(missing_docs)]

pub mod ipc;
pub mod pty;
pub mod store;

/// Builds and runs the Tauri application.
///
/// This is the single entry point used by the binary crate. It registers all
/// IPC handlers and blocks until the app exits.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialize — for example when the
/// bundled configuration (`tauri.conf.json`) is invalid. There is no meaningful
/// way to continue without a runtime, so startup failure is fatal by design.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
