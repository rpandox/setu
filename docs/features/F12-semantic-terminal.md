# F12 · Semantic terminal — shell integration

The terminal knows where commands begin, end, and fail. Phase 10 ships the
first advanced-track feature behind a flag: a small snippet in your shell's
rc file emits prompt marks, and Setu turns them into gutter marks, prompt
jumps, copy-last-output, re-run, a live cwd chip, done-notifications, and a
searchable command history.

_Screenshot pending: the live walk found the gutter marks not yet rendering
in the release build (see PLAN.md §5, "Live walk record"), so no frame has
been landed for this page yet._

## What is it?

Shell integration is a protocol, not a plugin: your shell prints a few
invisible escape sequences around every prompt and command — `OSC 133`
(prompt start, command start, output start, command end + exit code),
`OSC 7` (working directory), and `OSC 633;E` (the command text). Setu's
terminal parses them and derives everything else locally. No server agent,
no protocol changes, and it works the same over `ssh` to an Ubuntu box as
it does in a local zsh.

Everything here is **off until you flip the flag** — Settings → Flags →
_Semantic terminal_ — and **hidden until the shell speaks**: a tab without
the snippet shows none of it, and nothing errors.

## How do I use it?

**1. Turn it on.** ⌘, → Flags → check _Semantic terminal_. Applies to open
terminals immediately.

**2. Install the snippet.** ⌘K → _Shell integration…_ (or click the `⌂
integrate shell` chip in the status bar). The dialog detects your shell,
shows the **exact diff** it will make to your rc file, and writes nothing
until you press _Install — write this diff_. The change is a fenced block:

```
# >>> setu shell integration >>>
…
# <<< setu shell integration <<<
```

Open a new shell (or `exec $SHELL`) and the marks start. The same dialog
offers _Remove the block_ once installed; removal takes out exactly the
fenced block.

For a **remote host**, run _Shell integration…_ from a tab connected to it
(or click its cwd chip). The installer reads the remote rc over SFTP — the
same connection and auth ladder as the file browser
([F05](F05-sftp.md)), so you may see the host-key or password prompt — picks
the shell from which rc files exist (pick bash for Ubuntu if it guessed
wrong), shows the diff, and writes on confirm. Uninstall works the same
way.

| Keys | Action                                                            |
| ---- | ----------------------------------------------------------------- |
| ⌘↑   | Jump to the previous prompt                                       |
| ⌘↓   | Jump to the next prompt                                           |
| ⇧⌘C  | Copy exactly the last command's output                            |
| ⌥⌘R  | Re-run the last command (writes it + Enter to the pane)           |
| ⌘K   | _Shell integration…_ · History section (⏎ pastes, **never** runs) |
| ⌘,   | Flags → Semantic terminal · Terminal → history + OSC 52 toggles   |

**Gutter marks.** A 3 px bar in the left gutter per command — green for
exit 0, red otherwise, amber while running. Hover for the command, its
duration, and exit status.

**Status bar cwd chip.** The focused pane's working directory from
`OSC 7`, shortened (`~/src/setu`). Click it for the installer. In the SFTP
panel, _Follow cwd_ makes the remote pane track that directory as you
`cd` in the terminal on the same host.

**Done-notifications.** A command that runs 30 s or longer and finishes
while its tab isn't in front (another tab, or the app unfocused) fires one
macOS notification: ✓/✕, the command, duration, exit status, host, and
the tab number so you're one ⌘-number away. Clicking activates Setu. The
first notification asks for permission.

**History.** Every completed command is recorded — time, host, cwd,
command, exit, duration — to `history.sqlite` in the app-support folder.
⌘K shows a History section: every word you type must match the command,
host, or cwd; newest first; ⏎ pastes the command into the focused pane
without running it. Two privacy switches:

- **Incognito** per host — HostEditor → _Incognito_. Nothing from that
  host is ever written, whatever the global toggle says.
- **Record command history** globally — Settings → Terminal. The same
  section shows the row count + path and a _Clear history_ button.

Commands that used the alternate screen (`vim`, `less`, `htop`, `tmux`)
are never recorded. The database is local-only: it lives outside the
synced config folder and never rides along with sync or the vault
export ([store.md](../dev/store.md#historysqlite-device-local-never-synced-never-exported)).

**OSC 52 clipboard.** Off by default. Settings → Terminal → _Allow OSC 52
clipboard writes_ lets a remote program (`tmux`, `nvim`) put text on this
Mac's clipboard through the terminal.

Config keys (`settings.toml`):

```toml
[flags]
semantic_terminal = true   # default false

[terminal]
osc52_clipboard = false    # default false

[history]
enabled = true             # default true
```

`hosts.toml`: `incognito = true` per host (default `false`).

## What can go wrong?

- **Nothing appears after installing.** The snippet activates in _new_
  shells — run `exec $SHELL` or open a new tab. On macOS, bash reads
  `~/.bashrc` only from `~/.bash_profile`; zsh and fish need nothing.
- **The remote install says it can't detect the shell.** SFTP can't run
  `$SHELL`, so detection is by rc presence; pick the shell from the list
  (the rc file is created if missing).
- **Host-key or password prompts during a remote install.** The
  installer uses the SFTP connection; trust the key or store the secret
  exactly as the file browser would ask ([F05](F05-sftp.md),
  [F08](F08-keys-vault.md)).
- **Marks look doubled inside tmux.** Inner shells each emit marks; Setu
  dedupes by sequence (a repeated prompt mark replaces the last), so one
  prompt = one mark. Commands inside tmux never reach history (alt
  screen).
- **⌘↑ / ⌘↓ / ⇧⌘C / ⌥⌘R do nothing.** The flag is off, or the focused pane
  has no integration yet — the actions only exist while the flag is on,
  so the keys pass through to the terminal untouched.
- **A notification fired for a command I was watching.** Notifications go
  by whether the _tab_ was in front when the command ended; a split pane
  in the same tab counts as in front.
- **History shows a command I didn't expect / don't want.** Mark the
  host incognito, or clear history from Settings → Terminal. The
  database can also simply be deleted.
- **Uninstall left a blank line / changed my file's ending.** The block
  and the one separator line before it are removed; the file ends with a
  single newline afterwards. Every other line is untouched.
