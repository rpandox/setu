## What this changes

<!-- Summary, and the PLAN.md phase / feature (F##) it belongs to. -->

## Documentation Gate (PLAN.md §6.4)

- [ ] `cargo doc --no-deps` warning-free; ESLint doc rules clean
- [ ] `docs/features/F##` page updated for every feature touched (or no feature touched)
- [ ] `docs/dev/ipc.md` updated if the IPC contract changed (same commit as `contract.ts` + `ipc.rs`)
- [ ] `CHANGELOG.md` entry for user-visible changes
- [ ] README updated if user-facing behavior or setup changed
- [ ] CI green: typecheck · lint · tests · clippy `-D warnings` · fmt · doc build · color gate

## Evidence

<!-- Command output, screenshots, or test results for the behavior you changed. -->
