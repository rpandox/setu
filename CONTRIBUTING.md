# Contributing to Setu

Thanks for looking under the hood. This project is built in the open, one
plan phase at a time, with documentation treated as part of the code.

## Dev setup

1. Install the prerequisites from the [README](README.md#build-from-source)
   (Rust stable, Node 20+, pnpm, Xcode CLT). If `cargo` isn't found, add
   `~/.cargo/bin` to your `PATH` — non-interactive shells often miss it.
2. `pnpm install`
3. `pnpm tauri dev` — Rust core + app window with frontend hot reload.

## How this repo works

[PLAN.md](PLAN.md) is the spec. §9 defines feature behavior, §10 defines the
phase sequence, §6 defines the Documentation Gate. Work lands one phase at a
time; a phase is done only when its acceptance checklist and the Documentation
Gate pass with evidence. The decision log (§5) records every divergence from
the plan — check it before assuming the plan text is current.

## Quality gates

Run the full verify suite before pushing; CI runs exactly the same steps:

```sh
pnpm tsc --noEmit                                                  # typecheck
pnpm lint                                                          # ESLint incl. doc rules
pnpm vitest run                                                    # frontend tests
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings   # Rust lints
cargo test --manifest-path src-tauri/Cargo.toml                    # Rust tests
cargo fmt --manifest-path src-tauri/Cargo.toml --check             # Rust format
RUSTDOCFLAGS="-D warnings" cargo doc --no-deps \
  --manifest-path src-tauri/Cargo.toml                             # doc build
bash scripts/check-colors.sh                                       # token discipline
```

Format with `pnpm prettier -w .` and
`cargo fmt --manifest-path src-tauri/Cargo.toml`.

## Style rules

- **Colors, type, spacing come from `src/styles/tokens.css`.** No literals in
  components — CI greps for them. Glow (`--glow`) appears only on LEDs, the
  active tab underline, and focus rings.
- TypeScript is `strict`; no `any` without a `// why:` comment.
- Interface writing: sentence case, plain verbs, active voice.

## The Documentation Gate

Undocumented code is unfinished code. Every PR must keep these green
(PLAN.md §6.4):

1. `cargo doc --no-deps` warning-free; ESLint documentation rules clean.
   - Rust: every module has a `//!` header; every public item has `///` docs
     with `# Errors` / `# Panics` where relevant. Every `#[tauri::command]`
     documents payload, result, emitted events, and failure modes.
   - TypeScript: TSDoc on every exported function, hook, component, and store.
2. The `docs/features/F##` page for every feature touched is updated —
   including keyboard shortcuts and config keys.
3. `docs/dev/ipc.md` updated in the same commit as any IPC contract change
   (the contract triplet: `src/ipc/contract.ts` + `src-tauri/src/ipc.rs` +
   `docs/dev/ipc.md` change together or not at all).
4. `CHANGELOG.md` gets an entry for user-visible changes.
5. README updated when user-facing behavior or setup changes.
6. CI green end-to-end.

Docs voice: plain language, second person, examples before abstractions, no
marketing. Answer in order: what is it, how do I use it, what can go wrong.

## Commits

`feat(phase-N): …`, `fix: …`, `docs: …`, `chore: …` — small diffs, commit at
every green checklist.

## Hard rules (non-negotiable)

- Never write secrets to disk, logs, or the repo — secrets live in the macOS
  Keychain only.
- Never modify `~/.ssh/config` or key files. `known_hosts` may be appended
  only on explicit user trust.
- PTY/session contents are never logged.
- AI-suggested commands are never executed by the app — insert-only.
- Kill all child processes on close and app exit; no orphans.

See [SECURITY.md](SECURITY.md) for the full security model.
