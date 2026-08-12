# Setu

> **setu** (Sanskrit: सेतु, "bridge") — the thing you cross to reach the other machine.

A beautiful, open-source SSH command center for macOS, where any machine is one
keystroke away. No account, no cloud, no subscription: secrets stay in the macOS
Keychain, config lives in plain files you own, and interactive sessions drive the
system `ssh` — so your `~/.ssh/config`, agent, jump hosts, and Tailscale keep
working exactly as they do today.

**Status: pre-alpha, under active construction.** Phases 0–1 of the
[build plan](PLAN.md) are complete: the app shell and design system, and a
working local terminal — ⌘N opens your login shell in a native PTY with
full-screen app support, Unicode-correct rendering, and tabs
([docs](docs/features/F02-terminal-core.md)). SSH hosts land in Phase 2.

<!-- Hero screenshot lands with Phase 4 (design polish). -->

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
broadcast input · SFTP with drag-drop · snippets and runbooks · port-forward
toggles · Keychain-backed secrets · git-based config sync · semantic terminal
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
