# IPC reference

Every Tauri command and event in Setu, with payloads, results, and failure
modes. This file is one third of the contract triplet — it changes in the same
commit as [`src/ipc/contract.ts`](../../src/ipc/contract.ts) and
[`src-tauri/src/ipc.rs`](../../src-tauri/src/ipc.rs), or not at all.

## Conventions

- Command names are `snake_case`, matching the Rust handlers.
- Commands are request/response (`invoke`); events are core→WebView pushes.
- Session-scoped events embed the id in the channel name, e.g.
  `pty:data:{sessionId}`.
- Every command documents: payload, result, emitted events, failure modes.

## Commands

None yet. The contract is intentionally empty in Phase 0; Phase 1 adds the
`pty_*` family (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`).

## Events

None yet. Phase 1 adds `pty:data:{sessionId}` and `pty:exit:{sessionId}`.
