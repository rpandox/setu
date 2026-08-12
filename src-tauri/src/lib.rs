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
//! - [`ui_state`] — device-local `state.json`: layout restore + UI prefs (F4).
//! - [`ssh_config`] — the small `~/.ssh/config` reader behind the F1 import.
//! - [`connect`] — the `Host` → `ssh` argv spawn pipeline (F3).
//! - [`ipc`] — the Tauri command surface, mirrored by `src/ipc/contract.ts`.

#![deny(missing_docs)]

pub mod connect;
pub mod ipc;
pub mod pty;
pub mod ssh_config;
pub mod store;
pub mod ui_state;

/// Builds and runs the Tauri application.
///
/// This is the single entry point used by the binary crate. It installs the
/// [`pty::PtyManager`] into managed state (wired to emit `pty:*` events via
/// [`ipc::TauriPtyEvents`]), registers all IPC handlers, and blocks until the
/// app exits. On exit request every live PTY child is killed — no orphans
/// (`CLAUDE.md` hard rule).
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialize — for example when the
/// bundled configuration (`tauri.conf.json`) is invalid. There is no meaningful
/// way to continue without a runtime, so startup failure is fatal by design.
pub fn run() {
    use std::sync::Arc;
    use tauri::Manager as _;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The standard macOS menu: without it the app has no ⌘Q, which
            // would leave users no way to reach the kill-all exit path.
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            let events = Arc::new(ipc::TauriPtyEvents::new(app.handle().clone()));
            app.manage(pty::PtyManager::new(events));
            app.manage(store::HostsStore::new(store::HostsStore::default_path()?));
            // state.json lives in the app-support dir (PLAN.md §4) — resolved
            // here so the module itself stays Tauri-free like the others.
            app.manage(ui_state::UiStateStore::new(
                app.path().app_data_dir()?.join("state.json"),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::pty_spawn,
            ipc::pty_write,
            ipc::pty_resize,
            ipc::pty_kill,
            ipc::hosts_list,
            ipc::host_upsert,
            ipc::host_delete,
            ipc::host_adopt,
            ipc::ui_state_get,
            ipc::ui_state_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Both arms fire on the way out; kill_all is idempotent.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<pty::PtyManager>().kill_all();
            }
        });
}
