# Architecture

This is the living mirror of [PLAN.md](../PLAN.md) §3 — updated whenever the
real architecture moves.

**Stack:** Tauri 2 (Rust backend) · React 18+ + TypeScript + Vite · xterm.js ·
Zustand · rusqlite.

## Process model

```
┌─────────────────────────────── Setu.app ───────────────────────────────┐
│  WebView (React + xterm.js)             Rust core (tauri)              │
│  ─ LED sidebar / tabs / palette          ─ PTY manager (portable-pty)  │
│  ─ terminal renderer (WebGL)             ─ spawns system ssh/mosh/$SHELL
│  ─ OSC 133/7/52 handlers (semantic)  IPC ─ SFTP client (russh+russh-sftp)
│  ─ broadcast fan-out / triggers     ◄──► ─ reachability prober (TCP)   │
│  ─ SFTP browser / runbook runner         ─ Keychain (keyring crate)    │
│  ─ health sparklines / AI panel          ─ store: toml · history: rusqlite
│                                          ─ metrics probe · edit-watch · deploy-watch
│                                          ─ shell-outs: tailscale · git · claude
│                                          ─ unix socket for companion CLI · deep links
└────────────────────────────────────────────────────────────────────────┘
```

## The core trick — interactive sessions drive the system `ssh`

Setu does not implement the SSH protocol for terminals. The PTY manager runs
`ssh -tt <alias-or-args>` (or `mosh`, or `$SHELL` for local tabs) inside a
portable-pty. That inherits, for free: `~/.ssh/config` (ProxyJump,
ControlMaster, ForwardAgent…), the ssh-agent and Secure-Enclave agents,
`known_hosts` prompts (they appear in the terminal, which is the correct UX),
hardware keys (`ed25519-sk`), and Tailscale SSH. The app's job is a
world-class cockpit, not a protocol stack.

The **only** in-app protocol use is SFTP (russh + russh-sftp), because a file
browser needs structured directory data.

## Reachability

The prober gives the sidebar its green LEDs: on app open (and every
`interval_s` after), each visible host gets a **plain TCP connect** to its
configured port with a short timeout — unprivileged (unlike ICMP ping), and it
tests the actual sshd, not just the network path. Probes are staggered with
jitter, never carry auth, pause when the app is hidden, and feed both the LED
state and the latency chip. Tailnet peers reuse Tailscale's own online state
instead of probing.

## Semantic layer

Shell integration (F12) emits OSC 133 (command start/end/exit), OSC 7 (cwd),
and optionally OSC 52 (clipboard). xterm.js parses these in the WebView; the
frontend derives marks, durations, notifications, and writes command records
to the history DB via IPC. No protocol changes, no server agents.

## IPC contract

The source of truth is [`src/ipc/contract.ts`](../src/ipc/contract.ts),
mirrored by [`src-tauri/src/ipc.rs`](../src-tauri/src/ipc.rs) and documented
in [docs/dev/ipc.md](dev/ipc.md). The three change in the same commit or not
at all. As of Phase 0 the contract is intentionally empty.

## Security model

- Secrets (passwords, passphrases) live **only** in the macOS Keychain,
  service `dev.pandox.setu`.
- `hosts.toml` and friends are plaintext and safe to git-sync — the schema
  forbids secret fields.
- The history DB, recordings, and state are local-only and excluded from sync
  by design.
- Reachability probes are bare TCP connects: no banners read, no auth
  attempted, rate-limited, and disable-able globally and per host.
- PTY contents and secrets are never logged; command args are redacted in
  diagnostics.
- `~/.ssh/*` is read-only; only `known_hosts` may be appended, on explicit
  trust. Shell-integration installs (local or remote rc files) always show
  the exact diff and require explicit confirmation.
- AI assist sends only text you explicitly invoke it on, shells out to your
  local `claude` CLI, and never auto-executes a suggested command.

See [SECURITY.md](../SECURITY.md) for the reporting path.

## File locations

```
~/.config/setu/                      # the sync unit (git repo, Phase 8)
  hosts.toml  snippets.toml  runbooks.toml  settings.toml
  themes/
~/Library/Application Support/dev.pandox.setu/
  state.json  history.sqlite  recordings/  logs/
Keychain service: dev.pandox.setu
```
