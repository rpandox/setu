# Changelog

All notable changes to Setu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every build phase adds at least
one entry.

## [Unreleased]

### Added — Phase 8: sync & settings

- Git sync (F10): `~/.config/setu` is now a git repo. The sidebar
  footer's status dot speaks five states (synced / ahead / behind /
  conflict / local); **Sync now** — footer, ⌘K palette, or Settings —
  commits `setu: <hostname> <ts>`, rebases, and pushes to a remote you
  own. No remote → local commits only. Auth rides your existing ssh
  keys/agent; every git call is prompt-free and capped at 30 s
  ([docs](docs/features/F10-sync-backup.md)).
- Secrets lint (F10): a sync refuses to stage anything when a config
  file matches secret heuristics — password/token/secret-key
  assignments, PEM private-key headers, 40+ char base64 runs (ssh
  _public_ keys allow-listed) — and shows each offending line with file
  and line number in the footer popover.
- Conflict handling (F10): a conflicted rebase is left in progress —
  never auto-resolved. The dot turns red; the popover lists the files,
  opens the dir in Finder, and offers **Cancel sync**
  (`git rebase --abort`).
- Snapshots (F10): scheduled tar.gz archives of the config dir into the
  app data folder (weekly, keep 10 — both configurable), plus a
  Snapshot now button. Restore = `tar -xzf`.
- Settings window (⌘,): a real second window with Terminal (font size +
  scrollback, **hot-applied to open terminals on save**), Sync,
  Snapshots, Tailnet, and Reachability sections (prober re-tunes live),
  plus the advanced track's feature flags — visible but disabled until
  their phases ship. `settings.toml` stays hand-editable; unknown
  tables from newer versions survive a save.
- Status bar: the `sync ✓ / ↑ / ↓ / ✕` chip is real (visible once a
  remote is configured), completing the §7 wireframe's sync slot.
- New pinned Rust deps: `regex`, `flate2`, `gethostname`, `time`.

### Added — Phase 7: keys, Keychain, mosh, Tailscale

- Keychain secrets (F8): SFTP passwords and key passphrases live in the
  macOS Keychain (service `dev.pandox.setu`) — never on disk, and never
  readable over IPC: the app can store/replace/delete/check an entry,
  but only the Rust core's SFTP auth ladder ever reads one. The host
  editor gains an "SFTP password" row; interactive terminals stay
  agent-first by design ([docs](docs/features/F08-keys-vault.md)).
