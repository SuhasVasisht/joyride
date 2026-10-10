#!/usr/bin/env bash
set -eu
. "$(dirname "$0")/lab-env.sh"
TASK_ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
LAB_HOME_HELPER="$FM_VENDOR/bin/fm-lab-home.sh"
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-firstmate-chat-resume)
FM_HOME="$TASK_ROOT/test-results/chat-resume/$HERDR_LAB_SESSION"
LAB_TMUX_DIR=
cleanup() {
  original=$?
  trap - EXIT
  if [ -n "$LAB_TMUX_DIR" ]; then TMUX_TMPDIR="$LAB_TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true; fi
  if [ -f "$FM_HOME/.fm-lab-home" ]; then "$LAB_HOME_HELPER" teardown "$FM_HOME" || original=1; fi
  if "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION"; then
    echo 'Guarded teardown passed; default-session fleet tripwire preserved.'
  else original=1; fi
  rm -f "$FM_HOME/codex/auth.json"
  exit "$original"
}
trap cleanup EXIT
if lsof -nP -iTCP:4326 -sTCP:LISTEN >/dev/null; then echo '4326 is occupied; refusing lab' >&2; exit 1; fi
"$LAB_HOME_HELPER" create "$FM_HOME" >/dev/null
LAB_TMUX_DIR=$("$LAB_HOME_HELPER" tmux-dir "$FM_HOME")
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
export HERDR_LAB_HELPER HERDR_LAB_SESSION FM_HOME LAB_TMUX_DIR
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
export JOYRIDE_INTERNAL=1 JOYRIDE_FAKE_MODELS=1 JOYRIDE_TEST=1
export CHROME_DEVTOOLS_AXI_SESSION="jr-chat-$HERDR_LAB_SESSION"
export CHROME_DEVTOOLS_AXI_USER_DATA_DIR="$FM_HOME/chrome"
cd "$TASK_ROOT"
node_modules/.bin/tsx scripts/lab-firstmate-chat-resume.ts
