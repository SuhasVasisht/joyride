#!/bin/sh
# Full e2e suite: one UI build, then every spec file in its OWN sandbox daemon
# (own port, own /tmp/joyride-e2e-<port>), up to E2E_SPEC_WORKERS in parallel (default 4).
#   scripts/e2e-all.sh [base-port]   (default 4420; uses base..base+N)
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
BASE="${1:-4420}"
OUT="dist/ui-e2e"
WORKERS="${E2E_SPEC_WORKERS:-4}"
case "$WORKERS" in ''|*[!0-9]*|0) echo "E2E_SPEC_WORKERS must be a positive integer" >&2; exit 1 ;; esac
JOYRIDE_UI_OUT="$OUT" node_modules/.bin/vite build --logLevel error || exit 1
mkdir -p test-results
: > test-results/e2e-all.txt
i=0; pids=""; fail=0
for spec in tests/e2e/*.spec.ts; do
  port=$((BASE + i)); i=$((i + 1))
  (
    E2E_PORT="$port" E2E_UI_DIR="$OUT" node_modules/.bin/playwright test "$spec" --reporter=line > "test-results/e2e-$port.log" 2>&1
    code=$?
    printf "%s %s %s\n" "$([ $code -eq 0 ] && echo PASS || echo FAIL)" "$spec" "$(grep -Eo '[0-9]+ (passed|failed|flaky|skipped)' "test-results/e2e-$port.log" | tr '\n' ' ')" >> test-results/e2e-all.txt
  ) &
  pids="$pids $!"
  if [ $((i % WORKERS)) -eq 0 ]; then for p in $pids; do wait $p; done; pids=""; fi
done
for p in $pids; do wait $p; done
sort test-results/e2e-all.txt
grep -q '^FAIL' test-results/e2e-all.txt && exit 1 || exit 0
