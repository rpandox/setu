---
name: verify
version: 1.0.0
description: "Use before any Setu commit or when the user says /verify, 'run the verify suite', 'run checks', or 'quality gate'. Runs the full PLAN.md verify suite: typecheck, lint (TSDoc), tests, clippy, fmt, doc build, and the no-hardcoded-colors grep — early-exit with remediation hints."
allowed-tools:
  - Bash
  - Read
  - Grep
triggers:
  - verify
  - run the verify suite
  - run checks
  - quality gate
---

# /verify — the full Setu verify suite

## When to invoke

Before every commit; as step 3 of `/phase-review`; any time the user asks for a
health check.

## Steps (run in order; stop at the first failure and report the fix)

Skip any step whose target doesn't exist yet (pre-Phase-0/1 repo) and say so.

1. **Typecheck** — `pnpm tsc --noEmit`
2. **Lint (incl. TSDoc rules)** — `pnpm lint`
3. **Frontend tests** — `pnpm vitest run`
4. **Clippy, warnings are errors** —
   `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
5. **Rust tests (incl. doctests)** —
   `cargo test --manifest-path src-tauri/Cargo.toml`
6. **Format check** —
   `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and
   `pnpm prettier --check .`
7. **Doc build, warning-free** —
   `cargo doc --no-deps --manifest-path src-tauri/Cargo.toml` (any warning = fail;
   `#![deny(missing_docs)]` stays on)
8. **No hardcoded colors** — color literals may exist only in
   `src/styles/tokens.css` (and theme JSON under `themes/`):

   ```bash
   grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' src --include='*.tsx' --include='*.ts' --include='*.css' | grep -v 'src/styles/tokens.css' | grep -v 'src/styles/theme.ts'
   ```

   Zero matches = pass. (`src/styles/theme.ts` derives the ANSI palette from
   tokens and is the one sanctioned bridge.)

## Output

A pass/fail table of the eight steps. On failure: the failing command, the first
error verbatim, and a one-line remediation hint. Green across the board is the
precondition for any `feat(phase-N)` commit.
