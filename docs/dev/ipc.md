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

### `snippet_list`

List every snippet in `snippets.toml` (F6), in file order — which is also
drawer order. A missing file is an empty list.

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| Payload    | none                                                                                  |
| Result     | `Snippet[]` (`{ id, label, command, tags, variables[{ name, default?, choices? }] }`) |
| Emits      | nothing                                                                               |
| Fails when | `snippets.toml` exists but can't be read or parsed                                    |

### `snippet_upsert`

Create (empty `id`) or update a snippet. Validation: label and command
non-empty; every `{{token}}` in the command is declared in `variables` and
vice versa; variable names are `[A-Za-z_][A-Za-z0-9_]*` with no duplicates;
a `choices` list is non-empty; a `default` alongside `choices` must be one
of them. There is no `{{` escaping — a literal `{{` can't appear in a
snippet command (PLAN.md §5).

|            |                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{ snippet: Snippet }`                                                                                                                |
| Result     | `{ snippet }` on success · `{ errors: [{ field, message }] }` on validation failure                                                   |
| Emits      | nothing                                                                                                                               |
| Fails when | the store can't be read or written, or a non-empty `id` matches no record. Validation failures come back in the result, not as errors |

### `snippet_delete`

Delete a snippet. Unknown ids are a no-op (idempotent delete).

|            |                                    |
| ---------- | ---------------------------------- |
| Payload    | `{ snippetId: string }`            |
| Result     | `null`                             |
| Emits      | nothing                            |
| Fails when | the store can't be read or written |

### `snippet_import`

Import a snippet pack — TOML text in the same `[[snippet]]` shape as the
store file. The frontend owns the open dialog and passes the file's text.
Merging is by id: `"replace"` overwrites an existing record, `"keep"` skips
the incoming row; pack rows without an id always import under a fresh UUID.
The import is atomic — a pack with any invalid snippet imports nothing.

|            |                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payload    | `{ tomlText: string, mergeStrategy: "replace" \| "keep" }`                                                                                             |
| Result     | `{ imported: number, skipped: number }`                                                                                                                |
| Emits      | nothing                                                                                                                                                |
| Fails when | the pack can't be parsed, is empty, contains an invalid snippet (the message names it), the strategy is unknown, or the store can't be read or written |

### `snippet_export`

Export snippets as pack TOML, in store order. The frontend owns the save
dialog and writes the returned text where the user chose.

|            |                                                                |
| ---------- | -------------------------------------------------------------- |
| Payload    | `{ ids: string[] }` (unknown ids among valid ones are ignored) |
| Result     | `{ toml: string }`                                             |
| Emits      | nothing                                                        |
| Fails when | the store can't be read or parsed, or no id matches            |

### `reach_start`

Start (or refresh) the reachability prober behind the LED board (F1). The
first call spawns the sweep loop and probes immediately — a bare TCP
connect per host, staggered with jitter, at most `max_concurrent` in
flight, each bounded by `timeout_ms` — then re-sweeps every `interval_s`.
Later calls re-read `settings.toml` and trigger an immediate fresh sweep;
the frontend re-invokes after host CRUD so a new host lights up without
waiting a full interval. Knobs and defaults live in the `[reachability]`
table of `settings.toml` ([store.md](store.md)).

|            |                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{}`                                                                                                                  |
| Result     | `{ started: boolean }` — `false` means the global kill switch (`reachability.enabled = false`) is off; nothing probes |
| Emits      | `reach:update` per probed host, every sweep, until `reach_stop`                                                       |
| Fails when | `settings.toml` exists but can't be read or parsed                                                                    |

Hosts opt out individually with `reachability = false` in `hosts.toml`;
alias-only `~/.ssh/config` rows (no `HostName`) are never probed and their
LED stays hollow. Probes carry no auth and read no banners — see the
security model in [architecture.md](../architecture.md).

### `reach_stop`

Stop the prober. In-flight probes finish within their timeout; no further
`reach:update` events follow.

|            |                                            |
| ---------- | ------------------------------------------ |
| Payload    | `{}`                                       |
| Result     | `null`                                     |
| Emits      | nothing                                    |
| Fails when | never — stopping an idle prober is a no-op |

### `reach_set_visible`

Report app visibility, called on every `document.visibilitychange`. Once
the app has been hidden for more than 60 s, sweeping pauses; becoming
visible again after such a pause triggers an immediate sweep (F1
"pause-when-hidden"). Shorter hides don't disturb the probe rhythm.

|            |                                                          |
| ---------- | -------------------------------------------------------- |
| Payload    | `{ visible: boolean }`                                   |
| Result     | `null`                                                   |
| Emits      | nothing directly (the resume sweep emits `reach:update`) |
| Fails when | never                                                    |

