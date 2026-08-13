# Changelog

All notable changes to Setu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every build phase adds at least
one entry.

## [Unreleased]

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
