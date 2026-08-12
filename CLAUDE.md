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

## Project skills (in `.claude/skills/`)
- `/phase-kickoff N` — start Phase N: reads PLAN.md §10 Phase N + its §9 specs,
  enters plan mode, proposes files/IPC/docs/risks. No code before approval.
- `/phase-review N` — end Phase N: walks the acceptance checklist and the
  Documentation Gate (§6.4) with evidence, runs `/verify`, updates §5 if diverged,
  commits `feat(phase-N): <summary>`.
- `/verify` — full verify suite: typecheck → lint (TSDoc) → vitest → clippy →
  cargo test → fmt check → cargo doc → no-hardcoded-colors grep.
- `/doc-gate` — Documentation Gate §6.4 checks only (usable mid-phase).

## Phase commits vs gstack
Phase commits follow PLAN.md §0.4 (`feat(phase-N): …` at the green checklist),
made directly — do NOT use gstack `/ship` for phase commits (it owns its own
squash/version/PR pipeline) and do NOT enable gstack continuous checkpoint mode
in this repo (auto-WIP commits pollute the clean phase history).
