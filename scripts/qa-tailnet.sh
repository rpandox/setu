#!/bin/bash
# The manual half of the F9 tailnet acceptance walk (PLAN.md §10
# Phase 7). Needs a real tailnet: the tailscale CLI logged in, at least
# one online peer and (ideally) one offline peer.
#
#   scripts/qa-tailnet.sh    # prints the click-by-click walk
set -euo pipefail

if command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI: $(command -v tailscale)"
elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  echo "tailscale CLI: inside Tailscale.app (the app finds it there too)"
else
  echo "tailscale CLI not found — the walk's last item (graceful hide)"
  echo "is the only one you can do right now."
fi

cat <<'WALK'
── F9 tailnet — GUI walk ────────────────────────────────────────────────

Live peers & LEDs
  1. Open Setu with Tailscale running → the sidebar grows a Tailnet
     section within a poll (≤30s; instant on launch).
  2. LEDs mirror `tailscale status` — online peers solid green, offline
     peers dimmed with "offline — last seen …". No reachability probes
     hit these rows (watch: LEDs match Tailscale even for peers whose
     ssh port is firewalled).
  3. A peer that duplicates an existing host's hostname does NOT appear
     twice — the host row wears the small `ts` badge instead.

One-click connect
  4. Click an online peer → a tab opens running ssh to its MagicDNS
     name as the default tailnet user ([tailnet] default_user in
     settings.toml; $USER when unset). A ts-ssh-badged peer connects
     key-free.
  5. ⌘T → type the peer's name → it ranks with your hosts and connects
     the same way.

Adopt & ping
  6. Hover a peer → folder icon ("Adopt as host") → the peer becomes a
     normal editable host in hosts.toml (MagicDNS name as hostname),
     the tailnet row collapses into it with the `ts` badge, and the
     prober now owns its LED.
  7. Hover an offline peer → radio icon ("Ping to wake") → a toast with
     tailscale ping's verdict.

Graceful hide
  8. Quit Setu, run `tailscale down` (or rename the binary), reopen →
     NO Tailnet section, no errors anywhere. `tailscale up` + a poll
     brings it back.

Screenshots for the docs pages while you're here:
  docs/assets/f09-tailnet.png   (the Tailnet section, online + offline)
──────────────────────────────────────────────────────────────────────────
WALK
