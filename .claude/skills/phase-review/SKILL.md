---
name: phase-review
version: 1.0.0
description: "Use when finishing a Setu build phase — the user says /phase-review N, 'review phase N', 'close out phase N', or 'commit phase N'. Runs the PLAN.md §0.4 review + commit gate: checklist walk with evidence, Documentation Gate, verify suite, then the feat(phase-N) commit."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - AskUserQuestion
triggers:
  - phase-review
  - review phase
  - close out phase
  - commit phase
---

# /phase-review N — review + commit gate for a Setu phase

## When to invoke

At the end of a phase, when implementation looks complete. N comes from the
invocation; if missing, ask.

## Protocol (PLAN.md §0.4, followed exactly)

1. **Walk the acceptance checklist** for Phase N (PLAN.md §10) item by item.
   For each item, show concrete evidence: command output, test result, or a
   described screenshot. An item without evidence is not done.
2. **Walk the Documentation Gate (§6.4)** the same way:
   - `cargo doc --no-deps` warning-free; ESLint doc rules clean.
   - `docs/features/F##` page created/updated for every feature touched
     (keyboard shortcuts and config keys shown, not described).
   - `docs/dev/ipc.md` updated if `src/ipc/contract.ts` changed.
   - `CHANGELOG.md` has the phase's entry.
   - README updated if user-facing behavior/setup changed; visual features have
     a screenshot or `.cast` referenced from their docs page.
3. **Run the full verify suite** — invoke `/verify` (or run its steps). All green.
4. **Update PLAN.md §5** if any decision changed during the phase. The log is the
   memory between sessions — write the divergence, the why, and the escape hatch.
5. **Commit** as `feat(phase-N): <summary>` — small, reviewable diff. Do not use
   gstack `/ship` for phase commits (see CLAUDE.md).

## Failure handling

If any checklist or gate item fails: stop the walk, list every failing item with
its remediation, fix, and restart the walk from the top. Never commit with a red item.
