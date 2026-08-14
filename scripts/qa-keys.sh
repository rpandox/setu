#!/bin/bash
# The manual half of the F8 keys/Keychain acceptance walk (PLAN.md §10
# Phase 7). The machine-checkable half already runs in `cargo test`:
# keygen (PTY passphrase driver), keychain round-trip (mock store), the
# SFTP passphrase rung (live e2e against a throwaway sshd).
#
#   scripts/qa-keys.sh    # prints the click-by-click walk
#
# Needs: a real test host you can ssh to (password-capable for item 2),
# and `mosh` installed locally for the mosh leg.
set -euo pipefail

cat <<'WALK'
── F8 keys & Keychain — GUI walk ────────────────────────────────────────

Item 1 · generate → copy-id → agent
  1. ⌘K → "Manage SSH keys". The Agent section lists your loaded keys
     (or the guidance banner when no agent is reachable).
  2. Generate: path ~/.ssh/id_setu_qa, a passphrase, comment "setu-qa".
     → public key block appears; "Copy public key" toasts.
     → `ps aux | grep ssh-keygen` during generation must NEVER show the
       passphrase (it goes through a hidden PTY).
  3. Install on a host: pick your test host, Run in terminal.
     → a NEW local tab opens with `ssh-copy-id -i … user@host` typed and
       running — answer its prompts in the pane (never hidden).
  4. `ssh-add ~/.ssh/id_setu_qa` in any terminal, Refresh in the panel
     → the key lists with its SHA256 fingerprint.

Item 2 · SFTP password via Keychain (needs a password-only host)
  1. Host editor → SFTP password row → Store one. Toast confirms; the
     row flips to "Stored in Keychain · Clear".
  2. ⇧⌘S on a session to that host → SFTP connects (macOS may ask for
     Keychain authorization — Touch ID per your policy).
  3. Clear the password, reconnect → the Secret prompt dialog appears;
     Store & connect → connected, and the entry is back in Keychain
     (`security find-generic-password -s dev.pandox.setu` to verify —
     never printed by the app).

Item 3 · mosh survives Wi-Fi off/on
  1. Host editor → "Prefer mosh" on (the inline hint fires only if mosh
     is missing). Connect the host — the tab runs mosh.
  2. Toggle Wi-Fi off, wait ~10s, toggle on.
     → the session resumes by itself; type immediately — predictive
       echo bridges the gap. An ssh session would have died.
  3. Uninstall check: `brew unlink mosh` (or rename the binary), then
     connect → a toast says mosh isn't installed; NO tab opens, and it
     never silently falls back to ssh. `brew link mosh` restores.

Vault
  1. Keys panel → Vault: passphrase twice, Export vault… → pick a path.
  2. `age -d setu-vault.tar.age | tar -t` lists setu-config/* and NO
     .git entries; without the secrets toggle there is no
     keychain-secrets.toml. Re-export with the toggle → it appears
     (inside the encrypted stream only).

Screenshots for the docs pages while you're here:
  docs/assets/f08-keys-panel.png   (the Keys panel, agent + generate)
──────────────────────────────────────────────────────────────────────────
WALK
