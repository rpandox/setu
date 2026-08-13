# F7 · Port forwarding

> Spec: [PLAN.md](../../PLAN.md) §9 F7 · Shipped in Phase 6 (`ssh -O`
> live-add on mastered hosts follows in Phase 11)

## What is it?

Tunnels as toggles, not incantations. Each host carries forward rules —
local (`L`), remote (`R`), or dynamic/SOCKS (`D`) plus the standard ssh
spec — and a toggle runs a dedicated, managed `ssh -N` child for that
rule. A health dot tells the truth about each tunnel:

| Dot    | Meaning                                                              |
| ------ | -------------------------------------------------------------------- |
| hollow | rule saved, not running                                              |
| amber  | child up, tunnel not verified yet                                    |
| green  | `L`/`D`: the local port answers · `R`: the remote bind succeeded     |
| red    | the child exited (the reason is shown) or the port stopped answering |

The status bar shows `⇌ N fwd` whenever any host has rules; clicking it
opens the popover with every rule, its dot, and its toggle. Children die
with their toggle and with the app — never orphans.

## How do I use it?

Rules are edited in the **host editor** (sidebar → host → Edit): kind,
spec, and an `auto` flag. Specs are the ssh shapes you already know:

```
L  [bind-addr:]local-port:target-host:target-port    8080:localhost:8080
R  [bind-addr:]remote-port:target-host:target-port   9000:localhost:3000
D  [bind-addr:]local-port                            1080
```

Toggle rules in the status-bar popover. `auto` rules fire by themselves
the moment you open a terminal to their host. `D` rules show a copyable
`socks5://localhost:PORT` string once running. A rule that is currently
running locks in the editor — toggle it off first, then edit.

In `hosts.toml` the same rules look like:

```toml
forwards = [
  { type = "L", spec = "8080:localhost:8080", auto = false },
  { type = "D", spec = "1080", auto = true },
]
```

### When a local port is taken

Starting an `L`/`D` rule whose local port is occupied doesn't limp — the
popover names the owner (via `lsof`) and offers the next free port:

> Port 8080 is in use by node (pid 4132) · **Use 8081**

**Use 8081** starts a one-shot tunnel on the suggested port; your saved
rule is never rewritten.

## What can go wrong?

- **"Host key verification failed"** (red, immediately) — forward
  children run `BatchMode=yes` and can't show the trust prompt. Connect a
  normal terminal to the host once (or open its SFTP panel and trust the
  fingerprint); after that the tunnel starts cleanly.
- **Red right after start, reason names the remote port** — the remote
  bind failed (`R` rules; a privileged or occupied remote port). ssh
  exits fast on purpose (`ExitOnForwardFailure=yes`) instead of running a
  tunnel that forwards nothing.
- **Red with an auth error** — same BatchMode story: only non-interactive
  auth works (agent or key file). A passphrase-protected key needs the
  agent holding it.
- **Amber that never goes green** — the child is alive but the local port
  isn't answering probes. The dot goes red after three misses; check the
  reason.
- **`lsof` missing or slow** — the conflict message degrades to
  "Port N is in use" without the owner's name; the next-free-port
  suggestion still works.
- **Editing a running rule** — locked by design: the running child was
  started from the old spec, and editing under it would strand the
  tunnel. Toggle off, edit, toggle on.
