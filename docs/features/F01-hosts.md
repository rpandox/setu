# F1 · Host management

Every machine you touch, one keystroke away. Phase 2 ships the host store
and its UI: hosts live in a plain TOML file you own, your existing
`~/.ssh/config` aliases appear automatically, and the sidebar searches all
of it fuzzily. (The live reachability LEDs land in Phase 4 — until then
every LED is a hollow ring.)

![The Add host drawer with label, hostname, user, identity, hue, and startup command fields](../assets/f01-hosteditor.png)

## What is it?

The sidebar is the patch bay: Favorites on top, then your groups, then
ungrouped hosts, then an **ssh config** section listing every concrete
alias from `~/.ssh/config`. Add and edit hosts in a drawer with inline
validation; everything persists to `~/.config/setu/hosts.toml` — a
human-diffable file that's safe to git-sync because it never holds secrets.

## How do I use it?

| Keys | Action                                   |
| ---- | ---------------------------------------- |
| ⌘T   | Quick connect (fuzzy search, ⏎ connects) |
| ⌘/   | Toggle the sidebar                       |

- **Add a host:** the `+` button beside the search field. Label and
  hostname are required; port must be 1–65535; identity is `agent` (your
  ssh-agent) or a path to a key. A duplicate `user@host:port` warns but
  never blocks.
- **Connect:** click a row (or ⌘T → type → ⏎). Each host row's tooltip
  shows the exact ssh command it will run.
- **Edit / Delete:** hover a row. Delete asks for a second click within
  3 seconds. Deleting a host with live sessions keeps those sessions
  running — their tabs mark "(orphaned)".
- **Copy ssh command** (hover): puts `ssh -p 2222 user@host` (or the bare
  alias) on the clipboard.
- **Groups** collapse and stay collapsed across restarts. The `group`
  field in the editor decides the section.
- **Hue:** each host picks one of 8 identity colors — it underlines the
  host's tabs so you always know where a terminal points.
- **Import from `~/.ssh/config`:** automatic. Every concrete `Host` alias
  (wildcards like `Host *` are skipped) shows in the **ssh config**
  section, read-only, parsed live from the file. Connecting uses the bare
  alias, so ProxyJump, IdentityFile, Match blocks, and Include files all
  behave exactly as they do in your terminal.
- **Adopt** (hover an imported row): copies the alias into `hosts.toml`
  as an editable Setu host. The config file itself is never touched.

Config file: `~/.config/setu/hosts.toml` — schema in
[PLAN.md](../../PLAN.md) §4, format details in
[docs/dev/store.md](../dev/store.md).

## What can go wrong?

- **`hosts.toml` won't parse.** The sidebar shows the parse error and Setu
  refuses to write to the file until you fix it — a corrupt file is never
  overwritten. Fix the TOML by hand; the error message names the line.
- **Comments in `hosts.toml` disappear.** Setu rewrites the file in
  canonical form on every save. Keep notes in each host's `notes` field
  instead (or in git history if you sync the directory).
- **An adopted host stops jumping through its bastion.** Adoption copies
  hostname/user/port/identity, and Setu then connects with explicit flags
  rather than the alias — ssh options tied to the _alias pattern_ (like
  `ProxyJump` under `Host jump-*`) no longer match. Keep such hosts
  un-adopted; the alias is already a first-class row.
- **Adopt fails with "identity file not found".** The config block names
  an `IdentityFile` that doesn't exist on disk; fix the path in
  `~/.ssh/config` (or create the key) and adopt again.
- **An imported alias vanished from the ssh config section.** A persisted
  host with the same label hides it (that's what Adopt creates). Rename or
  delete the Setu host to see the raw alias again.
