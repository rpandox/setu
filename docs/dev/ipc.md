# IPC reference

Every Tauri command and event in Setu, with payloads, results, and failure
modes. This file is one third of the contract triplet — it changes in the same
commit as [`src/ipc/contract.ts`](../../src/ipc/contract.ts) and
[`src-tauri/src/ipc.rs`](../../src-tauri/src/ipc.rs), or not at all.

## Conventions

- Command names are `snake_case`, matching the Rust handlers. Payload keys
  are `camelCase`; Tauri converts them to the Rust arguments' `snake_case`.
- Commands are request/response (`invoke`); events are core→WebView pushes.
- Session-scoped events embed the id in the channel name, e.g.
  `pty:data:{sessionId}`.
- Command failures reject the `invoke` promise with a message string. Error
  messages carry session ids, never PTY contents.
- Frontend code never calls Tauri's `invoke`/`listen` directly — it goes
  through the typed helpers in [`src/ipc/client.ts`](../../src/ipc/client.ts).

## Commands

### `pty_spawn`

Spawn a PTY session running `$SHELL` (fallback `/bin/zsh`) as a login shell,
sized to the terminal that will render it. See
[pty.md](pty.md) for the pipeline behind it.

|            |                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{ kind: "local", cols: number, rows: number }`                                                                                          |
| Result     | `{ sessionId: string }`                                                                                                                  |
| Emits      | `pty:data:{sessionId}` from spawn onward; one final `pty:exit:{sessionId}`                                                               |
| Fails when | the PTY can't be opened or the shell can't be spawned (missing `$SHELL` binary, resource exhaustion). No session exists after a failure. |

`kind` is `"local"` only in Phase 1; the union widens to `"ssh" | "mosh"` in
Phase 2.

### `pty_write`

Write input — keystrokes or paste text — to a session's stdin.

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| Payload    | `{ sessionId: string, data: string }`                               |
| Result     | `null`                                                              |
| Emits      | nothing directly; output returns via `pty:data:{sessionId}`         |
| Fails when | the session id is unknown (child already exited) or the write fails |

### `pty_resize`

Propagate a terminal resize; the child process receives `SIGWINCH`.

|            |                                                            |
| ---------- | ---------------------------------------------------------- |
| Payload    | `{ sessionId: string, cols: number, rows: number }`        |
| Result     | `null`                                                     |
| Emits      | nothing                                                    |
| Fails when | the session id is unknown or the kernel rejects the resize |

### `pty_kill`

Terminate a session's child. Cleanup and the final `pty:exit:{sessionId}`
arrive asynchronously through the same path as a natural exit.

|            |                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------- |
| Payload    | `{ sessionId: string }`                                                                      |
| Result     | `null`                                                                                       |
| Emits      | `pty:exit:{sessionId}` (via the normal exit path)                                            |
| Fails when | never — unknown ids are a documented no-op, so closing a tab can't race the child's own exit |

## Events

### `pty:data:{sessionId}`

A chunk of raw PTY output, base64-encoded (output is bytes, and a chunk may
split a UTF-8 sequence — base64 keeps the transport byte-faithful). Chunks
are at most 16 KB of decoded bytes and arrive in order.

Payload: `string` (base64).

### `pty:exit:{sessionId}`

The session's child exited — the final event for that session; no `pty:data`
follows it.

Payload: `{ code: number | null }` — the exit code, or `null` when the child
died from a signal (including `pty_kill`).
