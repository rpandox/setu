# SETU — a Termius-class SSH command center for macOS (Plan v3)

> **setu** (Sanskrit: सेतु, "bridge") — the thing you cross to reach the other machine.
> Local-first. Keyboard-first. **Open source.** Secrets stay in the macOS Keychain,
> config syncs over git, and documentation ships with every phase — not after.
> Rename freely: the name appears only in `tauri.conf.json`, the bundle id, and this file.

This document is the complete build plan, written to be executed by Claude Code one
phase at a time, gated by acceptance checklists **and a Documentation Gate (§6)**.
**Core track (Phases 0–9)** reaches full Termius parity. **Advanced track (Phases
10–13)** goes past Termius. §9 is the feature-by-feature specification — the single
source of truth for behavior.

---

## 0 · How to run this plan with Claude Code

### 0.1 Prompt keywords cheat sheet (these are the real magic words)

- **`ultrathink`** — the maximum-reasoning trigger. On current Claude Code builds it
  maps to the highest reasoning effort; on older builds it set the maximum extended-
  thinking budget. Either way it is the strongest keyword. The full ladder, lightest
  to heaviest: `think` < `think hard` < `think harder` < `ultrathink`.
  Use `ultrathink` for architecture-heavy phases (0, 1, 5, 10, 11, 17) and whenever
  Claude is stuck in a loop; skip it for routine edits — it costs real tokens.
- **Plan Mode** — press `Shift+Tab` to cycle into Plan Mode before each phase kickoff,
  so Claude researches and proposes before touching files. Phrases like *"propose a
  plan, don't write code yet"* reinforce it.
- **Session-wide effort** — newer builds expose `/effort` (or effort via `/model`);
  set it high for a whole hard session instead of typing `ultrathink` every message.
- There is no `ultracode` or `full` keyword — completeness comes from explicit
  instructions plus the acceptance gates below, not incantations.

### 0.2 Setup

1. Empty repo → save this file at the root as `PLAN.md`.
2. Copy the **CLAUDE.md starter** (§14) into `CLAUDE.md` at the root.
3. Start Claude Code in the repo. Phase 0 creates the LICENSE, README, docs/
   scaffold, and CI — the open-source spine exists before the first feature.

### 0.3 Per-phase kickoff prompt (copy, edit N, paste)

> ultrathink. Read PLAN.md §9 (the feature specs referenced by this phase) and §10
> Phase N in full. Enter plan mode: propose the implementation order, the exact
> files you will create or touch, the IPC changes, the documentation you will write
> or update, and the top three risks — do not write code yet. After I approve the
> plan, implement Phase N only, nothing from later phases. Stop at the acceptance
> checklist and demonstrate each item with evidence (command output, screenshot
> description, or test result), including every item of the Documentation Gate (§6.4).

### 0.4 Review + commit gate prompt (end of every phase)

> think hard. Walk the Phase N acceptance checklist item by item and show the
> evidence for each. Then walk the Documentation Gate (§6.4) the same way: doc
> lints clean, feature pages updated, CHANGELOG entry written. Run the full verify
> suite (typecheck, clippy, tests, doc build, the no-hardcoded-colors grep). Then
> update PLAN.md §5 if any decision changed, and commit as `feat(phase-N): <summary>`.

### 0.5 Working rules

One phase per session — context stays sharp, diffs stay reviewable. Documentation
is written *in* the phase, never batched "later": undocumented code is unfinished
code. If reality diverges from the plan, update the §5 decision log *before* coding
the divergence. The log is the memory between sessions.

---

## 1 · Product definition

**One-liner:** a beautiful, open-source macOS SSH client where any machine is one
keystroke away — Termius-class features and beyond, with no account, no cloud, no
subscription.

**North-star UX principles**

1. **One keystroke to anywhere.** `⌘T`, three letters, Enter → shell prompt. Cold start to prompt < 2s on LAN/tailnet; < 300ms for a second tab to the same host (ControlMaster).
2. **Keyboard-first, mouse-optional.** Every action reachable from the `⌘K` palette.
3. **Nothing leaves the Mac.** No telemetry, no accounts. Secrets in Keychain, config in plain files you own, history in a local DB that never syncs.
4. **Respect the system.** Reuse `~/.ssh/config`, the ssh-agent, `known_hosts`, Tailscale — never fight them.
5. **The board tells the truth at a glance.** Every host is a live LED: green means reachable *right now*, probed the moment the app opens — plus latency, health, forwards, and command status, visible without shouting.
6. **The terminal understands commands, not just bytes.** With shell integration, Setu knows where each command starts and ends, whether it failed, and how long it took — and builds features on that.
7. **Built in the open.** Every public function documented, every feature with a docs page, every phase with a changelog entry. A stranger can clone, understand, and contribute.

**Non-goals (v1):** Windows/Linux builds, iOS/Android, team sharing/collaboration,
serial/telnet, in-app protocol implementation for interactive sessions (we drive the
system `ssh`), cloud sync services, running as root / sudo file operations.

---

## 2 · Feature matrices

### 2.1 Termius parity (core track)

| Termius feature | Setu equivalent | Spec | Phase |
|---|---|---|---|
| Hosts, groups, tags, colors | `hosts.toml` + LED patch-bay sidebar + fuzzy search | F1 | 2 |
| One-click connect | `⌘T` quick-connect palette, Enter on any host row | F1, F11 | 2 |
| Tabs & split panes | Native tabs, `⌘D`/`⇧⌘D` splits, drag to re-arrange | F2, F4 | 1, 3 |
| Vault / secrets | macOS Keychain (Touch ID gated by OS), never on disk | F8 | 7 |
| Snippets (+ variables) | `snippets.toml`, `{{variable}}` prompts, multiple run targets | F6 | 6 |
| SFTP | Dual-pane browser, drag-drop transfers with progress | F5 | 5 |
| Port forwarding | Forward manager: -L/-R/-D as toggleable rules per host | F7 | 6 |
| Jump hosts / agent forwarding | Inherited from `~/.ssh/config` (`ProxyJump`, `ForwardAgent`) — free | F3 | 2 |
| Mosh | Per-host toggle, spawns `mosh` instead of `ssh` | F3 | 7 |
| Sync between devices | Config dir is a git repo; one-click commit/push/pull | F10 | 8 |
| SSH key management | Agent-first; generate, copy-id, loaded-identity list, hardware keys | F8 | 7 |
| **cssh / multi-exec** | Broadcast mode: type once, send to N selected sessions | F4 | 3 |

### 2.2 Beyond Termius (advanced track)

| Capability | What it gives you | Spec | Phase |
|---|---|---|---|
| **Live status board** | Every host probed on app open — green LED when reachable, with latency | F1 | 4 |
| Semantic terminal (OSC 133/7) | Prompt-to-prompt jumps, ✓/✗ + duration marks, copy last output, re-run last | F12 | 10 |
| Done-notifications | macOS notification when a long command finishes in a background tab | F12 | 10 |
| Global command history | Searchable local DB of every command across all hosts (never synced) | F12 | 10 |
| Instant connections | ControlMaster/ControlPersist manager: second tab in <300ms | F3 | 11 |
| Live forward toggling | Add/cancel forwards on a running connection (`ssh -O forward/cancel`) | F7 | 11 |
| Remote edit-in-editor | Open remote file locally, auto-upload on save, conflict detection | F5 | 11 |
| Fleet health | Agentless CPU/mem/disk sparklines per host, threshold alerts | F13 | 12 |
| Output triggers | Regex rules on live output → highlight / notify / run snippet | F14 | 12 |
| Runbooks | Multi-step, multi-host workflows with confirm gates and dry-run | F6 | 12 |
| Companion CLI + deep links | `setu connect hermes`, `setu://` URLs, Raycast integration | F15 | 13 |
| Quake terminal | Global-hotkey drop-down terminal to a designated host | F15 | 13 |
| Deploy-watch | rsync a local dir to a host on every save | F15 | 13 |
| Session recording | asciinema-compatible .cast files, local, off by default | F15 | 13 |
| AI assist | NL→command + explain-last-error via your local `claude` CLI | F16 | 13 |
| User themes | Theme JSON overrides; Phosphor / Basalt & Brass / Paper built in | F18 | 13 |
| tmux control mode | tmux windows as native tabs (experimental, flagged) | F17 | X |

---

## 3 · Architecture

**Stack:** Tauri 2 (Rust backend) · React 18 + TypeScript + Vite · xterm.js · Zustand · rusqlite.

**Process model**

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

**The core trick — interactive sessions drive the system `ssh` through a PTY.**
We do not implement the SSH protocol for terminals. `pty_spawn` runs
`ssh -tt <alias-or-args>` (or `mosh`, or `$SHELL` for local tabs) inside a
portable-pty. This inherits, for free: `~/.ssh/config` (ProxyJump, ControlMaster,
ForwardAgent…), the ssh-agent and Secure-Enclave agents like Secretive,
`known_hosts` prompts (they appear in the terminal, which is the correct UX),
hardware keys (`ed25519-sk`), and Tailscale SSH. The app's job is a world-class
cockpit, not a protocol stack. The **only** in-app protocol use is SFTP
(russh + russh-sftp), because a file browser needs structured directory data.

**Reachability.** The prober gives the sidebar its green lights: on app open (and
every `interval_s` after), each visible host gets a **plain TCP connect** to its
configured port with a short timeout — unprivileged (unlike ICMP ping), and it
tests the actual sshd, not just the network path. Probes are staggered with jitter,
never carry auth, pause when the app is hidden, and feed both the LED state and the
latency chip. Tailnet peers reuse Tailscale's own online state instead of probing.

**Semantic layer.** Shell integration (F12) emits OSC 133 (command start/end/exit),
OSC 7 (cwd), and optionally OSC 52 (clipboard). xterm.js `registerOscHandler` parses
these in the WebView; the frontend derives marks, durations, notifications, and
writes command records to the history DB via IPC. No protocol changes, no server agents.

**IPC contract** (source of truth: `src/ipc/contract.ts`, mirrored by Rust types;
every change updates both plus `docs/dev/ipc.md` in the same commit)

