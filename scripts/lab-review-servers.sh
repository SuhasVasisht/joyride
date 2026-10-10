#!/usr/bin/env bash
# Safe local servers only, isolated from the captain's Herdr session.
set -eu
. "$(dirname "$0")/lab-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HELPER="${FM_HERDR_LAB_HELPER:-$FM_VENDOR/bin/fm-herdr-lab.sh}"
PORT="${1:-4406}"
case "$PORT" in 440[1-9]) ;; *) echo 'Use an assigned e2e port in 4401–4409.' >&2; exit 2;; esac
node --input-type=module - <<'JS'
import net from 'node:net';
for (const port of [4329, 4325]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Lab port ${port} is occupied. Preserve its listener and obtain a free assignment.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
JS
export FM_HERDR_LAB_STATE_DIR="$ROOT/.joyride/herdr-lab"
SESSION=$("$HELPER" name jr-review-servers)
cleanup() {
  local rc=$?
  "$HELPER" teardown "$SESSION" || rc=1
  exit "$rc"
}
trap cleanup EXIT
"$HELPER" provision "$SESSION"
export E2E_LAB_HERDR_SOCKET="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"
export E2E_REVIEW_SERVERS_LAB=1
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
"$ROOT/scripts/e2e.sh" "$PORT" tests/e2e/review-servers.spec.ts --workers=1
