# Store

How Setu persists hosts (and later snippets, runbooks, and settings) as
plain TOML in `~/.config/setu/`, and why that directory is the sync unit.

## The sync unit

```
~/.config/setu/
  hosts.toml          # Phase 2 — this page
  snippets.toml       # Phase 6
  runbooks.toml       # Phase 12
  settings.toml       # Phase 8
```

Plain TOML because it is human-diffable, git-syncable, and
chezmoi-friendly ([PLAN.md](../../PLAN.md) §5). The schema deliberately
has no secret fields: passwords and passphrases go to the macOS Keychain,
never to disk. Full schemas live in [PLAN.md](../../PLAN.md) §4.

Implementation: [`src-tauri/src/store.rs`](../../src-tauri/src/store.rs)
(`HostsStore`), exposed over IPC by the `hosts_*` commands
([ipc.md](ipc.md)).

## hosts.toml

An array of `[[host]]` tables — the full §4 field set. A minimal record:

```toml
[[host]]
id = "9f2c…"                    # uuid, assigned on create — don't invent
label = "hermes"
hostname = "hermes.tailnet-name.ts.net"
user = "pandox"
port = 22
identity = "agent"              # "agent" | path to a private key
startup = "tmux new -A -s main" # optional; "" = none
favorite = true
source = "setu"                 # only "setu" rows live in this file
```

Fields owned by later phases (`use_mosh`, `control_master`, `forwards`,
`health`, `reachability`) are stored and round-tripped from Phase 2 so a
file written today keeps working as features land.

Rows parsed from `~/.ssh/config` (`source = "ssh_config"`) are **never**
written here — they're re-parsed live on every listing. "Adopt" copies one
into this file with a fresh uuid and `source = "setu"`.

## Write discipline

Two safety properties hold for every save:

1. **Atomic writes.** The file is serialized to a temp file in the same
   directory, then `rename`d over `hosts.toml`. A crash mid-save can never
   leave a half-written host list.
2. **A corrupt file is never overwritten.** If `hosts.toml` fails to
   parse, every store operation returns the parse error (the sidebar
   surfaces it) and nothing writes until the file is fixed by hand.

Validation runs before any write: label/hostname required, port 1–65535,
hue 0–7, and `identity` must be `"agent"` or an existing path (`~`
expands). Failures come back as per-field errors — see
[`host_upsert` in ipc.md](ipc.md#host_upsert).

## Canonical formatting (a caveat)

Saves rewrite the whole file in canonical formatting. Hand-edits to
_values_ survive round-trips; **comments and custom ordering do not**.
The file starts with a header saying exactly that. If comment preservation
ever matters more than simplicity, the escape hatch is swapping `toml`
for `toml_edit` in `store.rs` — the API surface is contained in
`save_atomic`.

Hand-editing is otherwise fully supported: unknown fields are tolerated
on load (and dropped on the next save), missing fields take their
defaults, and the file may simply not exist yet — that's an empty list,
not an error.