| Direction | Name | Payload → Result |
|---|---|---|
| invoke | `pty_spawn` | `{ kind: "local"\|"ssh"\|"mosh", hostId?, cols, rows }` → `{ sessionId }` |
| invoke | `pty_write` / `pty_resize` / `pty_kill` | session ops |
| event | `pty:data:{sessionId}` / `pty:exit:{sessionId}` | base64 chunks / `{ code }` |
| invoke | `hosts_list / hosts_save / hosts_delete` | CRUD over `hosts.toml` |
| invoke | `ssh_config_import` | → parsed `Host` entries from `~/.ssh/config` |
| invoke | `reach_start / reach_stop` | begin/stop probing a host set |
| event | `reach:{hostId}` | `{ state: "up"\|"down", rtt_ms? }` |
| invoke | `keychain_get / set / delete` | account-scoped secret ops |
| invoke | `sftp_connect / list / mkdir / rename / delete / stat` | file ops |
| invoke | `sftp_upload / sftp_download / sftp_cancel` | → `{ transferId }` |
| event | `sftp:progress:{transferId}` | `{ bytes, total }` |
| event | `hostkey:prompt` → invoke `hostkey_trust` | fingerprint trust flow |
| invoke | `forward_start / forward_stop / forward_live_toggle` | rules + `ssh -O forward/cancel` |
| invoke | `master_status / master_stop` | ControlMaster manager |
| invoke | `tailscale_peers` | parsed `tailscale status --json` |
| invoke | `git_sync_status / git_sync_run` | sync state + commit/pull/push |
| invoke | `history_add / history_query` | command records ⇄ rusqlite |
| invoke | `metrics_start / metrics_stop` · event `metrics:{hostId}` | health probe stream |
| invoke | `runbook_run / runbook_abort` · event `runbook:progress:{runId}` | workflow engine |
| invoke | `editwatch_start / editwatch_stop` · event `editwatch:{watchId}` | remote-edit sync |
| invoke | `deploywatch_start / deploywatch_stop` · event `deploywatch:{watchId}` | rsync-on-save |
| invoke | `record_start / record_stop` | .cast session recording |
| invoke | `ai_available / ai_run` | `claude` CLI presence + one-shot prompt |
| event | `app:deeplink` | parsed `setu://` URL |

**Performance requirements**

- PTY reads batched (8–16 KB), flushed to xterm.js coalesced per animation frame; honor `term.write` callback for backpressure. Target: `yes` / `find /` output does not freeze the UI.
- WebGL renderer addon, automatic canvas fallback. Scrollback default 10 000 lines.
- OSC handling and trigger regexes must add < 1ms per flushed chunk (measure in Phase 10/12).
- Reachability: full board of 20 hosts populated within ~3s of launch; probe timeout 1.5s; concurrency-capped and jittered.

**Security model**

- Secrets (passwords, passphrases) live **only** in Keychain, service `dev.pandox.setu`.
- `hosts.toml` etc. are plaintext and safe to git-sync — the schema forbids secret fields.
- History DB, recordings, and state are local-only and excluded from sync by design.
- Reachability probes are bare TCP connects: no banners read, no auth attempted, rate-limited, and disable-able globally and per host.
- Never log PTY contents or secrets. Redact command args in diagnostics.
- Read `~/.ssh/*`; write only `known_hosts` (append, on explicit trust). Shell-integration installs (local or remote rc files) always show the exact diff and require explicit confirmation.
- AI assist sends only the text you explicitly select/invoke on, shells out to your local `claude` CLI (your existing auth), and never auto-executes a suggested command.
- SECURITY.md documents this model and the vulnerability-report path (§6).

---

## 4 · Data model & file locations

```
~/.config/setu/                      # the sync unit (git repo, phase 8)
  hosts.toml  snippets.toml  runbooks.toml  settings.toml
  themes/                            # user theme JSON (F18)
~/Library/Application Support/dev.pandox.setu/
  state.json                         # window/session restore, MRU, transfer history
  history.sqlite                     # command history (F12) — never synced
  recordings/                        # .cast files (F15) — never synced
  logs/
Keychain service: dev.pandox.setu    # account = host uuid + purpose
Unix socket: ~/Library/Application Support/dev.pandox.setu/setu.sock   # companion CLI
```

`hosts.toml`:

```toml
[[host]]
id         = "9f2c…"            # uuid, stable
label      = "hermes"
group      = "fleet"            # sidebar section
tags       = ["prod", "ubuntu"]
hue        = 4                   # 0–7, per-host identity accent (tabs, cursor)
hostname   = "hermes.tailnet-name.ts.net"
user       = "pandox"
port       = 22
identity   = "agent"            # "agent" | path to key
use_mosh   = false
startup    = "tmux new -A -s main"   # optional, appended after --
control_master = true            # ControlPersist 10m (F3, phase 11)
reachability = true              # LED probing for this host (default true)
forwards   = [ { type = "L", spec = "8080:localhost:8080", auto = false } ]
health     = { enabled = false, interval_s = 30 }     # F13
notes      = ""
favorite   = true
source     = "setu"             # "setu" | "ssh_config" | "tailscale"
```

Settings additions: `reachability = { enabled = true, interval_s = 60, timeout_ms
= 1500, max_concurrent = 6 }`. Imported `~/.ssh/config` entries appear with
`source = "ssh_config"` (read-only until "adopted"); tailnet peers with
`source = "tailscale"` (ephemeral, not persisted).

Other schemas (full field lists live in §9): snippets `id, label, command, tags,
variables[{name, default?, choices?}]`; runbooks `id, label, steps[{target, command|
snippetId, confirm?, continue_on_error?, timeout_s?}]`; triggers (in settings)
`[[trigger]] scope, pattern, actions[highlight|notify|snippet:id|bell], rate_limit_s`;
history rows `ts, host_id, cwd, cmd, exit, duration_ms, session_id`.

---

## 5 · Decision log

