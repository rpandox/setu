# F3 · Sessions & connection lifecycle

Connections that feel instant and never leave zombies. Phase 2 ships the
SSH spawn pipeline and the disconnect story: keepalives, exit codes in the
pane, one-key reconnect. (ControlMaster instant second-tabs are Phase 11.)

## What is it?

Connecting to a host spawns the **system `ssh`** in a native PTY — Setu
never reimplements the protocol, so your agent, config, jump hosts,
`known_hosts`, and Tailscale SSH work untouched. First-connect host-key
prompts appear right in the terminal, exactly like they always have.

Every session runs with keepalives
(`ServerAliveInterval=30`, `ServerAliveCountMax=3`), so a dead link is
noticed within ~90 seconds instead of hanging forever.

## How do I use it?

| Keys | Action                                        |
| ---- | --------------------------------------------- |
| ⌘T   | Quick connect to a host                       |
| ⏎    | Reconnect, when the active SSH tab has exited |
| ⌘W   | Close the tab (always terminates the process) |

- **Tab identity:** tabs start as the host's label and follow the remote
  shell's title escapes; the active tab's underline takes the host's hue.
- **Startup command:** set `startup = "tmux new -A -s main"` on a host and
  every connect runs it (appended after `--`), landing you in tmux.
- **Disconnects:** a non-zero exit (dropped Wi-Fi, killed sshd, rejected
  auth) keeps the tab with a `connection closed (code N)` notice, a
  **Reconnect** button, and plain ⏎ as the shortcut. Reconnecting reuses
  the same terminal — scrollback survives.
- **Right-click a tab** for Duplicate tab (second session to the same
  host), Reconnect, Reconnect all, and Close.
- **Clean exits** (typing `exit`, code 0) close the tab, same as local
  shells.
- **Quitting Setu kills every child process** — ssh included. No orphans,
  verified by `ps` in the acceptance checklist.

## What can go wrong?

- **"unknown host" on connect.** The host was deleted (or its
  `~/.ssh/config` alias removed) after the sidebar loaded. The list
  refreshes on every change Setu makes; re-open ⌘T and it's gone.
- **The reconnect prompt loops on auth failures.** Reconnect re-runs the
  same `ssh` argv — if the server rejects your key, reconnecting won't
  change that. Read the error in the scrollback (it's kept for exactly
  this reason).
- **Exit code 255.** That's ssh's own "connection failed" code — network
  unreachable, timeout, refused. Codes below 255 come from the remote
  command itself.
- **An orphaned tab can't reconnect.** Its host record is gone, so there's
  nothing to rebuild the command from. The session keeps running; when it
  ends, close the tab.
