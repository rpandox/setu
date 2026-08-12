# F4 · Splits, broadcast & session restore

> Spec: [PLAN.md](../../PLAN.md) §9 F4 · Shipped in Phase 3

## What is it?

Three things that turn tabs into a cockpit:

- **Split panes.** Any tab can divide into a binary tree of terminal panes —
  side by side or stacked, resizable by dragging the divider, each pane its
  own session (same host as the pane you split, or a fresh local shell).
- **Broadcast — the cssh.** Type once, land everywhere: arm broadcast and
  your keystrokes fan out to every selected pane in the tab. Armed panes
  carry a red hairline top border, and the status bar says exactly how many
  sessions you're typing into.
- **Session restore.** Opt in, and relaunching Setu reopens your tabs and
  split layouts, reconnecting each pane.

## How do I use it?

### Splits

| Keys      | Action                                              |
| --------- | --------------------------------------------------- |
| ⌘D        | Split the focused pane right (same host)            |
| ⇧⌘D       | Split the focused pane down (same host)             |
| ⌥⌘← → ↑ ↓ | Move focus between panes (a brief glow marks where) |
| ⌘W        | Close the focused pane — the layout heals around it |

Splitting an SSH pane opens a second session to the same host; splitting a
local pane opens a fresh shell. Drag the divider between panes to resize —
panes never shrink below 240×120. Closing a tab's last pane closes the tab;
the tab strip's × always closes the whole tab (every pane in it).

In a multi-pane tab, the focused pane carries a quiet hairline outline, and
clicking anywhere in a pane focuses it.

### Broadcast

| Keys | Action                                       |
| ---- | -------------------------------------------- |
| ⇧⌘B  | Arm broadcast for this tab / disarm it again |

1. Each pane in a split tab shows a small circle badge (top-right). Click
   it to include or exclude that pane — solid red means included. Skip this
   step to broadcast to **all** panes: arming with nothing selected selects
   everything in the tab.
2. Press ⇧⌘B. Every included pane gets a red hairline top border and the
   status bar shows "⇉ Broadcasting to N".
3. Type. Keystrokes and single-line pastes go to every included, running
   pane. Click a pane's badge at any time to opt it out mid-broadcast.
4. Press ⇧⌘B again to disarm. Your pane selection is remembered for the
   next arm.

Pasting more than one line while broadcasting always opens a preview
dialog first: the exact text, editable, with the session count on the
confirm button. Nothing multi-line ever lands in N sessions silently.

Switching tabs disarms broadcast by default (config key below). Panes with
dead sessions are skipped, with a toast telling you how many.

Broadcast never captures ⌘-shortcuts — they act on the app, not the
sessions.

### Session restore

Off by default. Enable it in `state.json` (the Settings window arrives in
Phase 8):

```jsonc
// ~/Library/Application Support/dev.pandox.setu/state.json
{
  "restoreOnLaunch": true,
}
```

While enabled, Setu continuously saves your tab and split layout (not the
terminal contents), and reopens it on the next launch: SSH panes reconnect,
local panes open fresh shells. A pane whose connection fails opens with the
normal `connection closed — Reconnect` notice instead of blocking launch.

Only hosts you own (created or adopted in Setu — `source = "setu"`) are
reconnected automatically. Panes pointing at un-adopted `~/.ssh/config`
rows or tailnet peers are dropped from the restored layout, and the layout
heals around them. Adopt a host to make it restorable.

### Config keys (`state.json`)

| Key                   | Default | Meaning                               |
| --------------------- | ------- | ------------------------------------- |
| `broadcastAutoDisarm` | `true`  | Disarm broadcast when you switch tabs |
| `restoreOnLaunch`     | `false` | Reopen the saved layout on launch     |

`state.json` is device-local (it describes this Mac's windows) and is not
part of the `~/.config/setu` sync unit — see [store.md](../dev/store.md).

## What can go wrong?

- **A pane refuses to split.** Its host was deleted mid-session (the tab
  says "(orphaned)") — there's no host record left to connect a sibling to.
- **The divider won't drag any further.** Both sides are at the 240×120
  minimum pane size for the current window; enlarge the window to go
  further.
- **Typing while armed only lands in one pane.** The pane you're typing
  into is opted out (hollow badge) — an excluded pane gets normal, private
  input by design. Click its badge to include it.
- **"Broadcast skipped N disconnected panes."** Those panes' sessions have
  exited; reconnect them (⏎ or the Reconnect button) and type again.
- **Restore brought back fewer panes than I had.** Panes on un-adopted
  `~/.ssh/config` or tailnet hosts don't auto-reconnect (see above); adopt
  the host to keep it across launches.
- **Restore didn't run at all.** It's opt-in (`restoreOnLaunch: true`), and
  a corrupt `state.json` disables both restore and saving until the file is
  fixed or deleted — Setu never overwrites a file it can't parse.
