# F6 · Snippets

> Spec: [PLAN.md](../../PLAN.md) §9 F6 · Shipped in Phase 6 (runbooks
> follow in Phase 12)

## What is it?

Saved commands you stop retyping. A snippet is a label plus a command
template — `journalctl -u {{service}} -f` — where every `{{variable}}`
prompts when you run it, either as a free text input (with an optional
default) or as a fixed list of choices rendered as a select. One run can
target the pane you're in, the armed broadcast set, or **a new SSH tab per
selected host** — three hosts, one action, three tabs already running the
command.

Snippets live in `~/.config/setu/snippets.toml`, inside the same
human-diffable sync unit as your hosts, and travel as **packs**: export
your snippets to a TOML file, import someone else's.

## How do I use it?

| Keys | Action                                                    |
| ---- | --------------------------------------------------------- |
| ⌘J   | Toggle the snippet drawer (list, create, edit, run packs) |
| ⌘K   | Command palette — the Snippets section runs them          |
| ⏎    | In the run dialog: run (once every variable has a value)  |
| Esc  | Close the run dialog / the drawer                         |

Create snippets in the drawer (⌘J): label, command, tags, and one
declaration per `{{variable}}` — a default value, or a comma-separated
choices list. The editor flags undeclared tokens with one-click **Declare
{{token}}** chips; the store re-validates on save (names must be letters,
digits, and `_`, every token declared, every declaration used).

Run from the palette (⌘K, fuzzy over label/tags/command, frecency-ranked)
or the drawer's Run button. The run dialog prompts for variables, shows
the exact resolved command, and asks where to run it:

- **Current pane** — typed into the focused terminal.
- **New tab per host** — pick hosts; each gets a fresh SSH tab and the
  command runs there as the session opens.
- **Broadcast set** — every armed pane (⇧⌘B first), exactly like typing
  into the broadcast.

### Packs

**Import pack…** / **Export all…** in the drawer use native file dialogs.
Imports merge by id — by default an id you already have is kept and the
incoming row skipped; tick _Overwrite on id collision_ to replace. Pack
rows without ids always import as new snippets. An invalid pack imports
nothing (all-or-nothing).

Example `snippets.toml` / pack file:

```toml
[[snippet]]
id = "…uuid…"
label = "follow service logs"
command = "journalctl -u {{service}} -f"
tags = ["logs"]

[[snippet.variables]]
name = "service"
default = "sshd"

[[snippet.variables]]
name = "env"
choices = ["staging", "prod"]
```

## What can go wrong?

- **"Unresolved variable {{x}} — nothing was run"** — a variable had no
  value at run time. The dialog's Run button stays disabled until every
  prompt is filled; blank counts as unfilled. Nothing ever reaches a
  shell half-resolved.
- **A literal `{{` in a command** — not supported (there is no escaping);
  the editor rejects the malformed token. Wrap the braces in a shell
  variable on the remote side if you truly need them.
- **"invalid … in pack"** on import — the pack names the offending
  snippet; fix it in the file and re-import. Nothing was written.
- **The command lands before the remote shell is ready** — for new-tab
  runs the command is written into the PTY immediately and delivered by
  the terminal's input buffering once ssh opens the session. If a host is
  slow, the keystrokes queue; they are not lost.
- **snippets.toml won't parse** — the drawer shows the parse error and
  Setu never overwrites a corrupt file; fix the file by hand and reopen.
