# F11 · Command palette & quick connect

The whole app behind two keystrokes. Phase 2 ships the quick-connect half:
⌘T, a few characters, ⏎ — shell prompt. The full ⌘K palette (actions,
snippets, LED states in results, tuned fuzzy matching) completes in
Phase 4.

## What is it?

⌘T opens a single search field over every known host — Setu hosts and
`~/.ssh/config` aliases alike — ranked by fuzzy match quality across
label, hostname, tags, and user (label matches win). Enter connects the
top hit in a new tab.

## How do I use it?

| Keys  | Action                       |
| ----- | ---------------------------- |
| ⌘T    | Open quick connect           |
| ↑ / ↓ | Move the selection           |
| ⏎     | Connect to the selected host |
| Esc   | Dismiss                      |

- Typo-tolerant: `hemres` still finds `hermes`.
- The top 8 matches show; the first is preselected, so the fast path is
  ⌘T → 3 chars → ⏎.
- Clicking a result connects too; clicking outside dismisses.

## What can go wrong?

- **No matching hosts.** The palette searches known hosts only in
  Phase 2 — ad-hoc `user@host` connections arrive with Phase 11. Add the
  host first (sidebar `+`), or give it an alias in `~/.ssh/config`.
- **The wrong host ranks first.** Ranking weighs label over hostname over
  tags over user; two similar labels can tie surprisingly until the
  Phase 4 tuning pass. Type one more character, or rename hosts to
  distinct labels.