| Decision | Choice | Why | Escape hatch |
|---|---|---|---|
| License | **Apache-2.0** | Permissive + explicit patent grant; matches the Tauri/russh ecosystem; fonts are OFL (ship THIRD_PARTY_NOTICES) | MIT if you ever want maximum simplicity |
| Shell framework | **Tauri 2** | ~15 MB app, native feel, Rust core; Electron+node-pty is the fallback if PTY/IPC friction appears | Port is contained: xterm/React layer unchanged |
| Interactive SSH | **Spawn system `ssh` in PTY** | Inherits config/agent/jump/known_hosts/Tailscale SSH; massively less code and auth risk | russh interactive later if ever needed |
| Reachability | **Bare TCP connect probes** | Unprivileged (ICMP needs raw sockets) and tests the actual sshd, not just the path | ICMP via a helper later if ever wanted |
| SFTP | **russh + russh-sftp** | Structured listings; agent+key auth first, Keychain password later | "Reveal in Cyberduck" button as pressure valve |
| Store | **Plain TOML** | Human-diffable, git-syncable, chezmoi-friendly | SQLite only if perf demands (it won't at <1k hosts) |
| Command history | **Local rusqlite, never synced** | Fast search over 100k+ rows; privacy by construction | Export command if ever wanted |
| Semantic terminal | **OSC 133/7/52 via opt-in rc snippet** | Unlocks marks/jumps/notify/history without protocol hacks; degrades gracefully when absent | Warp-style block UI rejected — rewrites the terminal model |
| Default theme | **Phosphor (neon green)** | The brief calls for a neon-green tech aesthetic; executed as a phosphor instrument board, not flat green-on-black | Basalt & Brass ships as the built-in alternative |
| Fleet metrics | **One batched probe over the existing connection** | Zero agents installed on servers | Scrape an existing node_exporter (backlog) |
| Instant tabs | **OpenSSH ControlMaster/ControlPersist** | Battle-tested, config-native, `-O` gives live forward control | Off per-host toggle if a server misbehaves |
| AI assist | **Shell out to local `claude` CLI** | Rides your existing subscription auth; no API keys stored in app | Feature hidden entirely when CLI absent |
| Docs enforcement | **`#![deny(missing_docs)]` + TSDoc lint in CI** | Open-source bar: undocumented public API cannot merge; templates keep the cost low | Downgrade to warn only if it ever blocks a hotfix |
| tmux control mode | **Experimental, feature-flagged** | Genuinely hard; niche until proven | Attach-only window mapping ships first |
| Sync | **git in config dir** | You already run a git-spine; zero new services | chezmoi users can just manage the dir |
| Broadcast (cssh) | **Frontend fan-out** | Keystrokes duplicated to N sessions in the store layer; trivial and robust | — |
| F1/F3/F11 phase split (Phase 2 kickoff) | **Phase 2 ships the CRUD/connect core; untagged spec behaviors land later** — frecency boost, bulk multi-select, notes-markdown popover, fuse tuning → Phase 4 (with the prober/palette); auto-reconnect countdown + ad-hoc `user@host` quick connect → Phase 11. Phase 2 does include duplicate-tab/reconnect-all and the reconnect prompt. Group collapse state persists in localStorage until `state.json` lands (Phase 3) | The specs span two phases without tagging every behavior; the split keeps Phase 2 at its acceptance surface | Pull any deferred behavior forward if a phase lands early |
| Paste-guard split (Phase 3 kickoff) | **Phase 3 ships a minimal PasteGuardDialog on the broadcast path only** (multi-line paste while broadcasting → preview + "N sessions" warning); the full F2 guard (`sudo`/`rm`/`curl\|sh` patterns, single-pane coverage) lands in Phase 4 and extends the same dialog | F4 mandates the broadcast preview in Phase 3 but the paste guard proper is F2/Phase 4 scope; splitting avoids pulling Phase 4 forward | Phase 4 replaces the detection logic, keeps the dialog |
| Session-restore scope (Phase 3 kickoff) | **Restore = layout + `source="setu"` SSH panes only.** Local panes reopen as fresh local shells (keeps the saved layout intact; no auth cost); panes for `ssh_config`/`tailscale` hosts are pruned from the saved tree with the layout healing around them; tabs left empty are dropped. Saved layout + the restore flag live in `state.json` (app-support dir), which lands this phase — sidebar collapse state migrates there from localStorage | F4's one-line restore spec doesn't address non-setu or local panes; this reading preserves layout without restoring hosts the store can't own | "Adopt" imported hosts to make them restorable |
| Toast pulled forward (Phase 3 kickoff) | **A minimal Toast component ships in Phase 3** (broadcast dead-pane skip counts need it per F4); the Phase 4 polish sweep restyles it with the rest of the feedback states | F4 edge case requires a toast one phase before the §10 toast line item | Phase 4 owns the final look |
| Reach event channel (Phase 4 kickoff) | **One `reach:update` event with `hostId` in the payload**, not the §3 table's per-host `reach:{hostId}` channels | The reach store is the event's single consumer — one listener wired once beats per-host subscription churn as the host set changes; `pty:data:{sessionId}` stays per-session because it is high-volume with per-pane consumers | Split into per-host channels later if a per-row consumer ever appears |
| StatusBar placeholders (Phase 4 kickoff) | **Fake chips removed** — the bar shows only real data (focused pane's host label + live latency from the prober); cwd, forwards, and sync chips return with Phases 10/6/8 | Phase 4 is the design-polish phase with a screenshot review; hardcoded `12ms` / `sync ✓` is dishonest UI | Reinstate dimmed placeholders if the bar feels too empty |
| FingerprintDialog timing (Phase 4 kickoff) | **Built in Phase 4 as a presentational component (per the §10 scope list), wired in Phase 5** when the SFTP `hostkey:prompt` flow exists | Interactive ssh shows host-key prompts in the terminal by design; the dialog's only caller arrives with SFTP | Wire early if any Phase 4 flow grows a trust prompt |
| Palette §8 coverage (Phase 4 kickoff) | **The palette lists every §8 action whose feature exists** (Phases 0–4); later-phase §8 actions (SFTP, prompt jumps, quake, settings…) join the registry in their phases | Listing actions that cannot run yet is worse than an incomplete list; the F11 "100% of §8" bar is read against implemented features | — |
| Reduced-motion vs CRT (Phase 4 review) | **The Phase 4 reduced-motion audit covers implemented motion only** — the LED pulse and every transition/keyframe are gated globally (`base.css` 0.01ms clamp) and per-keyframe; CRT mode ships with its toggle in Phase 13 and joins the gate there, as §7 already mandates | The acceptance line names CRT mode, but CRT is Phase 13 scope (theme system + CRT toggle) — Phase 4 has nothing to gate | The global animation clamp would catch a future CRT flicker anyway; Phase 13 adds the explicit `prefers-reduced-motion` disable |
| SFTP panel placement (Phase 5 kickoff) | **⇧⌘S toggles a full-size overlay over the current tab's terminal area** — the session keeps running underneath, toggle back is instant; not a new tab type, not a side split | §7 lists SftpPanel and §8 names the shortcut, but the layout diagram never places it; the overlay gives the dual panes full width with zero new tab-type machinery | Promote to a dedicated tab type if overlay toggling proves confusing |
| Virtualized lists (Phase 5 kickoff) | **`@tanstack/react-virtual` added** for the F5 10k-entries-at-60fps bar — a headless hook, not in §11's pinned npm list | Hand-rolling a virtualizer means owning scroll/resize/keyboard edge cases in a phase that is already large; the hook is ~5 KB and battle-tested | Drop to a hand-rolled windower if the dep misbehaves |
| Drag-out to Finder (Phase 5 kickoff) | **Deferred to Phase 11** — Phase 5 ships pane⇄pane drag both directions plus Finder→app drop-to-upload | Webviews cannot initiate OS file drags; drag-out needs a native drag plugin, and the Phase 5 acceptance list only requires local⇄remote drag between panes | Pull forward if a first-party Tauri drag API lands sooner |
| SFTP IPC beyond the §3 table (Phase 5 kickoff) | **Added `sftp_chmod`, `sftp_disconnect`, and the `sftp_local_*` family** (list/mkdir/rename/delete/chmod over `std::fs`) to the §3 command set | §3's table lists neither chmod nor any local-pane FS surface, but F5 mandates a chmod dialog and a local pane served by Rust std | — |
| Live acceptance harness (Phase 5 review) | **The machine-checkable half of the F5 acceptance list is an ignored-by-default e2e suite against a throwaway localhost `sshd`** (`cargo test --test live_sftp -- --ignored`); `scripts/qa-sftp-server.sh` packages the same server for the GUI walk. The review's re-run caught a dead-link race — a session torn down between chunks surfaces as russh-sftp `UnexpectedBehavior("session closed")` and classified permanent instead of retryable; fixed in the same review | The engine's acceptance behaviors (trust flow, streaming, cancel/cleanup, retry taxonomy) are host-independent, and a localhost sshd makes them repeatable with a fresh host key every run; the GUI walk on a real remote host stays the human half | Point the suite at a remote host later if a localhost sshd ever proves too forgiving |
| Pane⇄pane drag is pointer-based (Phase 5 review) | **The panes drag with plain mouse events** (4 px threshold, count chip at the pointer, target-pane highlight, Esc cancels) — not HTML5 drag-and-drop | The GUI walk found drops never delivering: Tauri's native drag layer, which Finder→app drop-to-upload requires, swallows webview drops on macOS, so `dragstart` fires and `drop` never arrives. Disabling the native layer instead would break Finder drops (webview `File` objects carry no absolute paths) | Revisit if wry ever lets both drag layers coexist |
| Client-minted transfer ids (Phase 5 review) | **`sftp_upload`/`sftp_download` take a frontend-minted `transferId`** in the payload (echoed in the result) instead of returning a backend-minted one | The GUI walk found fast downloads stranded as "running" forever: the progress listener was registered after the command returned, and a localhost transfer can finish before the listener exists. Minting client-side lets the listener exist before the command flies; the backend rejects empty/in-flight ids | — |
| Snippets IPC family (Phase 6 kickoff) | **Added `snippet_list / snippet_upsert / snippet_delete / snippet_import / snippet_export`**, mirroring the hosts family (full record + `{field, message}` validation errors); packs cross IPC as TOML text, file picking stays frontend-side | §3's table names forward commands but no snippet commands, and F6 mandates CRUD + packs | — |
| Snippet variable syntax (Phase 6 kickoff) | **Defaults and choices live in the schema, not inline** — commands carry bare `{{var}}` tokens; no `{{var:default}}`, no brace escaping in v1 | Keeps commands readable and the token regex trivial; the variables editor documents intent; escaping has no §9 mandate | Inline defaults or escaping later if real snippet packs demand them |
| Snippet drawer shortcut (Phase 6 kickoff) | **⌘J toggles the SnippetDrawer**; §8 gains the row | F6 mandates a drawer but §8 never assigned it a key; ⌘J is free, one-handed, and conflict-free | Rebind before the Phase 9 release if it collides with anything |
| openSshTab return value (Phase 6 kickoff) | **`openSshTab` returns the spawned `sessionId`** (was `void`) | The snippet multi-host target writes the resolved command into tabs it just opened; purely additive | — |
| Forward child processes (Phase 6 kickoff) | **`tokio::process` with `process_group(0)` at spawn; `libc::killpg(SIGTERM)` on toggle-off and in the app-exit hook** — tokio's "process" feature and `libc` join §11 | `ssh -N` under ProxyJump/ProxyCommand spawns subprocesses; only a group kill keeps "no orphans in `ps`" true | Escalate to SIGKILL after a grace period if SIGTERM ever proves insufficient |
| Forward status channel (Phase 6 kickoff) | **One `forward:update` event with `ruleKey` in the payload**, not per-rule channels | Same reasoning as the Phase 4 `reach:update` row: the forwards store is the single consumer; no per-rule subscription churn | Split per-rule if a per-row consumer ever appears |
| Port-conflict surface (Phase 6 kickoff) | **Folded into `forward_start`'s result** (`{ started: false, error: { kind: "port_in_use", message, suggestedPort } }`); "Use next port" retries once with a rewritten spec and never persists it | An atomic check-and-start can't race another process grabbing the port between probe and spawn; hosts-family precedent keeps expected outcomes result-side | Promote to a standalone probe command if another caller needs it |
| Forward auto-start hook (Phase 6 kickoff; precised at review) | **A sessions-store subscription fires `auto` rules when a host gains its first running session** (enters the running set), deduped against live ruleKeys | Catches every connect path (tab, split, duplicate, restore) exactly once; later tabs/splits on an already-connected host deliberately don't re-fire a rule the user stopped | — |
| Forward ssh flags (Phase 6 kickoff) | **Every `ssh -N` child runs `-o ExitOnForwardFailure=yes -o BatchMode=yes`** | Silent bind failures and hanging auth/host-key prompts become fast exits the health machine can read; unknown host keys must be trusted via a terminal connect first (F07 documents this) | Per-host BatchMode opt-out if some auth flow genuinely needs prompts (would need new UX) |
| Snippet pack file dialogs (Phase 6 kickoff) | **`tauri-plugin-dialog` + `@tauri-apps/plugin-dialog` added (pinned)**; the picked *paths* cross IPC and the Rust core does the file I/O | Packs need real file picking; the official plugin is small, and dialog-picked paths carry explicit user consent — no fs plugin, no broad scopes (the `sftp_local_*` family set the paths-over-IPC precedent) | `<input type=file>` import + clipboard export if the plugin misbehaves |
| Keychain IPC surface (Phase 7 kickoff; precised in-phase) | **`keychain_set / keychain_delete / keychain_has` cross IPC; `keychain_get` stays Rust-internal** (reads happen only inside the SFTP auth ladder). A missing/rejected secret is a **result-side `needsSecret` outcome on `sftp_connect`** — not a new event — covering both password and passphrase prompts. Passphrase accounts are keyed by expanded key *path* (`passphrase:{path}`), passwords by host uuid (`password:{uuid}`) | §3's security model outranks its own IPC table row: secrets must never flow toward the webview. Expected outcomes travel result-side (hosts/forwards precedent); `hostkey:prompt` stays an event only because it parks a half-open handshake — the secret stop drops the connection and retries fresh, so no event is needed. Path-keyed passphrases mean two hosts sharing a key share one entry | Add a `keychain_get` command with its own decision row if a UI flow ever genuinely needs to read a secret |
| Key generation (Phase 7 kickoff) | **`ssh-keygen -t ed25519` driven through a hidden PTY, prompts answered programmatically**; empty passphrase by default; a set passphrase is written straight to Keychain | A passphrase on the argv (`-N`) is visible in `ps`; PTY-driven entry keeps it out of argv, disk, and logs while still shelling the system tool per F8 | Pure-Rust `ssh-key` crate generation if the prompt driver proves brittle across OpenSSH versions |
| Keys panel placement (Phase 7 kickoff) | **A KeysPanel (right-hand panel, HostEditor-drawer pattern) opened via palette action and from the HostEditor identity field**; §7's component inventory gains it | F8 mandates generate/copy-id/agent-list UI but §7 never placed it and the Settings window only arrives in Phase 8 | Fold into the Settings window in Phase 8 if two homes prove confusing |
| Generic `binary_check` (Phase 7 kickoff) | **One allow-listed `binary_check { name } → { found, path? }` command** instead of per-tool checks | Mosh preflight, tailscale detection, and Phase 13's `claude` CLI all need the same "is this installed" probe; the allow-list keeps it from becoming an arbitrary-path oracle | Split per-tool commands if any tool ever needs richer detection than found/path |
| Mosh preflight (Phase 7 kickoff) | **Editor-time inline hint + connect-time toast when the binary is missing; no silent fallback to ssh** | A mosh toggle that silently opens ssh sessions lies about what's running; explicit failure with a `brew install mosh` hint is honest and one click from fixed | Offer an explicit "connect with ssh instead" toast action if users ask for it |
| Tailnet resolution (Phase 7 kickoff) | **Peers get `ts:{stableId}` host ids resolved by a fresh `tailscale status --json` at spawn time** (the `sshcfg:` mirror); the default tailnet user rides inside the `tailscale_peers` result; F9's "hint in settings" line waits for the Phase 8 Settings window | Stateless fresh-parse has no cache to invalidate and spawns are rare; embedding the setting avoids a one-field settings IPC a phase early | Cache peers Rust-side if `status --json` latency ever bothers spawn; `settings_get` lands with Phase 8 anyway |
| Vault export deps (Phase 7 kickoff) | **`age` + `tar` crates join §11** for the F8 vault export (passphrase/scrypt recipient, `.tar.age` output); secrets excluded unless the second explicit toggle walks known Keychain accounts into the encrypted tarball | F8 mandates an age-encrypted tarball; the `age` binary isn't in §11's system-tools list and a pure-Rust path avoids a runtime dependency | Shell out to a user-installed `age` binary if the crate ever blocks an upgrade |

---

## 6 · Documentation & open-source standards

This project is public from commit one. Documentation is not a phase — it is part
of every phase's definition of done.

### 6.1 Repository spine (created in Phase 0)

```
README.md            # what/why, hero screenshot or cast, quickstart, feature table,
                     # build-from-source, links into docs/
LICENSE              # Apache-2.0
THIRD_PARTY_NOTICES.md   # bundled font OFL notices, notable dependency licenses
CONTRIBUTING.md      # dev setup, the phase workflow, style rules, how to run checks,
                     # how the Documentation Gate works for PRs
SECURITY.md          # supported versions, report path (private email/advisories),
                     # summary of the §3 security model
CODE_OF_CONDUCT.md   # Contributor Covenant
CHANGELOG.md         # Keep a Changelog format; one entry per phase minimum
.github/             # issue templates (bug, feature), PR template with doc-gate
                     # checklist, CI workflows
docs/
  architecture.md    # living mirror of §3: process model, IPC philosophy, security
  dev/
    ipc.md           # every command + event, payloads, errors — regenerated/updated
                     # whenever contract.ts changes (same commit)
    store.md  pty.md  release.md
  features/
    F01-hosts.md … F18-themes.md   # one page per feature: what it does, how to use
                                   # it, keyboard, screenshots, config keys, limits
```

### 6.2 Code documentation standards — Rust

- Crate-wide `#![deny(missing_docs)]`; CI runs `cargo doc --no-deps` and fails on
  any warning.
- Every module opens with `//!` explaining its role in one short paragraph.
- Every public item gets `///` rustdoc answering *what* and *why* (the *how* is the
  code), with `# Errors` on fallible functions, `# Panics` where relevant, and a
  runnable `# Examples` block where practical (doctests run in CI).
- Every `#[tauri::command]` documents its payload, result, emitted events, and
  failure modes — these comments are the backend half of the API reference.

### 6.3 Code documentation standards — TypeScript/React

- TSDoc on every exported function, hook, component, and store: purpose, `@param`,
  `@returns`, and an `@example` for anything non-obvious. Enforced via ESLint
  (`eslint-plugin-tsdoc` + a jsdoc-completeness rule) in CI.
- `src/ipc/contract.ts` is the canonical, fully-commented API surface — every
  command and event documented at the type definition; `docs/dev/ipc.md` stays in
  lockstep in the same commit.
- Components document their props inline; complex state stores get a header comment
  mapping state shape → owning feature (F-number).

### 6.4 The Documentation Gate (applies to every phase in §10)

A phase is **not done** until all of these pass, with evidence in the review:

1. `cargo doc --no-deps` warning-free and ESLint doc rules clean — no undocumented
   public surface was added.
2. The `docs/features/F##` page(s) for every feature touched are created/updated,
   including keyboard shortcuts and config keys.
3. `docs/dev/ipc.md` updated if the IPC contract changed.
4. `CHANGELOG.md` has the phase's entry (user-visible changes, breaking notes).
5. README updated when user-facing behavior or setup changed; visual features get
   a screenshot or `.cast` referenced from their docs page.
6. CI (typecheck · clippy `-D warnings` · tests · fmt check · doc build · doc lints)
   is green.

### 6.5 Writing style

Plain language, second person, examples before abstractions, no marketing voice.
Docs pages answer, in order: what is it, how do I use it, what can go wrong. Config
keys and shortcuts are always shown, never described.

---

## 7 · Design system — "Phosphor"

Direction: a **phosphor instrument board** — the neon-green tech aesthetic of a
P1-phosphor CRT and a rack of status LEDs, executed with craft. The rule that keeps
it from collapsing into generic green-on-black: **green is status and energy, not
body text.** Surfaces are near-black with a green cast, reading text stays a calm
pale mint, ANSI output keeps full multi-hue readability, and the neon is spent
where it means something — LEDs, the active tab, the cursor, focus. Glow is a
budgeted resource with exactly three legal uses.

**Tokens** (`src/styles/tokens.css` — single source of truth; the terminal ANSI
theme and all components derive from these):

```css
:root {
  /* surfaces — near-black, green-cast */
  --bg-0:#060907; --bg-1:#0A0F0C; --bg-2:#0F1611; --bg-3:#152016;
  --line:rgba(120,255,170,.08); --line-strong:rgba(120,255,170,.16);
  /* ink — pale mint, never pure white, never neon */
  --ink-1:#D9E8DC; --ink-2:#93A89A; --ink-3:#5C6F62;  /* ink-3: large labels only */
  /* the neon — hover #6CFFA0, pressed #2ED96A */
  --neon:#3BFF7E; --neon-ink:#04140A;
  --glow:0 0 12px rgba(59,255,126,.35);   /* LEDs, active-tab underline, focus ring ONLY */
  /* state */
  --ok:#3BFF7E; --warn:#F5D96B; --err:#FF6B6B; --info:#5FD3FF;
  /* per-host identity hues (tab underline, terminal cursor), hue 0–7 */
  --hue-0:#3BFF7E; --hue-1:#5FD3FF; --hue-2:#C792EA; --hue-3:#F5D96B;
  --hue-4:#FF6B6B; --hue-5:#5FFFE1; --hue-6:#FFA94D; --hue-7:#93A89A;
  /* geometry & motion */
  --r-1:6px; --r-2:10px; --pad:8px;
  --t-fast:120ms cubic-bezier(.3,.7,.4,1); --t-med:180ms cubic-bezier(.3,.7,.4,1);
}
```

**Terminal ANSI theme "Setu Phosphor"** (derive in `theme.ts` from tokens):
background `--bg-0`, foreground `#CFE6D4`, cursor = host hue (default `--neon`),
selection `rgba(59,255,126,.22)`; black `#16211A`, red `#FF6B6B`, green `#3BFF7E`,
yellow `#F5D96B`, blue `#5FA8FF`, magenta `#C792EA`, cyan `#5FFFE1`, white
`#D9E8DC`; brights lifted ~8% luminance. Output stays polychrome on purpose —
logs, diffs, and syntax need their colors; the *chrome* is what carries the green.

**Signature element — the LED board.** The sidebar is a rack of status LEDs, and
the LEDs are real: the reachability prober (§3, F1) lights them the moment the app
opens. Each row: `● hermes  ▸ pandox@…ts.net        12ms`.

| LED state | Meaning | Treatment |
|---|---|---|
| Hollow ring `--ink-3` | Probing / reachability off | no glow |
| **Solid `--neon` + `--glow`** | **Reachable right now** | latency chip fades in |
| Solid `--neon`, slow pulse | Live session on this host | 2.4s opacity 0.6→1 |
| Solid `--err`, no glow | Unreachable (probe timed out) | last-seen on hover |

Group headers are small-caps `--ink-3` eyebrows in JetBrains Mono with hairline
rules. When health monitoring is on, a 40×14 load sparkline (`--ink-3` line,
`--neon` last point) sits at the row's right edge. This board is the one memorable
thing; everything around it stays quiet.

**Glow discipline.** `--glow` may appear on exactly three things: reachable/active
LEDs, the active tab's 2px underline, and the keyboard focus ring. Never on text,
never on borders at rest, never stacked. **CRT mode** (Settings → Appearance,
default off): subtle scanline overlay at 3% opacity + 0.5px bloom on the terminal
only — a toy, honestly labeled, disabled entirely under `prefers-reduced-motion`
and `prefers-reduced-transparency`.

**Typography.** UI: **Inter** (13px base, 1.45 line-height; weights 450/550/650).
Terminal, code, group eyebrows, and all data chips: **JetBrains Mono** (13px
default, ligatures on, user-configurable) — the mono chrome is part of the tech
register. Display moments only (empty states, onboarding, about): **Space Grotesk**
20–28px. All three OFL — bundle, don't fetch, notice in THIRD_PARTY_NOTICES.
Status-bar numbers use tabular figures.

**Layout**

```
┌─┬──────────────────────────────────────────────┐
│ │ ⋯tab tab tab                            +    │  38px, traffic-lights inset (overlay titlebar)
│L├──────────────────────────────────────────────┤
│E│ ▎                                            │  ▎ = 3px prompt gutter marks (F12)
│D│ ▎           terminal / splits                │
│S│ ▎                                            │
│ ├──────────────────────────────────────────────┤
│ │ ⌁ hermes · ~/apps · 12ms · 2 fwd · rec● sync✓│  24px status bar
└─┴──────────────────────────────────────────────┘
  260px, collapsible ⌘/  · sections: Search, Favorites, Groups…, Tailnet
```

Optional polish: sidebar vibrancy via `window-vibrancy` (NSVisualEffectView), gated
behind a setting; the app must look correct without it (the green-cast surfaces
must not depend on it).

**Components inventory.** Core: HostRow (LED + label + latency), GroupHeader,
TabBar/Tab, TerminalPane, SplitContainer, StatusBar, CommandPalette (⌘K, also
powers quick-connect ⌘T), SnippetDrawer, SftpPanel (dual-pane + transfer queue),
ForwardsPopover, HostEditor (right drawer), KeysPanel (right panel: agent list,
generate, copy-id, vault export — Phase 7), Settings (window), Toast, ConfirmDialog,
FingerprintDialog, BroadcastBar (red hairline on broadcasting panes + status badge).
Advanced: PromptGutter (✓ `--ok` / ✗ `--err` ticks + duration on hover),
HistorySearch (palette section), HealthSparkline + HostHealthPopover (mem/disk
gauges), TriggerEditor, RunbookRunner (step list with live per-step status),
EditWatchBadge, DeployWatchPanel, QuakeWindow (borderless drop-down), RecordingBadge
(unmissable `--err` dot in status bar while recording), AIPanel (right sheet:
prompt → suggested command with explicit Insert button, never auto-run),
CRTOverlay (optional, terminal-only).

**Interface writing:** sentence case, plain verbs, active voice ("Connect",
"Trust this key", "Broadcasting to 4 sessions", "Recording"). Errors state what
failed and the next action ("Couldn't reach hermes on port 22 · Retry / Edit host").
Empty sidebar is an invitation: "No hosts yet — import from ~/.ssh/config or press ⌘T".

**Quality floor:** visible keyboard focus everywhere (`--glow` ring); WCAG-AA
contrast on all text tokens — `--ink-2` passes on every surface, `--ink-3` is
restricted to ≥11px small-caps labels; `prefers-reduced-motion` kills pulse,
transitions, and CRT mode; resizable to 900×600 minimum.

---

## 8 · Keyboard map

| Keys | Action |
|---|---|
| ⌘T | Quick connect (palette in connect mode) |
| ⌘K | Command palette (actions, hosts, snippets, history) |
| ⌘N | New local shell tab |
| ⌘D / ⇧⌘D | Split right / split down (same host) |
| ⌘W / ⌘1–9 / ⌃Tab | Close pane / go to tab / cycle tabs |
| ⌥⌘←→↑↓ | Move focus between panes |
| ⇧⌘B | Toggle broadcast for selected panes |
| ⇧⌘F | Find in terminal (search addon) |
| ⇧⌘S | Toggle SFTP panel for current host |
| ⌘J | Toggle snippet drawer (F6) |
| ⌘↑ / ⌘↓ | Jump to previous / next prompt (F12) |
| ⇧⌘C | Copy last command's output (F12) |
| ⌥⌘R | Re-run last command (F12) |
| ⌥` | Global quake terminal — configurable (F15) |
| ⌘, / ⌘/ | Settings / toggle sidebar |
| ⌘C ⌘V | Copy (auto on selection: setting) / paste (guarded, F2) |

---
## 9 · Feature-by-feature specification

The behavioral source of truth. Phases in §10 reference these specs; when a phase
and a spec disagree, the spec wins and the decision log records the fix. Every
feature also owns a `docs/features/F##-*.md` page kept current by the
Documentation Gate.

### F1 · Host management & the LED board (Phases 2, 4)
**Purpose:** every machine you touch, one keystroke away — and its live status one
glance away.
**Behaviors:** CRUD via HostEditor drawer with inline validation (hostname non-empty,
port 1–65535, identity path exists). Groups collapse/expand and persist. Tags are
free-form chips; hue picker shows the 8 hues. Favorites pin to the top section.
Fuzzy search (fuse.js) ranks across label > hostname > tags > user, with frecency
boost. Import from `~/.ssh/config` parses Host/HostName/User/Port/IdentityFile/
ProxyJump; imported rows are read-only (`source="ssh_config"`) until "Adopt" copies
them into `hosts.toml`. Duplicate detection warns on same user@host:port. Bulk
actions: multi-select → set group/tag/hue, delete. Notes render minimal markdown in
a popover. "Copy ssh command" on every row.
**Reachability LEDs:** the moment the app opens, every visible host with
`reachability = true` is probed — staggered, jittered, max 6 concurrent, 1.5s
timeout, then re-probed every `interval_s` (default 60). LED states per the §7
table: neon green + glow = reachable now (latency chip appears), pulsing = live
session, red = unreachable (last-seen on hover), hollow = probing/off. Probing
pauses when the app has been hidden > 60s and resumes on focus with an immediate
sweep. Tailnet rows reuse Tailscale's online state — no probe. Global and per-host
kill switches.
**Edge cases:** alias-only entries probe the resolved HostName when parseable, else
stay hollow with a tooltip; wildcard `Host *` blocks are ignored for rows but their
options still apply via system ssh; deleting a host with live sessions keeps
sessions alive and marks tabs "(orphaned)"; a host that answers TCP but refuses ssh
still shows green (the LED is reachability, not auth — the docs page says so);
label collisions get a numeric suffix in UI only.
**Done when:** Phase 2 + Phase 4 checklists pass; a 50-host config feels instant to
search and its board fully lights within ~3s of launch.

### F2 · Terminal core (Phases 1, 4)
**Purpose:** a terminal you'd choose even without the SSH features.
**Behaviors:** xterm.js with fit/webgl/search/web-links/unicode11/image/clipboard
addons; ligatures toggle; per-profile font size (⌘+/⌘−/⌘0); cursor block|bar|underline;
bracketed paste always on. Selection: word on double-click, line on triple, rectangular
with ⌥; optional copy-on-select; trailing-whitespace trimmed on copy. **Paste guard:**
pasting >1 line (or any line ending in `sudo`, `rm`, `curl|sh` patterns) opens a
preview dialog with the exact bytes, Edit and Paste buttons — the #1 defense against
clipboard disasters; single-line safe pastes go straight through. URL/path detection:
⌘-click opens URLs; file-looking paths offer "Reveal in SFTP" when a panel is open.
Find (⇧⌘F) with regex toggle and match count. Bell: visual flash + optional sound.
Inline images (iTerm IIP/SIXEL via image addon) render for tools that emit them.
**Edge cases:** alt-screen apps (vim/htop) suppress scrollback capture and prompt
marks; flood output must not starve input handling (backpressure per §3); resize
mid-output reflows without corruption; non-UTF8 bytes render as replacement glyphs
without breaking the parser.
**Done when:** Phase 1 checklist + paste guard demonstrably intercepts a 3-line paste.

### F3 · Sessions & connection lifecycle (Phases 2, 11)
**Purpose:** connections that feel instant and never leave zombies.
**Behaviors:** spawn pipeline builds argv: `ssh -tt` + `-o ServerAliveInterval=30
-o ServerAliveCountMax=3` + host flags (or bare alias) + optional `-- <startup>`.
Tab title = OSC 0/2 title when emitted, else host label; hue underline on the tab.
On exit: exit code surfaced in-pane with a Reconnect button and ⏎-to-reconnect;
auto-reconnect with 3-2-1 countdown is a per-host setting. "Duplicate tab" and
"Reconnect all" actions. **ControlMaster (Phase 11):** per-host `control_master=true`
adds `-o ControlMaster=auto -o ControlPath=~/.ssh/setu-%C -o ControlPersist=10m`;
the Masters popover lists live masters (`ssh -O check`) with per-master Stop
(`-O exit`); second tab to a mastered host must land < 300ms; SFTP and forwards
ride the same master where possible.
**Edge cases:** master socket stale after sleep → detect check failure, fall back to
fresh connection and clean the socket; mosh sessions never use masters; killing the
app must `-O exit` nothing (masters are the user's — leave them; document).
**Done when:** Phase 2 + Phase 11 checklists pass, `ps` shows zero orphaned ssh after app quit.

### F4 · Splits & broadcast — the cssh (Phase 3)
**Purpose:** type once, land everywhere; arrange panes like a cockpit.
**Behaviors:** binary split tree per tab; ratios persist; drag borders; min pane
240×120; ⌥⌘-arrows move focus with a brief focus glow. Broadcast: select panes
(click-to-toggle badge or "all in tab"), ⇧⌘B arms it — red hairline top border on
every armed pane + status-bar badge "Broadcasting to N". Keystrokes and single-line
pastes fan out; multi-line paste in broadcast always opens the paste guard with an
extra "N sessions" warning. Per-pane opt-out mid-broadcast. Optional safety: auto-disarm
on tab switch (default on).
**Edge cases:** panes with dead sessions are skipped with a toast count; IME
composition commits atomically to all panes; broadcast never captures ⌘-shortcuts.
**Done when:** Phase 3 checklist passes, including the deselected-pane exclusion.

### F5 · SFTP & files (Phases 5, 11)
**Purpose:** files move as easily as keystrokes.
**Behaviors:** dual-pane (local via Rust std, remote via russh-sftp), virtualized
lists (10k+ entries), sortable columns (name/size/mtime/perm), hidden toggle,
editable path bar with completion, breadcrumbs. Transfers: queue with concurrency 3,
per-item progress/speed/ETA, cancel with partial-file cleanup, auto-retry ×1 on
transient errors. Ops: mkdir, rename, delete (confirm), chmod dialog (octal +
checkboxes), symlinks shown with target and followed on double-click. Drag-drop both
directions and drag-out to Finder. "Follow session cwd" toggle syncs the remote pane
to OSC 7 reports (activates with F12). **Remote edit (Phase 11):** "Edit locally"
downloads to a temp dir, opens in the user's editor, FS-watches, uploads on save
with a status badge; if remote mtime changed since download → conflict sheet
(Overwrite / Save-as / Diff-in-terminal).
**Edge cases:** unicode + emoji filenames; permission-denied paths surface the error
verbatim (no sudo in v1); >2 GB files stream without buffering whole; dropped
connection mid-transfer marks item Failed-Retryable.
**Done when:** Phase 5 + the Phase 11 remote-edit items pass.

### F6 · Snippets & runbooks (Phases 6, 12)
**Purpose:** stop retyping; then stop re-orchestrating.
**Behaviors:** snippets CRUD in drawer + palette; `{{var}}` tokens prompt at run
(text default, or `choices=[…]` renders a select); targets: current pane / new tab
per selected host / broadcast set. Import/export snippet packs as toml.
**Runbooks (Phase 12):** ordered steps; each step = command or snippet ref + target
(specific host, tag query like `tag:prod`, or "prompt at run") + flags `confirm`,
`continue_on_error`, `timeout_s`. Dry-run renders the full expansion (every command ×
every resolved host) before anything executes. Runner shows live per-step status
(pending/running/ok/failed/skipped) with collapsible output per host; abort stops
at the current step boundary. Run log saved to state dir.
**Edge cases:** unresolved variable aborts before execution; tag resolving to zero
hosts fails the dry-run loudly; a step's failure with `continue_on_error=false`
halts and highlights.
**Done when:** Phase 6 checklist + a 3-step, 2-host runbook dry-runs and executes correctly.

### F7 · Port forwarding (Phases 6, 11)
**Purpose:** tunnels as toggles, not incantations.
**Behaviors:** per-host rules (`L|R|D` + spec); toggle starts a managed `ssh -N`
child (or, on a mastered host, `ssh -O forward` live-adds with zero new processes —
Phase 11) and health-checks: local bind succeeded + (for L) TCP probe of the local
port. Status: green/amber/red dot per rule, count in status bar. Auto-start rules
fire on host connect. Port-in-use → error names the owning process (`lsof`) and
offers the next free port. Dynamic (`D`) rules show a "SOCKS on localhost:PORT" hint
with a copyable proxy string.
**Edge cases:** live-cancel via `-O cancel` on mastered hosts; children are
process-group-killed on toggle-off and app exit; rule edits while active require
toggle-off first (enforced in UI).
**Done when:** Phase 6 checklist + Phase 11 live-toggle item pass with zero orphans.

### F8 · Keys & vault (Phase 7)
**Purpose:** agent-first identity, secrets that never touch disk.
**Behaviors:** identity per host = agent (default) or key path. "Generate key"
shells `ssh-keygen -t ed25519` (filename + optional passphrase via Keychain-backed
prompt), then offers Copy public key and an `ssh-copy-id` helper that runs in a
visible pane (never hidden). Loaded identities listed via `ssh-add -l` with
fingerprints. Keychain entries (service `dev.pandox.setu`) store host passwords/
passphrases for **SFTP auth only** — interactive ssh stays agent-first; auto-typing
passwords into a PTY is explicitly out of scope (insecure). Hardware keys
(`ed25519-sk`) work via system ssh — surface a hint when such a key is selected.
Vault export = age-encrypted tarball of the config dir; secrets are *not* included
by default and require a second explicit toggle.
**Edge cases:** agent absent → clear guidance banner, not silent failure; key with
passphrase + no agent for SFTP → Keychain prompt path.
**Done when:** Phase 7 key items pass end-to-end against a fresh test host.

### F9 · Tailscale awareness (Phase 7)
**Purpose:** the tailnet is a first-class host source.
**Behaviors:** if `tailscale` binary present, poll `status --json` every 30s;
sidebar "Tailnet" section lists peers: MagicDNS name, OS icon, online state, tags.
Peer LEDs mirror Tailscale's own online state (no TCP probe). Connect uses DNS
name + default tailnet user (setting). Detect Tailscale-SSH-enabled peers (badge
"ts-ssh": key-free connect). Offline peers dimmed with last-seen; a "ping to wake
path" action runs `tailscale ping` for path warm-up. Peers are ephemeral
(`source="tailscale"`, never persisted) but "Adopt as host" promotes one into
`hosts.toml`.
**Edge cases:** binary absent or logged out → section hidden, one-line hint in
settings; self node excluded; duplicate of an existing host (same DNS name)
collapses into the existing row with a tailnet badge.
**Done when:** Phase 7 tailnet items pass with the binary present and absent.

### F10 · Sync & backup (Phase 8)
**Purpose:** your config everywhere you are, owned by you.
**Behaviors:** git repo in `~/.config/setu`; sidebar-footer status dot (clean /
ahead / behind / conflict); "Sync now" = add-commit(`setu: <hostname> <ts>`)-pull
--rebase-push; optional auto-sync on quit. Conflict → open dir in Finder + a short
resolution doc. Secrets lint refuses to commit any value matching secret heuristics
(assignment to password/token/secret keys, PEM headers, 40+ char base64 runs) with
the offending line shown. Snapshots: zip the config dir on a schedule (default
weekly, keep 10) into the state dir.
**Edge cases:** no remote configured → local commits only, dot shows "local";
divergent machines → rebase; if rebase conflicts, never auto-resolve.
**Done when:** Phase 8 checklist passes including the lint block.

### F11 · Command palette & quick connect (Phases 2, 4)
**Purpose:** the whole app behind two keystrokes.
**Behaviors:** ⌘K opens sections Actions / Hosts / Snippets / History (History after
F12); ⌘T opens pre-filtered to Hosts. Frecency ranking; per-result inline actions on
hosts (⏎ connect · ⌘⏎ new tab · ⌥⏎ SFTP · ⌘E edit · ⌘C copy ssh command); host
results show their live LED state. Every command in §8 is also a palette action with
its shortcut shown. Fuzzy matching tolerates typos (fuse threshold tuned in Phase 4).
**Done when:** "her⏎" connects to hermes as the top hit; palette lists 100% of §8.

### F12 · Semantic terminal — shell integration (Phase 10)
**Purpose:** the terminal knows where commands begin, end, and fail.
**Behaviors:** one-click installer appends a sourced snippet for zsh/bash/fish that
emits OSC 133 A/B/C/D (prompt/command start/end + exit code), OSC 7 (cwd), and
optional OSC 52 (remote→local clipboard, off by default). Local install edits your
rc; **remote install** shows the exact diff of the target rc file and appends only
on confirm (per host, reversible — the block is fenced with markers). Features
unlocked: 3px gutter marks per command (`--ok`/`--err`, duration on hover);
⌘↑/⌘↓ prompt jumps; ⇧⌘C copies exactly the last command's output; ⌥⌘R re-runs the
last command; status bar shows live cwd (and feeds SFTP follow-mode); **done
notifications** — a command running >30s that finishes while its tab is unfocused
fires a macOS notification with command + duration + exit status (click focuses the
pane); **global history** — every completed command is recorded (`ts, host, cwd,
cmd, exit, duration`) to the local DB, searchable in the palette's History section
and reusable (⏎ pastes into current pane, never auto-runs). Per-host "incognito"
flag and a global toggle disable recording; alt-screen output is never recorded.
**Edge cases:** integration absent → every dependent feature hides, zero errors;
double-install detected by fence markers; multiplexed tmux sessions emit marks from
inner shells — dedupe by sequence.
**Done when:** Phase 10 checklist passes on zsh locally and on a remote Ubuntu host.

### F13 · Fleet health (Phase 12)
**Purpose:** glanceable vitals for every machine, with no agents installed.
**Behaviors:** opt-in per host. A single batched probe runs over the existing
connection (master preferred) every `interval_s`: a POSIX-leaning one-liner
gathering loadavg, mem, root-disk, uptime (Linux-first parse, macOS fallback via
`vm_stat`/`sysctl`; parser tolerant of partial output). Sidebar sparkline = 1-min
load normalized by core count; popover shows CPU load, mem used/total, disk
used/total gauges + uptime. Threshold alerts (load > cores×1.5 for 3 samples, disk
> 90%) fire one rate-limited notification. All polling pauses when the app is
hidden > 5 min and on battery-saver.
**Edge cases:** probe failure ×3 → sparkline replaced by a quiet warn tick, no
spam; hosts without the tools degrade to whatever parsed.
**Done when:** Phase 12 health items pass against a Linux host and probe cost is
invisible in the session.

### F14 · Output triggers & alerts (Phase 12)
**Purpose:** the terminal taps you on the shoulder.
**Behaviors:** rules = regex + scope (global / host / tag) + actions (highlight
match, macOS notify, run snippet, bell) + rate-limit seconds. Built-in starter
rules (disabled by default): `password:` prompt-in-background-tab notify; `panic|
Traceback|FATAL` highlight. Evaluated on the decoded stream in the frontend with a
compiled regex set; per-chunk budget < 1ms (drop evaluation, never data, on overrun
and surface a perf warning). Trigger hits show in a per-session log popover.
**Edge cases:** run-snippet action always requires per-rule "allowed to type into
sessions" consent; regexes are validated on save; catastrophic patterns rejected
by a step-limit check.
**Done when:** a custom rule notifies from a background tab within 1s of the match.

### F15 · Automation & integrations (Phase 13)
**Purpose:** Setu becomes a verb in your system.
**Behaviors:** **Companion CLI** (`setu`, symlinked by the app on first run) talks
over the unix socket: `setu connect <host>` (focuses/creates tab), `setu run
<snippet> --host <h>`, `setu sftp <host>`, `setu list`. **Deep links:** `setu://
connect/<label>`; registered via deep-link plugin. **Raycast:** "Export Raycast
script commands" writes one script per favorite host into a chosen dir. **Quake
terminal:** global hotkey (default ⌥`, configurable) toggles a borderless top-third
drop-down window bound to a designated host or local shell; independent of the main
window. **Deploy-watch:** pick local dir + remote target → rsync-over-ssh on change
(300ms debounce, `.gitignore` respected, `--delete` opt-in, dry-run preview first),
panel shows last sync + per-run file count. **Session recording:** per-pane
start/stop; asciinema v2 `.cast` into the state dir; unmissable status-bar dot
while armed; input is never recorded, only output; off by default, never on
broadcast panes.
**Edge cases:** socket absent (app not running) → CLI prints a launch hint; hotkey
conflicts detected and surfaced; rsync missing → install hint; recording + alt-
screen apps produce valid casts.
**Done when:** Phase 13 automation items pass; `setu connect hermes` from Raycast
lands in a focused pane.

### F16 · AI assist via Claude CLI (Phase 13)
**Purpose:** natural language in, command out — with you always in the loop.
**Behaviors:** feature exists only if `claude` CLI is detected (and can be disabled
in settings). Palette action "Ask: natural language → command" opens the AIPanel:
your prompt + minimal context (OS of target host, cwd, shell) is sent via
`claude -p` one-shot; the suggested command renders with an explanation and an
**Insert** button — inserted at the prompt, **never executed automatically**.
"Explain last output" sends the last command + its captured output (F12) and renders
the explanation in the panel. Redaction pass strips obvious secrets (key/token/
password-shaped strings) before anything is sent; a preview of exactly what will be
sent is one click away.
**Edge cases:** CLI errors surface verbatim in the panel; long outputs truncated to
a head+tail window with a note; feature fully invisible when CLI absent.
**Done when:** both actions work end-to-end and the auto-run prohibition is enforced
in code (no code path from AI output to pty_write without the Insert click + Enter).

### F17 · tmux control mode (Phase X — experimental, flagged)
**Purpose:** native tabs over tmux windows, iTerm2-style.
**Behaviors (v1 scope):** behind `experimental.tmux_control`; "Attach (control
mode)" spawns `tmux -CC attach` and speaks the control-mode protocol: existing
windows appear as native tabs; create/kill/rename window round-trips; pane
mirroring inside a window is **not** attempted in v1 (single active pane per window
rendered). Honest complexity note: this is a protocol client — budget accordingly.
**Done when:** attach/detach cycles are stable against tmux ≥ 3.3 with 5 windows.

### F18 · Theming & appearance (Phase 13)
**Purpose:** yours to reskin without forking.
**Behaviors:** theme = JSON overriding the token set + ANSI palette + glow strength,
dropped in `themes/` (synced); picker with live preview on a sample terminal and
LED row. Ships with **Phosphor** (default, §7), **Basalt & Brass** (the warm
graphite/brass alternative), and **Paper** (light: warm paper `#F3EFE7`, dark ink,
tuned for AA contrast; glow disabled). Per-host accent already covered by hues.
Font picker lists installed monospace fonts with preview; background opacity +
vibrancy + CRT-mode toggles. Theme JSON is documented in `docs/features/F18` with
a commented example.
**Done when:** switching themes live-updates every open terminal, LED, and
component with no hardcoded stragglers (grep proves it).

---

## 10 · Phases

Every phase ships something usable. **Definition of done = every checklist item
demonstrably passing + the Documentation Gate (§6.4) + committed.** The gate is
implicit in every checklist below — treat it as the final unlisted items. Manual QA
is a first-class step: run it, don't skip it.

### Core track — Termius parity

### Phase 0 — Scaffold, shell & open-source spine
**Scope:** `pnpm create tauri-app` (React-TS template) → restructure to
`src/{app,components,features,ipc,state,styles}` and `src-tauri/src/{pty,store,ipc}.rs`
stubs. Tokens file in. Static app shell: sidebar with 3 fake groups/hosts (LEDs in
hollow state), tab bar, empty terminal area, status bar — all from tokens, no
logic. Overlay titlebar with inset traffic lights. **Open-source spine per §6.1:**
LICENSE (Apache-2.0), README skeleton, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT,
CHANGELOG, THIRD_PARTY_NOTICES, issue/PR templates, `docs/` scaffold with
architecture.md seeded from §3, and CI running typecheck · clippy `-D warnings` ·
tests · fmt · `cargo doc` · doc lints. `#![deny(missing_docs)]` and TSDoc ESLint
rules on from the first commit. `CLAUDE.md` and `PLAN.md` committed.
**Acceptance:**
- [ ] `pnpm tauri dev` opens the shell window; layout matches §7 wireframe
- [ ] No hardcoded colors outside `tokens.css` (grep check)
- [ ] CI is green end-to-end, including doc build and doc lints
- [ ] A stranger following README + CONTRIBUTING can reach `pnpm tauri dev` without asking questions
- [ ] ⌘/ collapses sidebar with `--t-med` transition

### Phase 1 — Local terminal MVP (F2)
**Scope:** portable-pty spawning `$SHELL` in a login session; xterm.js pane with
fit/webgl/search/web-links/unicode11 addons; the batched IPC pipeline (§3 perf
requirements); resize propagation; copy/paste basics; multiple local tabs;
close/exit handling.
**Acceptance:**
- [ ] `htop`, `vim`, `tmux` render and resize correctly in a local tab
- [ ] `cat` of a 50 MB file completes without UI freeze; memory returns to baseline
- [ ] Closing a tab reaps the PTY process (verify in Activity Monitor)
- [ ] Unicode + emoji width correct (`echo "देवनागरी 🔱"`)

### Phase 2 — Hosts & SSH sessions (F1, F3, F11)
**Scope:** `hosts.toml` store (Rust) + CRUD via HostEditor drawer; sidebar renders
real data with fuzzy search; connect = `ssh -tt <args>` (or alias when
`source="ssh_config"`), honoring `startup`; keepalive flags; `~/.ssh/config`
importer + Adopt flow; ⌘T quick connect; tab titles/colors; exit-code surfacing
with reconnect prompt.
**Acceptance:**
- [ ] Add a host in UI → appears in `hosts.toml`, survives restart
- [ ] Import shows existing `~/.ssh/config` aliases; connecting to one uses the alias (ProxyJump proven through a jump host)
- [ ] First-connect host-key prompt appears *in the terminal* and works
- [ ] ⌘T → type 3 chars → Enter → prompt on a tailnet host in <2s
- [ ] `startup = "tmux new -A -s main"` attaches on connect

### Phase 3 — Splits, broadcast, restore (F4)
**Scope:** split tree, drag borders, focus routing, ⌥⌘-arrows; broadcast per F4
(arming, fan-out, paste-guard interplay, opt-out, auto-disarm setting); session
restore (reopen tabs/layout for `source="setu"` hosts on launch, opt-in).
**Acceptance:**
- [ ] 2×2 grid of 4 SSH panes; typing `uptime⏎` in broadcast hits all 4
- [ ] Broadcast excludes a deselected pane; toggle off restores normal input
- [ ] Multi-line paste while broadcasting triggers the guarded preview with session count
- [ ] Kill one pane in a split — layout heals, siblings keep running
- [ ] Relaunch app → previous tabs reconnect (when enabled)

### Phase 4 — Design polish & the live board (F1, F2, F11)
**Scope:** full component sweep against §7; **reachability prober** in Rust per
F1/§3 (staggered TCP connects, LED state machine, latency chips from the same
probe, pause-when-hidden, kill switches); ⌘K palette complete per F11 (LED states
in results); **paste guard** per F2; empty/error/loading states; FingerprintDialog;
toasts; app icon (neon LED-bridge glyph on near-black); reduced-motion audit;
focus-ring audit.
**Acceptance:**
- [ ] On app open, a 20-host board fully lights (green/red/hollow) within ~3s, probes visibly staggered in logs
- [ ] Pull a test host's network → its LED turns red within one interval; restore → green
- [ ] Probing pauses after 60s hidden and sweeps immediately on refocus (log evidence)
- [ ] Screenshot review vs §7: tokens, glow discipline (LEDs, active-tab underline, focus ring only), type scale all conform
- [ ] Palette: fuzzy "her" → connect action on hermes as first hit; all §8 actions present
- [ ] Paste guard intercepts multi-line and `curl|sh` pastes with exact-bytes preview
- [ ] `prefers-reduced-motion` disables pulse, transitions, and CRT mode
- [ ] Every interactive element shows a visible `--glow` focus ring via keyboard walk

### Phase 5 — SFTP (F5)
**Scope:** russh+russh-sftp client (auth: agent → identity file; password auth
deferred to Phase 7); known_hosts verification with FingerprintDialog (append on
trust); dual-pane browser per F5 (virtualized lists, transfers queue, ops, chmod,
drag-drop); "Reveal in Cyberduck" escape hatch. ("Follow session cwd" lands with
Phase 10.)
**Acceptance:**
- [ ] Browse remote home on hermes via agent auth; hidden-file toggle works
- [ ] Upload a 200 MB file: live progress, cancel works, partial file cleaned up
- [ ] Unknown host key → dialog with SHA256 fingerprint → trust appends to known_hosts
- [ ] Local⇄remote drag-drop both directions; a 10k-entry dir scrolls at 60fps

### Phase 6 — Snippets & port forwards (F6, F7)
**Scope:** snippets per F6 (drawer, palette, variables, targets, packs); forwards
per F7 (rules, managed `ssh -N` children, health dots, auto-start, port-conflict
helper).
**Acceptance:**
- [ ] Snippet `journalctl -u {{service}} -f` prompts for `service`, runs in pane
- [ ] Run a snippet across 3 hosts as new tabs in one action
- [ ] Toggle `L 8080:localhost:8080` on hermes → curl localhost:8080 works; toggle off → connection refused
- [ ] Occupied local port names the owning process and offers the next free port
- [ ] Forward children die with the app (no orphans in `ps`)

### Phase 7 — Keys, Keychain, mosh, Tailscale (F8, F9)
**Scope:** Keychain integration per F8 (SFTP-only passwords; generate/copy-id/agent
list; hardware-key hint; vault export). Mosh per-host toggle with preflight. Tailnet
section per F9 (LEDs from Tailscale state).
**Acceptance:**
- [ ] Generate ed25519 key → public key copied; ssh-copy-id helper pushes it to a test host in a visible pane; agent lists it
- [ ] SFTP to a password-only host works via Keychain-stored password (Touch ID per Keychain policy)
- [ ] Mosh session survives toggling Wi-Fi off/on
- [ ] Tailnet lists live peers with correct LEDs; one-click connect works; "Adopt as host" promotes a peer; section hides gracefully without the binary

### Phase 8 — Sync & settings (F10)
**Scope:** Settings window (fonts, scrollback, default user, sync remote,
reachability + feature flags); git sync per F10 (status dot, Sync now, conflict
path, secrets lint, snapshots).
**Acceptance:**
- [ ] Point sync at a private GitHub repo → edit a host → Sync now → visible on GitHub; a second checkout reproduces hosts
- [ ] Lint blocks a `password = "hunter2"` line with the offending line shown
- [ ] Settings persist and hot-apply (font size live-updates open terminals)

### Phase 9 — Package & ship (open-source release)
**Scope:** `pnpm tauri build` universal binary; icons; codesign + notarize
(**manual: requires Apple Developer ID** — document the unsigned local path too:
`xattr -dr com.apple.quarantine Setu.app`); optional tauri-plugin-updater fed by
GitHub Releases; a Homebrew tap with a cask (`brew install --cask pandox/tap/setu`);
**release-quality docs pass:** README with screenshots/cast of the board and
terminal, every `docs/features/` page reviewed, CHANGELOG cut for `v1.0.0`,
`RELEASING.md` written; tag and publish the GitHub release.
**Acceptance:**
- [ ] Fresh-machine install via the cask launches and connects
- [ ] App size < 25 MB; cold launch < 1.5s on Apple silicon
- [ ] v1.0.0 GitHub release exists with notes generated from CHANGELOG
- [ ] Docs review: an outsider can discover every core feature from README + docs/ alone

### Advanced track — beyond Termius

### Phase 10 — Semantic terminal (F12)
**Scope:** shell-integration snippet + installers (local rc with diff-confirm;
remote rc with diff-confirm, fenced, reversible); OSC 133/7/52 handlers; gutter
marks; prompt jumps; copy-last-output; re-run-last; live cwd in status bar + SFTP
follow-mode; done-notifications; history DB + palette History section + incognito
controls.
**Acceptance:**
- [ ] Marks/jumps/copy-last-output work on local zsh and remote Ubuntu bash after one-click installs
- [ ] Remote installer shows the exact rc diff first; uninstall removes the fenced block cleanly
- [ ] A `sleep 40` in a background tab fires exactly one macOS notification with duration and exit status
- [ ] Palette History finds a command run yesterday on another host; ⏎ pastes without executing
- [ ] Incognito host records nothing (DB row count proves it); alt-screen apps record nothing
- [ ] Handler cost measured < 1ms per flushed chunk under flood

### Phase 11 — Instant connections & files (F3, F5, F7)
**Scope:** ControlMaster manager (per-host flag, Masters popover, stale-socket
recovery); live forward add/cancel via `-O` on mastered hosts; remote edit-in-editor
with watch-upload and conflict sheet; SFTP rides the master where possible.
**Acceptance:**
- [ ] Second tab to a mastered host lands < 300ms (measured)
- [ ] Masters popover lists the live master; Stop cleanly exits it; stale socket after sleep auto-recovers
- [ ] Live-toggle a forward on a mastered host with zero new ssh processes (`ps` proves it)
- [ ] Edit a remote file locally → save → uploaded; remote-side change triggers the conflict sheet

### Phase 12 — Fleet intelligence (F6, F13, F14)
**Scope:** health probe + sparkline + popover + threshold alerts + battery/hidden
pausing; triggers engine + editor + built-ins + per-session hit log; runbooks
(model, dry-run, runner UI, abort, run log).
**Acceptance:**
- [ ] Health on for hermes: sparkline live; `stress`-induced load crosses threshold → exactly one notification
- [ ] Probe traffic invisible in an interactive session on the same master
- [ ] Custom trigger on `BUILD OK` notifies from a background tab < 1s after match
- [ ] A 3-step runbook across `tag:prod` (2 hosts) dry-runs the full expansion, executes with one confirm gate, and the run log captures per-host output
- [ ] Trigger evaluation stays under the 1ms/chunk budget under flood

### Phase 13 — Automation, AI, themes (F15, F16, F18)
**Scope:** companion CLI + unix socket; `setu://` deep links; Raycast export; quake
window + global hotkey; deploy-watch; session recording; AI assist per F16; theme
JSON system + Basalt & Brass + Paper + font picker + CRT toggle.
**Acceptance:**
- [ ] `setu connect hermes` from Terminal and from a Raycast script both focus/create the right pane
- [ ] ⌥` toggles the quake window over a full-screen app; hotkey rebindable
- [ ] Deploy-watch syncs a saved file < 1s after save; `.gitignore`d files never sync; `--delete` requires the opt-in + dry-run
- [ ] Recording produces a `.cast` that plays in `asciinema play`; the status-bar dot is present the entire time
- [ ] AI: NL→command inserts but never executes (code-path audit in review); Explain-last-error round-trips; both invisible when `claude` CLI is absent
- [ ] Switching among Phosphor / Basalt & Brass / Paper live-updates everything; hardcoded-color grep still clean

### Phase X — tmux control mode (experimental, F17)
Behind `experimental.tmux_control`. Scope and acceptance per F17. Attempt only after
Phase 13; timebox one session for a spike before committing.

---

## 11 · Dependencies (pin on install, keep current)

**npm:** `@tauri-apps/api`, `@tauri-apps/cli`, `react`, `react-dom`, `typescript`,
`vite`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`,
`@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`,
`@xterm/addon-image`, `@xterm/addon-clipboard`, `zustand`, `fuse.js`,
`lucide-react`, `clsx`.
**npm (dev, docs & quality):** `eslint`, `eslint-plugin-tsdoc` (+ a
jsdoc-completeness rule), `prettier`, `vitest`.

**Rust:** `tauri = 2`, `portable-pty`, `russh`, `russh-sftp`, `russh-keys`,
`keyring`, `rusqlite`, `regex`, `notify`, `tokio`, `serde`, `serde_json`, `toml`,
`dirs`, `anyhow`, `thiserror`, `base64`, `uuid`, `tauri-plugin-notification`,
`tauri-plugin-global-shortcut`, `tauri-plugin-deep-link`, optional `window-vibrancy`.

**System tools used via shell-out (detected, never bundled):** `ssh`/`sftp`-suite,
`ssh-keygen`, `mosh`, `tmux`, `tailscale`, `git`, `rsync`, `lsof`, `claude`.

---

## 12 · Risks & mitigations

| Risk | Mitigation |
|---|---|
| IPC throughput on floods (`yes`) | Batch+coalesce (§3); measured in Phase 1; if inadequate, move to raw channels/websocket sidecar |
| WebGL addon quirks on some GPUs | Automatic canvas fallback + setting |
| russh agent auth edge cases | Scope SFTP auth to agent+keyfile first; Cyberduck escape hatch; password auth via Keychain in Phase 7 |
| Orphan `ssh -N` / forward processes | Process-group kill on drop + app-exit sweep; Phases 6/11 check `ps` |
| Reachability probes look like port scans on strict networks | Bare connects only, rate-limited + jittered, per-host/global kill switches, documented in SECURITY.md |
| Neon theme legibility fatigue | Green carries chrome, not text; AA-checked mint inks; glow limited to three uses; Basalt & Brass one click away |
| `deny(missing_docs)` friction | On from commit one so debt never accumulates; doc templates in CONTRIBUTING; escape hatch documented in §5 |
| Shell integration requires rc edits | Diff-confirmed, fenced, reversible installs; every dependent feature degrades to hidden when absent |
| OSC/trigger CPU cost under flood | Hard 1ms/chunk budget with measurement gates in Phases 10/12; evaluation sheds before data does |
| ControlMaster stale sockets (sleep/network change) | `-O check` before reuse; auto-clean + fresh-connect fallback |
| Health polling battery/network cost | Off by default, per-host opt-in, pauses when hidden/on battery, rides existing masters |
| tmux control mode complexity | Experimental flag, spike-first, attach-only v1 scope |
| AI trust/safety | No auto-run by construction; redaction + send-preview; hidden without local CLI |
| Notarization requires paid Apple ID | Unsigned local path documented; signing is a Phase 9 manual step |
| Scope creep toward protocol reimplementation | Decision log §5 is binding; interactive = system ssh, period |

---

## 13 · Backlog (v3+)

Docs site generated from `docs/` (Astro Starlight) once contributors appear;
command autocomplete/ghost-text from history; node_exporter scrape mode for F13;
transfer resume; full tmux pane mirroring; per-host session-recording policies;
Hermes fleet panel (read profiles, one-click `hermes -p <name>` attach); ttyd
companion mode for phone access; iOS someday; collaboration/team features (likely
never — see principles).

---

## 14 · CLAUDE.md starter (copy into `CLAUDE.md`)

```markdown
# Setu — project conventions

## Commands
- Dev: `pnpm tauri dev` · Typecheck: `pnpm tsc --noEmit` · Tests: `pnpm vitest run`
- Rust: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`
- Docs: `cargo doc --no-deps --manifest-path src-tauri/Cargo.toml` (must be warning-free), `pnpm lint` (includes TSDoc rules)
- Format: `pnpm prettier -w .` and `cargo fmt --manifest-path src-tauri/Cargo.toml`

## Working agreement
- PLAN.md is the spec: §9 defines behavior, §10 defines sequencing, §6 defines the
  Documentation Gate. Work strictly one phase at a time; a phase is done only when
  its acceptance checklist AND the Documentation Gate pass with evidence. Update
  PLAN.md §5 when reality diverges — before coding the divergence.
- IPC contract lives in `src/ipc/contract.ts` and its Rust mirror; change both plus
  `docs/dev/ipc.md` in the same commit or not at all.
- All colors/type/spacing come from `src/styles/tokens.css`. No literals in
  components. Glow (`--glow`) appears only on LEDs, the active-tab underline, and
  focus rings.
- Advanced-track features (Phases 10–13) ship behind settings flags, default-off,
  until their phase's checklist is green.
- TypeScript `strict`; no `any` without a `// why:` comment.

## Documentation rules (this project is open source)
- Rust: `#![deny(missing_docs)]` stays on. Every module has a `//!` header; every
  public item has `///` docs with `# Errors` / `# Panics` where relevant and
  doctested `# Examples` where practical. Every `#[tauri::command]` documents
  payload, result, emitted events, and failure modes.
- TypeScript: TSDoc on every exported function, hook, component, and store —
  purpose, `@param`, `@returns`, `@example` for anything non-obvious.
- Each feature touched → its `docs/features/F##` page updated in the same phase.
- Every phase adds a CHANGELOG entry; user-facing changes update README.
- Docs voice: plain language, examples before abstractions, no marketing.

## Hard rules
- Never write secrets to disk, logs, or the repo. Secrets → Keychain (`dev.pandox.setu`) only.
- Never modify `~/.ssh/config` or key files. `known_hosts` may be appended only on
  explicit user trust. Any rc-file install (local or remote) shows the exact diff
  and requires explicit confirmation; installs are fenced and reversible.
- Reachability probes are bare TCP connects: no banners, no auth, rate-limited,
  with global and per-host kill switches.
- PTY/session contents are never logged. history.sqlite and recordings/ never sync.
- AI-suggested commands are never executed by the app — insert-only, user presses Enter.
- Kill child processes (PTYs, `ssh -N` forwards, watchers) on close and app exit; no orphans.

## Commits
- `feat(phase-N): …`, `fix: …`, `docs: …`, `chore: …`. Commit at every green
  checklist; small diffs.
```
