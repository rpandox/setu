# Setu

> **setu** (Sanskrit: सेतु, "bridge") — the thing you cross to reach the other machine.

A beautiful, open-source SSH command center for macOS, where any machine is one
keystroke away. No account, no cloud, no subscription: secrets stay in the macOS
Keychain, config lives in plain files you own, and interactive sessions drive the
system `ssh` — so your `~/.ssh/config`, agent, jump hosts, and Tailscale keep
working exactly as they do today.

**Status: pre-alpha, under active construction.** Phases 0–5 of the
[build plan](PLAN.md) are complete: the app shell and design system, a
working local terminal ([docs](docs/features/F02-terminal-core.md)),
hosts & SSH — a `hosts.toml` store with an editor drawer, automatic
`~/.ssh/config` import with an Adopt flow
([docs](docs/features/F01-hosts.md)), sessions that spawn the system
`ssh` with keepalives, in-terminal host-key prompts, and one-key
reconnect ([docs](docs/features/F03-sessions.md)) — split panes,
broadcast input, and opt-in session restore
([docs](docs/features/F04-splits-broadcast.md)) — the live LED
board: every host probed the moment the app opens, green when it
answers right now ([docs](docs/features/F01-hosts.md)), a full ⌘K
command palette with frecency ranking
([docs](docs/features/F11-command-palette.md)), a paste guard that
stops multi-line and dangerous pastes at an exact-bytes preview
([docs](docs/features/F02-terminal-core.md)) — and now **SFTP**: ⇧⌘S
opens a dual-pane file browser over any SSH session — drag-drop both
ways, a three-at-a-time transfer queue with cancel and auto-retry,
chmod, and a fingerprint dialog for first-connect host keys
([docs](docs/features/F05-sftp.md)).

<!-- Hero screenshot: docs/assets/hero.png (captured during Phase 4 live QA). -->

## Why

- **One keystroke to anywhere.** ⌘T, three letters, Enter → shell prompt.
- **The board tells the truth.** Every host is a live LED — green means
  reachable _right now_.
- **Keyboard-first.** Every action reachable from the ⌘K palette.
- **Nothing leaves the Mac.** No telemetry, no accounts, local-only history.
- **Respect the system.** Reuses `~/.ssh/config`, the ssh-agent, `known_hosts`,
  and Tailscale — never fights them.

## Planned features

The full feature-by-feature specification lives in [PLAN.md](PLAN.md) §9.
Highlights: host management with live reachability LEDs · tabs, splits, and
broadcast input · snippets and runbooks · port-forward toggles ·
Keychain-backed secrets · git-based config sync · semantic terminal
(prompt jumps, done-notifications, global command history) · instant second
connections via ControlMaster · fleet health sparklines · a companion CLI.

## Build from source

Prerequisites:

- macOS 12+
- [Rust](https://rustup.rs/) (stable) — make sure `~/.cargo/bin` is on your `PATH`
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/) 9+
- Xcode Command Line Tools (`xcode-select --install`)

```sh
git clone <repository-url> setu
cd setu
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` compiles the Rust core and opens the app window with hot
reload for the frontend. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
development workflow and quality gates.

## Documentation

- [docs/architecture.md](docs/architecture.md) — process model, IPC philosophy,
  security model
- [docs/dev/](docs/dev/) — developer references (IPC contract, store, PTY,
  releasing)
- [docs/features/](docs/features/) — one page per feature as it ships
- [CHANGELOG.md](CHANGELOG.md) — what changed, phase by phase

## Security

Setu's security model (what touches your keys, what never leaves the machine)
is summarized in [SECURITY.md](SECURITY.md), including how to report a
vulnerability.

## License

[Apache-2.0](LICENSE). Bundled fonts are OFL-1.1 — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
