//! Plain-TOML persistence for hosts, snippets, runbooks, and settings.
//!
//! Setu's sync unit is `~/.config/setu/` — human-diffable TOML files that are
//! safe to put in a git repo because the schema forbids secret fields
//! (`PLAN.md` §4). Secrets live only in the macOS Keychain. This module will
//! own reading, validating, and atomically writing those files.
//!
//! Empty in Phase 0; Phase 2 lands `hosts.toml` CRUD here.
