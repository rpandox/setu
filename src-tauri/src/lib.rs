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
//! - [`settings`] — read-only `settings.toml` access (prober knobs, Phase 4).
//! - [`ui_state`] — device-local `state.json`: layout restore + UI prefs (F4).
//! - [`ssh_config`] — the small `~/.ssh/config` reader behind the F1 import.
//! - [`connect`] — the `Host` → `ssh` argv spawn pipeline (F3).
//! - [`forwards`] — managed `ssh -N` port-forward children (F7).
//! - [`reach`] — the TCP reachability prober behind the LED board (F1).
//! - [`known_hosts`] — host-key verification for the in-app SFTP client (F5).
//! - [`sftp`] — the in-app SFTP client: connections, trust flow, sessions (F5).
//! - [`snippets`] — plain-TOML persistence for snippets + packs (F6).
//! - [`keychain`] — the Keychain doorway: SFTP passwords & key passphrases (F8).
//! - [`keygen`] — `ssh-keygen` driven through a hidden PTY (F8).
//! - [`vault`] — the age-encrypted config-dir export (F8).
//! - [`agent`] — ssh-agent introspection via `ssh-add -l` (F8).
//! - [`binaries`] — locating optional tools (mosh, tailscale, claude).
//! - [`tailscale`] — the tailnet as a host source: peers, ping, adopt (F9).
//! - [`ipc`] — the Tauri command surface, mirrored by `src/ipc/contract.ts`.

#![deny(missing_docs)]

pub mod agent;
pub mod binaries;
pub mod connect;
pub mod forwards;
pub mod ipc;
pub mod keychain;
pub mod keygen;
pub mod known_hosts;
pub mod pty;
pub mod reach;
pub mod settings;
pub mod sftp;
pub mod snapshots;
pub mod snippets;
pub mod ssh_config;
pub mod store;
pub mod sync;
pub mod tailscale;
pub mod ui_state;
pub mod vault;

