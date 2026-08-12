# Changelog

All notable changes to Setu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every build phase adds at least
one entry.

## [Unreleased]

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
