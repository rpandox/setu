#!/usr/bin/env bash
# Enforce the token discipline from PLAN.md §7 / CLAUDE.md: every color in the
# frontend comes from src/styles/tokens.css. Any hex/rgb/hsl literal anywhere
# else under src/ fails the build.
set -euo pipefail

cd "$(dirname "$0")/.."

# tokens.css defines the colors; tokens.test.ts matches them by design.
matches=$(grep -rnE \
  --include='*.css' --include='*.ts' --include='*.tsx' \
  '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(' \
  src | grep -vE '^src/styles/tokens\.(css|test\.ts):' || true)

if [ -n "$matches" ]; then
  echo "$matches"
  echo
  echo "FAIL: hardcoded colors found outside src/styles/tokens.css — use var(--…) tokens."
  exit 1
fi

echo "OK: no hardcoded colors outside src/styles/tokens.css"