- SFTP auth ladder (F8): agent → identity file (encrypted files unlock
  with their Keychain passphrase) → Keychain password. A missing or
  stale secret pauses the connect with a prompt dialog that stores and
  retries; pubkey-only servers never see a password prompt (the ladder
  reads the server's own method list). The live e2e suite covers the
  passphrase rung against a real sshd.
- Keys panel (F8): agent listing with fingerprints and hardware-key
  badges (absent agent → guidance banner), ed25519 generation whose
  optional passphrase is typed into ssh-keygen through a hidden PTY —
  never argv — and an ssh-copy-id helper that runs **visibly** in a new
  terminal tab. Opened from the ⌘K palette or the host editor.
- Vault export (F8): `~/.config/setu` as an age-encrypted `.tar.age`
  (`age -d | tar -x` restores anywhere). Secrets are excluded unless a
  second explicit toggle bundles the known Keychain entries inside the
  encrypted stream. New pinned Rust deps: `keyring`, `age`, `tar`.
- Mosh (F3): a per-host "Prefer mosh" toggle spawns system `mosh` — UDP
  roaming that survives Wi-Fi flips and sleep. Preflight everywhere: a
  missing binary (Homebrew paths are checked; GUI apps get a minimal
  `PATH`) is a plain toast and no session — never a silent ssh
  fallback ([docs](docs/features/F03-sessions.md)).
- Tailnet (F9): a sidebar section of live Tailscale peers — LEDs mirror
  Tailscale's own online state (no probes), offline peers dim with
  last-seen, `ts-ssh` badges mark key-free connects. One-click connect
  via MagicDNS + the `[tailnet] default_user` setting, "Adopt as host"
  promotes a peer into `hosts.toml`, "Ping to wake" warms the path, and
  peers rank in ⌘T quick-connect. Section hides without the binary
  ([docs](docs/features/F09-tailscale.md)).
- Custom form controls (§7): dropdowns, checkboxes, and radio buttons
  are now drawn by the app (`Checkbox`/`Radio`/`Select` in
  `src/components/controls.tsx`) — no native OS widget breaks the
  Phosphor chrome. The select is a keyboard-first ARIA combobox
  (arrows, Enter, Escape, type-ahead); checkbox and radio keep a real
  hidden input so labels and screen readers work unchanged.

### Added — Phase 6: snippets & port forwards

- Snippets (F6): command templates with `{{variable}}` prompts — free
  text with defaults, or fixed choices rendered as a select. Run to the
  current pane, the armed broadcast set, or a **new SSH tab per selected
  host** (three hosts, one action). CRUD lives in the ⌘J drawer — with
  one-click "Declare {{token}}" chips and inline validation — and every
  snippet is a frecency-ranked row in the ⌘K palette. Store:
  `~/.config/setu/snippets.toml` in the sync unit
  ([docs](docs/features/F06-snippets.md)).
- Snippet packs (F6): export all snippets to a TOML file, import a pack
  through native file dialogs (new `tauri-plugin-dialog` dependency; the
  picked paths cross IPC and the Rust core does the file I/O). Imports
  merge by id — keep or overwrite — and are atomic: one invalid snippet
  imports nothing.
- Port forwarding (F7): per-host `L`/`R`/`D` rules edited in the host
  editor, toggled from the status bar's new `⇌ N fwd` popover. Each
  toggle runs a managed `ssh -N` child in its own process group with
  `ExitOnForwardFailure` + `BatchMode`, so every failure is a fast exit
  with a visible reason; children die with the toggle and with the app —
  no orphans. Health dots: amber on start, green once the tunnel answers
  (or the remote bind survives), red with the reason on death. `auto`
  rules fire the moment their host's terminal connects; `D` rules show a
  copyable `socks5://` string ([docs](docs/features/F07-port-forwards.md)).
- Port-conflict helper (F7): starting a rule on an occupied local port
  names the owning process (`lsof`) and offers the next free port as a
  one-shot override — the saved rule is never rewritten.
- New IPC: the `snippet_*` family (list/upsert/delete/import/export),
  `forward_start`/`forward_stop`, and the `forward:update` event
  ([docs](docs/dev/ipc.md)).
- Live e2e: `cargo test --test live_forwards -- --ignored` walks the
  forwards acceptance list against a throwaway localhost sshd —
  tunnel-through-banner, toggle-off refusal, conflict helper, red on a
  doomed remote bind, and a no-orphans `ps` sweep after `kill_all`.
  `scripts/qa-forwards.sh` packages the manual GUI walk.

### Fixed — Phase 5 live-run findings

- Downloads (and any fast transfer) no longer hang as "running" forever:
  the transfer id is now minted by the frontend and the progress listener
  registered _before_ the command flies, so a transfer that finishes in
  milliseconds can't emit its terminal event into the void. The IPC
  payload for `sftp_upload`/`sftp_download` gained `transferId`
  ([docs](docs/dev/ipc.md)).
- Pane⇄pane drag now actually drops: the HTML5 drag-and-drop it used is
  swallowed by Tauri's native drag layer on macOS (which Finder→app
  drops require), so rows now drag with plain mouse events — press, move
  4 px, release over the other pane. A drag shows a count chip at the
  pointer, highlights the target pane, and Esc abandons it. Pressing an
  already-selected row keeps the selection through the drag (Finder
  semantics), so multi-selections drag intact.
- A dropped link that raced the stall guard ("session closed" from the
  sftp layer) now classifies retryable, so the queue's auto-retry covers
  it.
- Scrollbars everywhere are now drawn by the app (a quiet token-colored
  thumb), not the system default; the SFTP drop target got a clearer
  highlight.

### Added — Phase 5: SFTP

- The SFTP panel (F5): ⇧⌘S overlays a dual-pane file browser — local |
  remote — on the focused SSH session's host; the terminal keeps running
  underneath. Sortable columns (name/size/modified/mode), hidden-file
  toggle, breadcrumb path bar with Tab completion, virtualized listings
  (10k-entry directories scroll smoothly), and file ops on both panes:
  new folder, rename, recursive delete (confirmed), chmod (octal +
  checkboxes). Symlinks show their target and follow on double-click.
- Transfers: drag between panes (both directions, folders recurse), drop
  files from Finder to upload, double-click to send a file across. The
  queue runs three at once with live progress/speed/ETA; cancel removes
  the partial file; transient failures (dropped connection, timeout)
  auto-retry once, and a link that stalls a chunk for 30 s fails
  retryable instead of hanging the slot. Files stream in 256 KiB chunks —
  multi-GB transfers never sit in memory. The whole engine is exercised
  end-to-end against a real local OpenSSH server by an ignored-by-default
  integration suite (`cargo test --test live_sftp -- --ignored`).
