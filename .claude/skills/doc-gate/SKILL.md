---
name: doc-gate
version: 1.0.0
description: "Use when the user says /doc-gate, 'check docs', 'doc gate', or 'documentation check' — or mid-phase to see what documentation debt exists before the phase review. Walks the PLAN.md §6.4 Documentation Gate standalone."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
triggers:
  - doc-gate
  - check docs
  - documentation check
---

# /doc-gate — Documentation Gate (§6.4), standalone

## When to invoke

Mid-phase to surface documentation debt early, or any time docs completeness is
in question. (`/phase-review` runs this walk as its step 2.)

## Checks (report each as pass / fail / n-a with evidence)

1. **Rust docs clean** — `cargo doc --no-deps --manifest-path src-tauri/Cargo.toml`
   produces zero warnings.
2. **TS doc lints clean** — `pnpm lint` passes (TSDoc/ESLint doc rules).
3. **Feature pages current** — for every feature touched in the working diff
   (`git diff --name-only` against the last phase commit), the matching
   `docs/features/F##-*.md` page exists and reflects the change: keyboard
   shortcuts and config keys shown, not described.
4. **IPC docs in lockstep** — if `src/ipc/contract.ts` changed in the diff,
   `docs/dev/ipc.md` changed with it (same commit rule).
5. **CHANGELOG entry** — `CHANGELOG.md` has an entry for the current phase
   (Keep a Changelog format; user-visible changes and breaking notes).
6. **README currency** — if user-facing behavior or setup changed, README
   reflects it; visual features reference a screenshot or `.cast`.

## Output

The six checks as a table with evidence (command output or file path + line).
For every fail: the exact file to create/update and what's missing. Doc debt
found here is fixed *in the phase* — documentation is never batched "later"
(PLAN.md §0.5: undocumented code is unfinished code).
