# Setu

> **setu** (Sanskrit: सेतु, "bridge") — the thing you cross to reach the other machine.

A beautiful, open-source SSH command center for macOS, where any machine is one
keystroke away. No account, no cloud, no subscription: secrets stay in the macOS
Keychain, config lives in plain files you own, and interactive sessions drive the
system `ssh` — so your `~/.ssh/config`, agent, jump hosts, and Tailscale keep
working exactly as they do today.

![Setu's main window: the LED board sidebar with live host status, a terminal
pane, and the status bar](docs/assets/hero.png)

**Status: v1.0.0.** The core track of the [build plan](PLAN.md) — Phases 0–9,
full Termius-class parity — is complete. The advanced track (semantic terminal,
instant ControlMaster connections, fleet health, output triggers, runbooks,
automation, AI assist, themes) ships next, behind default-off flags.

## Install

### Homebrew

```sh
brew install --cask rpandox/tap/setu
```

### Direct download

Grab `Setu_<version>_universal.dmg` from
[GitHub Releases](https://github.com/rpandox/setu/releases) and drag Setu to
Applications.

### First launch (unsigned build)

Setu ships unsigned — notarization needs a paid Apple Developer Program
membership this project doesn't have — so Gatekeeper quarantines the first
launch. Any one of these clears it:

- Install with quarantine off in the first place:

  ```sh
  brew install --cask --no-quarantine rpandox/tap/setu
  ```

- Right-click `Setu.app` → **Open** → **Open** (once; macOS remembers), or:

  ```sh
  xattr -dr com.apple.quarantine /Applications/Setu.app
  ```

## What's inside

| Feature                                                     | Keys           | In short                                                                                                          |
| ----------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Hosts & the LED board](docs/features/F01-hosts.md)         | ⌘T             | Every host is a live LED — green means reachable _right now_; fuzzy quick-connect, `~/.ssh/config` import         |
| [Terminal](docs/features/F02-terminal-core.md)              | ⇧⌘F · ⌘+/−     | xterm.js on WebGL, a paste guard that previews multi-line and dangerous pastes byte-for-byte                      |
| [Sessions](docs/features/F03-sessions.md)                   | ⏎ to reconnect | The system `ssh` in a PTY — your config, agent, ProxyJump, and known_hosts just work; per-host mosh               |
| [Splits & broadcast](docs/features/F04-splits-broadcast.md) | ⌘D · ⇧⌘D · ⇧⌘B | Pane grids with drag borders; type once, land in every armed session                                              |
| [SFTP](docs/features/F05-sftp.md)                           | ⇧⌘S            | Dual-pane browser over any session — drag-drop both ways, transfer queue, chmod, host-key trust                   |
| [Snippets](docs/features/F06-snippets.md)                   | ⌘J             | Command templates whose `{{variables}}` prompt at run; current pane, broadcast, or a tab per host; TOML packs     |
| [Port forwards](docs/features/F07-port-forwards.md)         | status bar     | `L`/`R`/`D` tunnels as toggles — health dots, auto-start, a port-conflict helper that names the owner             |
| [Keys & vault](docs/features/F08-keys-vault.md)             | —              | Keychain-backed SFTP secrets, ed25519 generation, a visible ssh-copy-id, age-encrypted config export              |
| [Tailscale](docs/features/F09-tailscale.md)                 | —              | Live tailnet peers in the sidebar with Tailscale's own online state; one-click connect, adopt-as-host             |
| [Sync & backup](docs/features/F10-sync-backup.md)           | ⌘,             | `~/.config/setu` as a git repo you push anywhere; a secrets lint that refuses credential-looking lines; snapshots |
| [Command palette](docs/features/F11-command-palette.md)     | ⌘K             | Every action two keystrokes away, frecency-ranked                                                                 |

## Why

- **One keystroke to anywhere.** ⌘T, three letters, Enter → shell prompt.
- **The board tells the truth.** Every host is a live LED — green means
  reachable _right now_.
- **Keyboard-first.** Every action reachable from the ⌘K palette.
- **Nothing leaves the Mac.** No telemetry, no accounts, local-only history.
- **Respect the system.** Reuses `~/.ssh/config`, the ssh-agent, `known_hosts`,
  and Tailscale — never fights them.

## Build from source

Prerequisites:

- macOS 12+
- [Rust](https://rustup.rs/) (stable) — make sure `~/.cargo/bin` is on your `PATH`
- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/) 9+
- Xcode Command Line Tools (`xcode-select --install`)

```sh
git clone https://github.com/rpandox/setu.git
cd setu
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` compiles the Rust core and opens the app window with hot
reload for the frontend. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
development workflow and quality gates, and [RELEASING.md](RELEASING.md) for
how release builds are produced.

## Documentation

- [docs/architecture.md](docs/architecture.md) — process model, IPC philosophy,
  security model
- [docs/dev/](docs/dev/) — developer references (IPC contract, store, PTY,
  releasing)
- [docs/features/](docs/features/) — one page per feature as it ships
- [CHANGELOG.md](CHANGELOG.md) — what changed, phase by phase
- [RELEASING.md](RELEASING.md) — build, package, and publish a release

## Security

Setu's security model (what touches your keys, what never leaves the machine)
is summarized in [SECURITY.md](SECURITY.md), including how to report a
vulnerability.

## License

[Apache-2.0](LICENSE). Bundled fonts are OFL-1.1 — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
