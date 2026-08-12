//! The Tauri IPC command surface.
//!
//! Every `#[tauri::command]` Setu exposes is declared here, and every one of
//! them is mirrored by a typed entry in `src/ipc/contract.ts` on the frontend.
//! The two files plus `docs/dev/ipc.md` form a triplet that changes in the
//! same commit or not at all (`CLAUDE.md`).
//!
//! No commands exist yet: the contract is intentionally empty in Phase 0.
//! Phase 1 adds the `pty_*` command family.