- Host-key trust (F5): the app's only in-protocol SSH use verifies
  servers against `~/.ssh/known_hosts` (hashed entries included). Unknown
  keys show the fingerprint dialog and append on explicit trust — the
  only known_hosts write in the app; changed or revoked keys refuse to
  connect, never prompt. Auth is agent-first, then the host's identity
  file (passwords arrive with the Keychain in Phase 7).
- "Open in Cyberduck": hands the current remote directory to your
  `sftp://` handler as the escape hatch.
- New IPC: the `sftp_*` command family (connect/disconnect, list,
  realpath, stat, mkdir, rename, delete, chmod, local twins,
  upload/download/cancel), `hostkey_trust`, and the `hostkey:prompt` +
  `sftp:progress:{transferId}` events ([docs](docs/dev/ipc.md)).

### Added — Phase 4: design polish & the live board

- The live LED board (F1): a Rust reachability prober lights every host
  row the moment the app opens — bare TCP connects (no banners, no auth),
  staggered with jitter, at most 6 in flight, 1.5 s timeout, re-probed
  every 60 s. Green + glow = reachable (latency chip fades in), pulsing =
  live session, red = unreachable (last-seen on hover), hollow = probing
  or off. Probing pauses after the app is hidden > 60 s and sweeps
  immediately on refocus. Kill switches: per host
  (`reachability = false` in `hosts.toml`) and global
  (`[reachability] enabled = false` in the new, hand-editable
  `~/.config/setu/settings.toml`). New IPC: `reach_start`, `reach_stop`,
  `reach_set_visible`, and the `reach:update` event
  ([docs](docs/dev/ipc.md)).
- Command palette complete (F11): ⌘K lists every implemented keyboard
  action with its shortcut, above a Hosts section; ⌘T stays as the
  hosts-only quick connect. Host results carry live LEDs and inline
  actions — ⏎ connect (reuses a running tab), ⌘⏎ always a new tab, ⌘E
  edit, ⌘C copy ssh command. Ranking blends fuzzy match with frecency
  (recent, frequent hosts win near-ties; empty-query order is your
  most-used machines), persisted per machine in `state.json`.
- Full paste guard (F2): every pane now stops risky pastes at an
  editable exact-bytes preview with the reasons named — multi-line or
  trailing-newline pastes, command-position `sudo`, destructive `rm`,
  downloads piped into shells (`curl … | sh`), and raw-device writes
  (`dd of=/dev/…`, `mkfs`). Safe single-line pastes go straight through;
  broadcast pastes keep the "N sessions" warning.
- Bulk host actions (F1): ⌘-click / ⇧-click select sidebar rows; the
  selection bar sets group, adds a tag, sets hue, or deletes the lot
  (two-click confirm). Host notes render minimal markdown in a row
  popover (bold, italic, code, links, bullets).
- App icon: the LED bridge — an arch of phosphor LEDs over its
  reflection (source `assets/app-icon.svg`).
