# Feature docs

One page per feature, named `F##-<slug>.md` after its [PLAN.md](../../PLAN.md)
§9 specification (e.g. `F01-hosts.md`, `F12-semantic-terminal.md`).

Each page is created **in the phase that ships the feature** and kept current
by the Documentation Gate (§6.4): a feature's page must be updated in the same
phase that touches the feature. Pages answer, in order:

1. What is it?
2. How do I use it? (keyboard shortcuts and config keys shown, not described)
3. What can go wrong?

Pages so far:

- [F01 · Host management](F01-hosts.md) — hosts.toml, sidebar, ssh_config import (Phase 2)
- [F02 · Terminal core](F02-terminal-core.md) — local shell tabs (Phase 1)
- [F03 · Sessions & connection lifecycle](F03-sessions.md) — ssh spawning, reconnect (Phase 2)
- [F04 · Splits, broadcast & session restore](F04-splits-broadcast.md) — panes, cssh, restore (Phase 3)
- [F05 · SFTP & files](F05-sftp.md) — dual-pane browser, transfers, host-key trust (Phase 5)
- [F11 · Command palette & quick connect](F11-command-palette.md) — ⌘T (Phase 2)
