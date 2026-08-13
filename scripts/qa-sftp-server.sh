#!/bin/bash
# A throwaway local SFTP server for QA'ing the F5 panel without a remote
# host: unprivileged sshd on 127.0.0.1, fresh host key, pubkey-only,
# logging in as *you*. The same harness the `live_sftp` integration suite
# uses, packaged for the GUI walk.
#
#   scripts/qa-sftp-server.sh [port]     # default 2222; Ctrl-C stops it
#
# It prints the host-record values to enter in Setu. The first panel
# connect shows the fingerprint dialog (the key is brand new) — that IS
# the trust-flow acceptance demo. Afterwards, remove the appended trust
# line with:  ssh-keygen -R '[127.0.0.1]:<port>'
set -euo pipefail

PORT="${1:-2222}"
DIR="$HOME/.setu-qa-sftp"
mkdir -p "$DIR"

[ -f "$DIR/host_key" ] || ssh-keygen -q -t ed25519 -N "" -f "$DIR/host_key"
[ -f "$DIR/user_key" ] || ssh-keygen -q -t ed25519 -N "" -f "$DIR/user_key"
cp "$DIR/user_key.pub" "$DIR/authorized_keys"
chmod 600 "$DIR/authorized_keys"

cat > "$DIR/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $DIR/host_key
PidFile $DIR/sshd.pid
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile $DIR/authorized_keys
StrictModes no
LogLevel VERBOSE
Subsystem sftp /usr/libexec/sftp-server
EOF

# The panel's auth ladder tries the agent first: hold the QA key there.
if ! ssh-add "$DIR/user_key" 2>/dev/null; then
  echo "warn: couldn't add the QA key to your ssh-agent — set the Setu"
  echo "      host's identity to $DIR/user_key instead of \"agent\"."
fi

echo "── Setu host record ────────────────────────────────────────"
echo "  label      sftp-qa"
echo "  hostname   127.0.0.1"
echo "  port       $PORT"
echo "  user       $USER"
echo "  identity   agent   (or $DIR/user_key)"
echo "── acceptance helpers ──────────────────────────────────────"
echo "  fingerprint to compare in the dialog:"
ssh-keygen -lf "$DIR/host_key.pub" | sed 's/^/    /'
echo "  200 MB test file:   mkfile -n 200m ~/Desktop/upload-200m.bin"
echo "  10k-entry dir:      mkdir ~/sftp-10k && cd ~/sftp-10k && seq 1 10000 | xargs touch"
echo "  undo the trust:     ssh-keygen -R '[127.0.0.1]:$PORT'"
echo "────────────────────────────────────────────────────────────"
echo "sshd listening on 127.0.0.1:$PORT — Ctrl-C to stop"

exec /usr/sbin/sshd -f "$DIR/sshd_config" -D -e