/// Builds and runs the Tauri application.
///
/// This is the single entry point used by the binary crate. It installs the
/// [`pty::PtyManager`] into managed state (wired to emit `pty:*` events via
/// [`ipc::TauriPtyEvents`]), registers all IPC handlers, and blocks until the
/// app exits. On exit request every live PTY child is killed — no orphans
/// (`CLAUDE.md` hard rule).
///
/// With `SETU_STARTUP_PROBE=1` in the environment, the elapsed time from
/// process start to each webview's finished page load is printed to stderr —
/// the cold-launch evidence for the Phase 9 acceptance bar (run the release
/// binary from a terminal to read it). Unset, the probe is silent.
///
/// # Panics
///
/// Panics if the Tauri runtime fails to initialize — for example when the
/// bundled configuration (`tauri.conf.json`) is invalid. There is no meaningful
/// way to continue without a runtime, so startup failure is fatal by design.
pub fn run() {
    use std::sync::Arc;
    use tauri::Manager as _;

    let started = std::time::Instant::now();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(move |webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && std::env::var_os("SETU_STARTUP_PROBE").is_some()
            {
                eprintln!(
                    "setu: startup probe: `{}` page loaded {} ms after process start",
                    webview.label(),
                    started.elapsed().as_millis()
                );
            }
        })
        .setup(|app| {
            // The standard macOS menu: without it the app has no ⌘Q, which
            // would leave users no way to reach the kill-all exit path.
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            let events = Arc::new(ipc::TauriPtyEvents::new(app.handle().clone()));
            app.manage(pty::PtyManager::new(events));
            app.manage(store::HostsStore::new(store::HostsStore::default_path()?));
            app.manage(snippets::SnippetsStore::new(
                snippets::SnippetsStore::default_path()?,
            ));
            app.manage(settings::SettingsStore::new(
                settings::SettingsStore::default_path()?,
            ));
            // The prober reads hosts and emits reach:update through the app
            // handle; it stays idle until the frontend invokes reach_start.
            app.manage(reach::ReachProber::new(
                Arc::new(ipc::AppTargetSource::new(app.handle().clone())),
                Arc::new(ipc::TauriReachEvents::new(app.handle().clone())),
            ));
            // state.json lives in the app-support dir (PLAN.md §4) — resolved
            // here so the module itself stays Tauri-free like the others.
            app.manage(ui_state::UiStateStore::new(
                app.path().app_data_dir()?.join("state.json"),
            ));
            app.manage(sftp::SftpManager::new(Arc::new(ipc::TauriSftpEvents::new(
                app.handle().clone(),
            ))));
            app.manage(forwards::ForwardManager::new(Arc::new(
                ipc::TauriForwardEvents::new(app.handle().clone()),
            )));
            // Git sync (F10): one manager over ~/.config/setu; the run lock
            // inside serializes Sync now, quit-hook, and Settings actions.
            app.manage(sync::SyncManager::new(sync::SyncManager::default_dir()?));
            // Scheduled snapshots (F10): idle scheduler, spawned right away —
            // it re-reads settings each pass, so no restart on change.
            app.manage(snapshots::SnapshotScheduler::new());
            app.state::<snapshots::SnapshotScheduler>()
                .start(app.handle().clone());
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
            ipc::snippet_list,
            ipc::snippet_upsert,
            ipc::snippet_delete,
            ipc::snippet_import,
            ipc::snippet_export,
            ipc::forward_start,
            ipc::forward_stop,
            ipc::reach_start,
            ipc::reach_stop,
            ipc::reach_set_visible,
            ipc::ui_state_get,
            ipc::ui_state_set,
            ipc::sftp_connect,
            ipc::hostkey_trust,
            ipc::sftp_disconnect,
            ipc::sftp_list,
            ipc::sftp_realpath,
            ipc::sftp_stat,
            ipc::sftp_mkdir,
            ipc::sftp_rename,
            ipc::sftp_delete,
            ipc::sftp_chmod,
            ipc::sftp_local_list,
            ipc::sftp_local_stat,
            ipc::sftp_local_mkdir,
            ipc::sftp_local_rename,
            ipc::sftp_local_delete,
            ipc::sftp_local_chmod,
            ipc::sftp_upload,
            ipc::sftp_download,
            ipc::sftp_cancel,
            ipc::keychain_set,
            ipc::keychain_delete,
            ipc::keychain_has,
            ipc::keys_generate,
            ipc::agent_list,
            ipc::binary_check,
            ipc::tailscale_peers,
            ipc::tailscale_ping,
            ipc::vault_export,
            ipc::settings_get,
            ipc::settings_set,
            ipc::settings_window_open,
            ipc::git_sync_status,
            ipc::git_sync_run,
            ipc::git_sync_set_remote,
            ipc::git_sync_abort,
            ipc::sync_open_dir,
            ipc::snapshot_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Both arms fire on the way out; kill_all and stop are idempotent.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                // Auto-sync on quit (F10, opt-in): once, capped at 10s so
                // quit never hangs on a dead network; a conflicted repo is
                // refused politely inside run() and left untouched.
                static QUIT_SYNC: std::sync::Once = std::sync::Once::new();
                QUIT_SYNC.call_once(|| {
                    let auto = app
                        .state::<settings::SettingsStore>()
                        .document()
                        .map(|doc| doc.sync.auto_sync_on_quit)
                        .unwrap_or(false);
                    if auto {
                        let manager = app.state::<sync::SyncManager>();
                        let _ = tauri::async_runtime::block_on(async {
                            tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                manager.run(&sync::device_hostname()),
                            )
                            .await
                        });
                    }
                });
                app.state::<pty::PtyManager>().kill_all();
                app.state::<reach::ReachProber>().stop();
                // Forward children die with the app — process-group SIGTERM,
                // no orphans in `ps` (F7 acceptance).
                app.state::<forwards::ForwardManager>().kill_all();
                // SFTP teardown is async (protocol goodbyes); block briefly
                // so no connection or transfer outlives the app.
                tauri::async_runtime::block_on(app.state::<sftp::SftpManager>().kill_all());
            }
        });
}