### `ui_state_get`

Read the device-local UI state from `state.json` in the app-support
directory (`~/Library/Application Support/dev.pandox.setu/` — outside the
`~/.config/setu` sync unit, because it describes this machine's windows,
not your fleet). Phase 3 stores the sidebar collapse set, the broadcast
auto-disarm flag, the session-restore opt-in, and the saved tab/split
layout. See [store.md](store.md) for the schema.

|            |                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{}`                                                                                                                                           |
| Result     | the full `UiState` (camelCase, matches the file verbatim)                                                                                      |
| Emits      | nothing                                                                                                                                        |
| Fails when | the file exists but can't be read or parsed. The frontend then runs on defaults and disables persistence — a corrupt file is never overwritten |

A missing file is the default state; first launch needs no setup.

### `ui_state_set`

Replace `state.json` with the given document. The frontend debounces
layout and preference changes into whole-document writes; there is no
partial update. Writes are atomic (temp file + rename).

|            |                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Payload    | `{ state: UiState }`                                                                                |
| Result     | `null`                                                                                              |
| Emits      | nothing                                                                                             |
| Fails when | the existing file can't be read or parsed (corrupt files are never overwritten), or the write fails |

### `sftp_connect`

Open an SFTP session to a host (F5). This is the app's only in-protocol SSH
use — interactive terminals drive system `ssh` instead. Auth ladder: every
ssh-agent identity, then the host's identity file when one is configured
(passphrase-less; password auth arrives with the Keychain in Phase 7).

Host-key policy: a key matching `~/.ssh/known_hosts` connects silently; an
**unknown** key emits `hostkey:prompt` and parks this command until
`hostkey_trust` answers it; a **mismatched** or **revoked** key fails hard —
never a prompt. Trusting appends one line to `known_hosts` (the app's only
known_hosts write, append-only).

|            |                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payload    | `{ hostId: string }`                                                                                                                                                                                   |
| Result     | `{ sftpSessionId: string }` — keys every later `sftp_*` command                                                                                                                                        |
| Emits      | one `hostkey:prompt` when the key is unknown                                                                                                                                                           |
| Fails when | the host id is unknown, the record has no hostname (alias-only imports must be adopted first), the host is unreachable, the key is mismatched/revoked/declined, auth is exhausted, or sftp can't start |

### `hostkey_trust`

Answer a pending `hostkey:prompt` with the FingerprintDialog verdict.

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| Payload    | `{ hostId: string, accept: boolean }`                                                 |
| Result     | `null` (the parked `sftp_connect` resumes on `true`, fails on `false`)                |
| Emits      | nothing                                                                               |
| Fails when | no prompt is pending for the host (already resolved, or the connect died dialog-open) |

### `sftp_disconnect`

Close an SFTP session; its running transfers are cancelled first.

|            |                                                                  |
| ---------- | ---------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string }`                                      |
| Result     | `null`                                                           |
| Emits      | one terminal `sftp:progress:{transferId}` per cancelled transfer |
| Fails when | never — unknown ids are a no-op (idempotent close)               |

### `sftp_list` · `sftp_local_list`

List a directory — remote over the session, local via Rust `std::fs` — in
the one shared `SftpEntry` shape:

```ts
{ name, size, mtimeMs, mode, isDir, isSymlink, linkTarget? }
```

Symlink rows describe the **link** (`isDir: false`, `linkTarget` set);
following happens via the stat commands on double-click. The listing is
complete — the hidden-file toggle filters in the frontend.

|            |                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, path: string }` · local: `{ path: string }`                                |
| Result     | `{ entries: SftpEntry[] }` — name-sorted, `.`/`..` omitted                                           |
| Emits      | nothing                                                                                              |
| Fails when | the session is unknown (remote) or the directory can't be read — permission denied surfaces verbatim |

### `sftp_realpath`

Canonicalize a remote path (SFTP REALPATH) — how the panel turns the
post-connect `"."` into the absolute home path its path bar shows.

|            |                                              |
| ---------- | -------------------------------------------- |
| Payload    | `{ sftpSessionId: string, path: string }`    |
| Result     | `{ path: string }`                           |
| Emits      | nothing                                      |
| Fails when | the session is unknown or the server refuses |

### `sftp_stat` · `sftp_local_stat`

Stat one path, **following** symlinks — the explicit follow half of the F5
symlink behavior.

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, path: string }` · local: `{ path: string }` |
| Result     | one `SftpEntry`                                                       |
| Emits      | nothing                                                               |
| Fails when | the path doesn't resolve (broken links included)                      |

### `sftp_mkdir` · `sftp_local_mkdir`

Create a directory.