- Toasts now carry info/success/error variants; the status bar shows only
  real data (focused pane's host + live latency) instead of placeholder
  chips; FingerprintDialog ships (presentational) ahead of Phase 5's SFTP
  host-key flow.

### Added — Phase 3: splits, broadcast & session restore

- Split panes (F4): ⌘D/⇧⌘D split the focused pane right/down — SSH panes
  open a second session to the same host, local panes a fresh shell.
  Panes form a binary tree per tab: drag dividers to resize (240×120
  minimum), ⌥⌘-arrows move focus with a brief glow, and ⌘W now closes the
  focused _pane_, healing the layout around it (a tab's last pane closes
  the tab; the tab strip's × still closes everything).
- Broadcast (F4): ⇧⌘B arms typing into every selected pane in the tab —
  the cssh. Panes opt in/out via a badge (also mid-broadcast); armed panes
  carry a red hairline top border and the status bar counts the sessions.
  Multi-line pastes always stop at a preview dialog (exact text, editable,
  session count) before touching any session; dead panes are skipped with
  a toast; switching tabs disarms by default (`broadcastAutoDisarm`).
- Session restore (F4, opt-in `restoreOnLaunch`): relaunching reopens the
  saved tabs and split layouts — Setu-owned SSH panes reconnect, local
  panes open fresh shells, unreachable hosts open with the normal
  Reconnect notice instead of blocking launch.
- `state.json` (device-local UI state, PLAN.md §4) in the app-support
  directory: sidebar collapse (migrated automatically out of
  localStorage), the two F4 flags, and the saved layout. Atomic writes;
  a corrupt file is surfaced and never overwritten. New IPC pair
  `ui_state_get`/`ui_state_set` (see `docs/dev/ipc.md`).

### Added — Phase 2: hosts & SSH sessions

- Host management (F1): hosts persist in `~/.config/setu/hosts.toml` —
  human-diffable TOML, atomic writes, and a corrupt file is surfaced,
  never overwritten. The HostEditor drawer validates inline (label,
  hostname, port, identity path) and warns on duplicate `user@host:port`.
- `~/.ssh/config` import (F1): every concrete alias appears automatically
  in the sidebar's "ssh config" section, read-only; connecting uses the
  bare alias so ProxyJump/IdentityFile/Match/Include behave exactly as in
  your terminal. "Adopt" copies an alias into `hosts.toml` for editing.
- SSH sessions (F3): connect spawns system `ssh -tt` in a native PTY with
  keepalives (ServerAlive 30s×3); first-connect host-key prompts happen in
  the terminal; per-host `startup` commands run via `-- <cmd>`; tab titles
  seed from the host label and the active tab's underline takes the host's
  identity hue. Disconnects surface `connection closed (code N)` with a
  Reconnect button and plain-⏎ reconnect that keeps scrollback; tabs
  right-click for Duplicate tab / Reconnect all; deleting a host keeps its
  live sessions ("(orphaned)").
- ⌘T quick connect (F11): fuzzy search over every known host — typo
  tolerant, ranked label \> hostname \> tags \> user — ⏎ connects the top
  hit. The sidebar search uses the same ranking; groups collapse and
  favorites pin to the top.

### Fixed — Phase 1 review

- Tab strip now scrolls when tabs overflow (trackpad or mouse wheel), and
  the active tab scrolls into view on ⌘1–9/⌃Tab/click — previously
  overflowing tabs were crushed and unreachable.
- ⇧⌘F while the find bar is open refocuses it and selects the query
  instead of closing the bar; closing find clears the last match's
  selection so no reverse-video patch lingers in the scrollback.

### Added — Phase 1: local terminal MVP

- Local shell tabs (F2): ⌘N spawns `$SHELL` as a login shell in a native
  PTY; ⌘W closes (and always terminates the shell — no orphaned
  processes, including on app quit); ⌘1–9 and ⌃Tab switch tabs.
- xterm.js terminal with the "Setu Phosphor" ANSI theme derived from the
  design tokens; WebGL rendering with automatic fallback; Unicode 11
  widths (emoji and wide scripts measure correctly); 10 000-line
  scrollback; ⌘-click opens URLs.
- Find in terminal (⇧⌘F): incremental search, Enter/⇧Enter to step,
  Esc to close.
- Batched, backpressured output pipeline: 16 KB PTY reads, frame-coalesced
  writes with high/low watermarks — a `cat` of a 50 MB file streams
  without freezing the UI.
- Clean exits close their tab; failures keep it with the exit code shown.
- IPC contract v1: the `pty_*` command family and `pty:data`/`pty:exit`
  events (see `docs/dev/ipc.md`).

### Added — Phase 0: scaffold, shell & open-source spine

- Tauri 2 + React + TypeScript scaffold, restructured to the planned layout
  (`src/{app,components,features,ipc,state,styles}`, Rust modules
  `pty` / `store` / `ipc`).
- Phosphor design tokens (`src/styles/tokens.css`) — the single source of
  truth for every color, type, spacing, and motion value.
- Static app shell matching the design wireframe: LED sidebar (hollow LEDs),
  tab bar with overlay titlebar and inset traffic lights, terminal empty
  state, status bar. ⌘/ collapses the sidebar.
- Bundled OFL fonts: Inter, JetBrains Mono, Space Grotesk (variable).
- Empty-but-documented IPC contract triplet (`src/ipc/contract.ts`,
  `src-tauri/src/ipc.rs`, `docs/dev/ipc.md`).
- Open-source spine: Apache-2.0 license, contributing guide, security policy,
  code of conduct, third-party notices, issue/PR templates.
- CI: typecheck, ESLint with documentation rules, tests, clippy
  (`-D warnings`), `cargo test`, format checks, `cargo doc`, and the
  no-hardcoded-colors gate — all enforced from the first commit.
