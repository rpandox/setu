#!/bin/bash
# The manual half of the F7 forwards acceptance walk (PLAN.md §10 Phase 6),
# against the same throwaway localhost sshd as the SFTP QA harness.
#
#   scripts/qa-forwards.sh [port]     # default 2222; Ctrl-C stops it
#
# It starts the qa-sftp-server sshd (fresh host key, pubkey as you), plus a
# tiny local web server the L-forward can point at so `curl` has something
# real to fetch, then prints the click-by-click walk.
set -euo pipefail

PORT="${1:-2222}"
WEB_PORT=9800
DIR="$HOME/.setu-qa-sftp"

# The forward children run BatchMode=yes and cannot prompt for the host
# key: trust it once up front (connect a terminal once in the app, or let
# this script append the known_hosts line for you).
if ! grep -qs "\[127.0.0.1\]:$PORT" "$HOME/.ssh/known_hosts" 2>/dev/null; then
  if [ -f "$DIR/host_key.pub" ]; then
    echo "[127.0.0.1]:$PORT $(cut -d' ' -f1,2 "$DIR/host_key.pub")" >> "$HOME/.ssh/known_hosts"
    echo "trusted the QA host key in ~/.ssh/known_hosts (remove later with:"
    echo "  ssh-keygen -R '[127.0.0.1]:$PORT')"
  fi
fi

python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
WEB_PID=$!
trap 'kill $WEB_PID 2>/dev/null || true' EXIT

cat <<EOF
── F7 acceptance walk ──────────────────────────────────────────
  A web server is on 127.0.0.1:$WEB_PORT (this shell's files).

  1. In Setu, on the sftp-qa host (127.0.0.1:$PORT), open the
     host editor and add a forward:  L  8080:localhost:$WEB_PORT
  2. Status bar → "⇌ 0 fwd" chip → Start the rule. Dot goes green.
       curl localhost:8080           # → a directory listing = WORKS
  3. Stop the rule.
       curl localhost:8080           # → connection refused = OFF
  4. Conflict helper: while the rule runs, add + start another rule
     L 8080:localhost:$WEB_PORT on a second host (or hold the port:
       python3 -m http.server 8080 &
     ) → the popover names the owner and offers "Use 8081".
  5. Auto-start: mark the rule "auto", disconnect and reconnect the
     host's terminal tab → the dot comes back green by itself.
  6. No orphans: quit Setu, then
       ps aww | grep 'ssh -N'        # → nothing
────────────────────────────────────────────────────────────────
EOF

exec "$(dirname "$0")/qa-sftp-server.sh" "$PORT"
