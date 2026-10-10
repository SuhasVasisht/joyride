#!/bin/sh
# Isolated e2e run: own UI build dir, own port, own sandbox (/tmp/joyride-e2e-<port>).
#   scripts/e2e.sh <port> [playwright args/specs...]
# Parallel agents must use different ports (4399 default; 4401-4409 for agents).
set -e
PORT="${1:-4399}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
OUT="dist/ui-$PORT"
JOYRIDE_UI_OUT="$OUT" node_modules/.bin/vite build --logLevel error
E2E_PORT="$PORT" E2E_UI_DIR="$OUT" node_modules/.bin/playwright test "$@"
