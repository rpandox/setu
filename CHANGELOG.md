# Changelog

All notable changes to Setu are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Every build phase adds at least
one entry.

## [Unreleased]

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
