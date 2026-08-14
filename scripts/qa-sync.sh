#!/bin/bash
# The manual half of the F10 sync acceptance walk (PLAN.md §10 Phase 8).
# Sets up a throwaway local bare remote so the whole walk works without
# touching GitHub; the real acceptance run swaps in a private GitHub
# repo for step 2 (the "visible on GitHub" item).
#
#   scripts/qa-sync.sh          # creates the remote, prints the walk
#   scripts/qa-sync.sh clean    # removes the throwaway remote + checkout
set -euo pipefail

REMOTE_DIR="${TMPDIR:-/tmp}/setu-qa-sync-remote.git"
CHECKOUT_DIR="${TMPDIR:-/tmp}/setu-qa-sync-checkout"

if [ "${1:-}" = "clean" ]; then
  rm -rf "$REMOTE_DIR" "$CHECKOUT_DIR"
  echo "removed $REMOTE_DIR and $CHECKOUT_DIR"
  exit 0
fi

command -v git >/dev/null 2>&1 || {
  echo "git not found — install the Xcode command line tools first"
  exit 1
}

if [ ! -d "$REMOTE_DIR" ]; then
  git init --bare --quiet "$REMOTE_DIR"
fi
echo "throwaway remote: $REMOTE_DIR"
echo "second checkout : $CHECKOUT_DIR (created in step 4)"

cat <<WALK
── F10 sync & settings — GUI walk ───────────────────────────────────────

Settings window & hot-apply (acceptance: persist + live font)
  1. ⌘, opens the Settings window (second window, Phosphor chrome, no
     native widgets). Terminal → set font size 13 → 17 → Save with two
     terminals open: BOTH resize immediately, no restart. Quit, relaunch,
     reopen ⌘,: 17 persisted (settings.toml).
  2. Reachability → flip "Probe reachability" off → Save → LEDs go
     hollow within a sweep. Flip back on → board relights.

Sync now (acceptance: remote → visible → second checkout reproduces)
  3. Settings → Sync → remote: $REMOTE_DIR → Set remote →
     footer dot goes amber ("commits to push"). Click Sync now →
     toast "Synced", dot green, status bar shows "sync ✓".
     (Real acceptance: use a private GitHub repo URL instead and
     verify the commit on github.com.)
  4. Edit a host (rename its label) → dot amber → Sync now → then:
       git clone "$REMOTE_DIR" "$CHECKOUT_DIR"
       grep -n 'label' "$CHECKOUT_DIR/hosts.toml"
     The renamed label is there — a second checkout reproduces hosts.

Secrets lint (acceptance: password blocked, line shown)
  5. echo 'password = "hunter2"' >> ~/.config/setu/hosts.toml
     → Sync now → toast "Sync refused", footer popover shows
     hosts.toml:<line> with the exact 'password = "hunter2"' text.
     Nothing was committed (git -C ~/.config/setu log unchanged).
     Remove the line; sync goes green again.

Conflict path
  6. In $CHECKOUT_DIR: edit the same host line, commit, push.
     Locally: edit that line differently → Sync now → dot red,
     popover lists hosts.toml + "nothing is resolved for you" hint,
     Open in Finder shows the markers. Cancel sync → pre-sync state,
     dot back to amber. Sync again → same conflict → this time fix
     the markers in an editor → Sync now → green.

Snapshots
  7. Settings → Snapshots → Snapshot now → "Saved …/snapshots/
     setu-config-<ts>.tar.gz". tar -tzf it: hosts/snippets/settings
     inside, no .git. keep=10 honored on repeat runs.

Cleanup:  scripts/qa-sync.sh clean   (and remove the remote from
Settings → Sync if you pointed the app at the throwaway path)
WALK
