# Security policy

## Supported versions

Setu is pre-1.0; only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately via
**GitHub Security Advisories** ("Report a vulnerability" on the repository's
Security tab), or by email to **rpandox@gmail.com** if you can't use GitHub.
You'll get an acknowledgment within a few days. Please don't open public
issues for security reports.

## Security model (summary)

The full model lives in [PLAN.md](PLAN.md) §3 and
[docs/architecture.md](docs/architecture.md). The load-bearing rules:

- **Interactive SSH is the system `ssh`.** Setu spawns `ssh` in a PTY instead
  of implementing the protocol, so authentication, host-key verification, jump
  hosts, and hardware keys are handled by OpenSSH — the app never touches key
  material for interactive sessions. The only in-app protocol use is SFTP.
- **Secrets live only in the macOS Keychain** (service `dev.pandox.setu`).
  Config files (`hosts.toml` etc.) are plaintext by design and their schema
  forbids secret fields, so they are safe to sync via git.
- **Command history, recordings, and state never sync** and never leave the
  machine. PTY/session contents are never logged.
- **Reachability probes are bare TCP connects**: no banners read, no auth
  attempted, rate-limited and jittered, with global and per-host kill
  switches.
- **File access is minimal:** `~/.ssh/*` is read-only; `known_hosts` may be
  appended only on explicit user trust. Any rc-file install (shell
  integration, local or remote) shows the exact diff first, requires explicit
  confirmation, and is fenced and reversible.
- **AI assist** (optional, via your local `claude` CLI) sends only text you
  explicitly select, redacts secret-shaped strings first, and can never
  execute a suggested command — insert-only, you press Enter.
- **No telemetry, no accounts, no network calls** beyond the connections you
  ask for.