|            |                                                                       |
| ---------- | --------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, path: string }` · local: `{ path: string }` |
| Result     | `null`                                                                |
| Emits      | nothing                                                               |
| Fails when | the target exists or the server/OS refuses                            |

### `sftp_rename` · `sftp_local_rename`

Rename (move) a file or directory.

|            |                                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, from: string, to: string }` · local: `{ from, to }` |
| Result     | `null`                                                                        |
| Emits      | nothing                                                                       |
| Fails when | the server/OS refuses — many SFTP servers won't overwrite an existing target  |

### `sftp_delete` · `sftp_local_delete`

Delete a file, or a directory **recursively**. The remote walk happens
client-side (SFTP's RMDIR takes only empty directories) and never follows
symlinks — links are removed as links.

|            |                                                                                      |
| ---------- | ------------------------------------------------------------------------------------ |
| Payload    | `{ sftpSessionId: string, path: string, isDir: boolean }` · local: `{ path, isDir }` |
| Result     | `null`                                                                               |
| Emits      | nothing                                                                              |
| Fails when | the server/OS refuses — the remote walk stops at the first error                     |

### `sftp_chmod` · `sftp_local_chmod`

Set a path's permission bits (the chmod dialog works on both panes).

|            |                                                                                   |
| ---------- | --------------------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, path: string, mode: number }` · local: `{ path, mode }` |
| Result     | `null`                                                                            |
| Emits      | nothing                                                                           |
| Fails when | `mode` exceeds `0o7777` or the server/OS refuses                                  |

### `sftp_upload` · `sftp_download`

Start a transfer and return immediately; progress streams as events. The
backend moves single files, streaming in 256 KiB chunks (a 200 GB file
never sits in memory); the **queue** — concurrency 3, auto-retry ×1 on
retryable failures, folder expansion into per-file transfers — lives in the
frontend sftp store.

`transferId` is minted by the **frontend** (a UUID) and sent in the
payload, so the `sftp:progress:{transferId}` listener can be registered
_before_ the command flies. The other order loses: a small transfer can
finish in single-digit milliseconds, and a terminal event emitted before
the listener exists strands the queue row as running forever. The backend
rejects an empty or currently-in-flight id.

|            |                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload    | `{ sftpSessionId: string, localPath: string, remotePath: string, transferId: string }`                                                                  |
| Result     | `{ transferId: string }` (echo of the payload's)                                                                                                        |
| Emits      | throttled `sftp:progress:{transferId}` (`state: "running"`, ~10/s), then exactly one terminal event                                                     |
| Fails when | the session is unknown, the source can't be read/statted, it is a directory, or `transferId` is empty/in flight. Mid-transfer failures arrive as events |

### `sftp_cancel`

Cancel a running transfer. The partial destination file is removed
(best-effort) and the terminal `"cancelled"` event follows.

|            |                                                                                    |
| ---------- | ---------------------------------------------------------------------------------- |
| Payload    | `{ transferId: string }`                                                           |
| Result     | `null`                                                                             |
| Emits      | one terminal `sftp:progress:{transferId}`                                          |
| Fails when | never — unknown ids are a no-op, so cancelling can't race a transfer that finished |

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

### `reach:update`

One reachability probe finished (F1). Every host shares this one channel —
the payload carries the host id, and the reach store is the single consumer
(PLAN.md §5, Phase 4 row, for why this differs from the per-session `pty:*`
channels).

Payload: `{ hostId: string, state: "up" | "down", rttMs?: number }` —
`rttMs` is the TCP connect latency, present only for `"up"`. A host that
accepts the connect but would refuse an ssh login still reports `"up"`: the
LED shows reachability, not auth.

### `hostkey:prompt`

An SFTP connect met a host key that isn't in `~/.ssh/known_hosts` (F5). The
FingerprintDialog shows the fingerprint; the pending `sftp_connect` stays
parked until `hostkey_trust` delivers the verdict. One channel for all
hosts — the payload carries the host id. Mismatched or revoked keys never
prompt; they fail the connect directly.

Payload: `{ hostId: string, hostLabel: string, algorithm: string,
fingerprint: string }` — `fingerprint` is OpenSSH-format `SHA256:<base64>`,
exactly what `ssh-keygen -lf` prints.

### `sftp:progress:{transferId}`

Progress for one transfer. `"running"` events are throttled (~10/s);
exactly one terminal event — `"done"`, `"failed"`, or `"cancelled"` —
closes the channel. The store derives speed and ETA from successive
`bytes` readings.

Payload: `{ bytes: number, total: number, state: "running" | "done" |
"failed" | "cancelled", error?: string, retryable?: boolean }` — `total` is
`0` when the size is unknown; `error`/`retryable` appear on `"failed"`
only, and `retryable: true` (dropped connection, timeout) is what the
queue's auto-retry ×1 keys on.
