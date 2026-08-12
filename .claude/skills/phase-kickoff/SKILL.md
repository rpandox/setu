---
name: phase-kickoff
version: 1.0.0
description: "Use when starting a Setu build phase — the user says /phase-kickoff N, 'start phase N', 'kick off phase N', or 'begin phase N'. Runs the PLAN.md §0.3 kickoff protocol: read the specs, plan in plan mode, no code until approval."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - AskUserQuestion
triggers:
  - phase-kickoff
  - start phase
  - kick off phase
  - begin phase
---

# /phase-kickoff N — start a Setu build phase

## When to invoke

At the beginning of a phase session, before any code. The phase number N comes
from the invocation (e.g. `/phase-kickoff 3`). If N is missing, ask for it.

## Protocol (PLAN.md §0.3, followed exactly)

1. **Read the spec.** Read `PLAN.md` §10 Phase N in full, then every §9 feature
   spec (F-numbers) that the phase references. When a phase and a spec disagree,
   **the spec wins** — note the discrepancy for the §5 decision log.
2. **Check the decision log.** Read PLAN.md §5. If reality has already diverged
   from the plan (from a previous session), factor the logged decision in.
3. **Enter plan mode** (or, if already in plan mode, proceed). Propose, in order:
   - the implementation order within the phase,
   - the exact files to create or touch,
   - the IPC changes (`src/ipc/contract.ts` + Rust mirror + `docs/dev/ipc.md` — all
     three in the same commit or not at all),
   - the documentation to write or update (which `docs/features/F##` pages,
     CHANGELOG entry, README impact),
   - the **top three risks** for this phase.
4. **Do not write code until the plan is approved.**
5. After approval: implement **Phase N only — nothing from later phases**.
   Advanced-track features ship behind default-off settings flags.
6. Stop at the acceptance checklist. Demonstrate each item with evidence
   (command output, screenshot description, or test result), including every
   item of the Documentation Gate (§6.4). Then hand off to `/phase-review N`.

## Hard reminders

- One phase per session. If asked to pull in later-phase work, decline and cite §0.5.
- If reality diverges from the plan mid-phase, update PLAN.md §5 **before** coding
  the divergence.
- All colors/type/spacing from `src/styles/tokens.css` — no literals in components.
