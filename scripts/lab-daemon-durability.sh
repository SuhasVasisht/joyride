#!/usr/bin/env bash
# Real Herdr lifecycle proof, restricted to a guarded named session.
set -euo pipefail
. "$(dirname "$0")/lab-env.sh"
HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-ui-durable)
export FM_HERDR_LAB_STATE_DIR="$PWD/.joyride/herdr-lab-state"
cleanup() {
  local result=$?
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || result=1
  exit "$result"
}
trap cleanup EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" status --json
HERDR_LAB_SESSION="$HERDR_LAB_SESSION" HERDR_LAB_HELPER="$HERDR_LAB_HELPER" node_modules/.bin/tsx scripts/lab-daemon-durability.ts
