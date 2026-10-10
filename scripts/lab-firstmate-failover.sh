#!/usr/bin/env bash
# Real Herdr/Codex recovery test. The helpers own isolation and the fleet tripwire.
set -eu
. "$(dirname "$0")/lab-env.sh"
ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
LAB_HOME_HELPER="$FM_VENDOR/bin/fm-lab-home.sh"
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-handoff-filing)
FM_HOME="$ROOT/test-results/firstmate-failover-$HERDR_LAB_SESSION"
LAB_TMUX_DIR=
cleanup() {
  original=$?
  trap - EXIT
  if [ -n "$LAB_TMUX_DIR" ]; then TMUX_TMPDIR="$LAB_TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true; fi
  if [ -f "$FM_HOME/.fm-lab-home" ]; then "$LAB_HOME_HELPER" teardown "$FM_HOME" || original=1; fi
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || original=1
  rm -f "$FM_HOME/codex/auth.json" "$FM_HOME/codex-2/auth.json"
  exit "$original"
}
trap cleanup EXIT
"$LAB_HOME_HELPER" create "$FM_HOME" >/dev/null
LAB_TMUX_DIR=$("$LAB_HOME_HELPER" tmux-dir "$FM_HOME")
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
export HERDR_LAB_HELPER HERDR_LAB_SESSION FM_HOME
export JOYRIDE_HOME="$FM_HOME" JOYRIDE_RUNTIME="$FM_HOME/joyride" JOYRIDE_TEST=1 JOYRIDE_FIRSTMATE_REAL=1
export JOYRIDE_URL=http://127.0.0.1:4329 JOYRIDE_INTERNAL=1 JOYRIDE_FAKE_MODELS=1
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
export FM_BACKEND=herdr FM_PROCEVENT_CLAIM_ROOT="$FM_HOME/procevent" FM_CODEX_WATCH_CHECKPOINT=5
export TASKS_AXI_BACKEND=markdown
cd "$ROOT"
node_modules/.bin/tsx scripts/lab-firstmate-failover.ts
