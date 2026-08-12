# IPC reference

Every Tauri command and event in Setu, with payloads, results, and failure
modes. This file is one third of the contract triplet — it changes in the same
commit as [`src/ipc/contract.ts`](../../src/ipc/contract.ts) and
[`src-tauri/src/ipc.rs`](../../src-tauri/src/ipc.rs), or not at all.

## Conventions

- Command names are `snake_case`, matching the Rust handlers. Payload keys
  are `camelCase`; Tauri converts them to the Rust arguments' `snake_case`.
  Exception: `Host` record fields are snake_case — the record mirrors the
  `hosts.toml` schema ([PLAN.md](../../PLAN.md) §4, [store.md](store.md))
  verbatim on both sides of IPC.
- Commands are request/response (`invoke`); events are core→WebView pushes.
- Session-scoped events embed the id in the channel name, e.g.
  `pty:data:{sessionId}`.
- Command failures reject the `invoke` promise with a message string. Error
  messages carry session ids, never PTY contents.
- Frontend code never calls Tauri's `invoke`/`listen` directly — it goes
  through the typed helpers in [`src/ipc/client.ts`](../../src/ipc/client.ts).

## Commands

### `pty_spawn`

Spawn a PTY session — `"local"` runs `$SHELL` (fallback `/bin/zsh`) as a
login shell; `"ssh"` runs system `ssh -tt` to a known host with keepalive
flags (`ServerAliveInterval=30`, `ServerAliveCountMax=3`). See
[pty.md](pty.md) for the pipeline behind it.

|            |                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{ kind: "local", cols: number, rows: number }` · `{ kind: "ssh", hostId: string, cols: number, rows: number }`                                          |
| Result     | `{ sessionId: string }`                                                                                                                                  |
| Emits      | `pty:data:{sessionId}` from spawn onward; one final `pty:exit:{sessionId}`                                                                               |
| Fails when | the PTY can't be opened, the child can't be spawned, `kind` is `"ssh"` without a `hostId`, or the host id is unknown. No session exists after a failure. |

The Rust core resolves `hostId` itself (from `hosts.toml`, or a live
`~/.ssh/config` parse for `sshcfg:` ids) and builds the argv — argv never
crosses IPC. Imported rows connect via their **bare alias**, so system ssh
applies the user's real config (ProxyJump included); Setu rows get explicit
`-p`/`-i`/`user@hostname` flags, plus `-- <startup>` when set. First-connect
host-key prompts appear in the terminal itself. `"mosh"` arrives in Phase 7.

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

### `hosts_list`

List every known host: persisted `hosts.toml` records first, then rows
parsed live from `~/.ssh/config` (`source: "ssh_config"`, ids `sshcfg:<alias>`,
read-only until adopted). An imported alias is hidden once a persisted host
carries the same label — that's what `host_adopt` creates — so adopted rows
don't appear twice.

|            |                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Payload    | `{}`                                                                                                    |
| Result     | `Host[]` (snake_case fields; the full §4 schema)                                                        |
| Emits      | nothing                                                                                                 |
| Fails when | `hosts.toml` exists but can't be read or parsed. A missing/unreadable `~/.ssh/config` just adds no rows |

### `host_upsert`

Create (empty `id`) or update a host in `hosts.toml`. Validation failures —
empty label/hostname, port 0, hue > 7, an identity path that doesn't exist —
come back in the result as `errors`, addressed to editor fields; they are
expected outcomes, not command failures. Writes are atomic (temp file +
rename).

|            |                                                                                     |
| ---------- | ----------------------------------------------------------------------------------- |
| Payload    | `{ host: Host }`                                                                    |
| Result     | `{ host: Host }` on save · `{ errors: [{ field, message }] }` on validation failure |
| Emits      | nothing                                                                             |
| Fails when | the store can't be read or written, or a non-empty `id` matches no record           |

### `host_delete`

Delete a host from `hosts.toml`. Unknown ids are a no-op. Live sessions to
the host keep running — the frontend marks their tabs "(orphaned)" (F1).

|            |                                    |
| ---------- | ---------------------------------- |
| Payload    | `{ hostId: string }`               |
| Result     | `null`                             |
| Emits      | nothing                            |
| Fails when | the store can't be read or written |

### `host_adopt`

Copy an imported `~/.ssh/config` row into `hosts.toml` as an editable
`source: "setu"` record. The config file itself is never touched. An
alias-only row (no `HostName`) adopts with `hostname` set to the alias —
exactly what ssh would have resolved.

|            |                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{ hostId: string }` (an `sshcfg:` id)                                                                                                        |
| Result     | the new persisted `Host`                                                                                                                      |
| Emits      | nothing                                                                                                                                       |
| Fails when | the id isn't `sshcfg:`, the alias no longer exists in the config, the copy fails validation (e.g. missing `IdentityFile`), or the write fails |

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
