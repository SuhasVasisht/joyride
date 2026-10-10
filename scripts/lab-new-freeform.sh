#!/usr/bin/env bash
# One real Haiku job through New, on a guarded named Herdr session and a private Firstmate home.
set -eu
. "$(dirname "$0")/lab-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
PORT="${1:-4327}"
case "$PORT" in 432[0-9]) ;; *) echo 'Use a private preview port 4320-4329.' >&2; exit 2;; esac
HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
LAB_HOME_HELPER="$FM_VENDOR/bin/fm-lab-home.sh"
WORK=$(mktemp -d "$ROOT/.joyride/new-lab.XXXXXX")
FM_HOME="$WORK/firstmate"
LAB_TMUX_DIR=''
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-new-freeform)
cleanup() {
  local rc=$?
  if [ -n "$LAB_TMUX_DIR" ]; then TMUX_TMPDIR="$LAB_TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true; fi
  if [ -f "$FM_HOME/.fm-lab-home" ]; then "$LAB_HOME_HELPER" teardown "$FM_HOME" || rc=1; fi
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || rc=1
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
"$LAB_HOME_HELPER" create "$FM_HOME" >/dev/null
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
SOCKET="$HOME/.config/herdr/sessions/$HERDR_LAB_SESSION/herdr.sock"
CFG="$WORK/claude"
mkdir -p "$CFG/projects" "$WORK/project"
# Private config and transcript store; no real config is written.
node - "$CFG" "$WORK/project" <<'JS'
const fs = require('fs'), [cfg, project] = process.argv.slice(2);
const seen = { hasCompletedOnboarding:true, lastOnboardingVersion:'2.1.289', autoUpdates:false, numStartups:5,
  hasSeenTasksHint:true, hasSeenAutoDefaultNudge:true, hasResetAutoModeOptInForDefaultOffer:true,
  hasSeenAutoModeEntryWarning:true, effortCalloutDismissed:true, effortCalloutV2Dismissed:true,
  remoteDialogSeen:true, opusProMigrationComplete:true, sonnet1m45MigrationComplete:true,
  unpinOpus47LaunchEffort:true, unpinOpus48LaunchEffort:true, unpinFable5LaunchEffort:true,
  officialMarketplaceAutoInstallAttempted:true, autoPermissionsNotificationCount:3,
  remoteControlUpsellSeenCount:3, pushNotifUpsellSeenCount:3, fullscreenUpsellSeenCount:3,
  projects:{[project]:{hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true,allowedTools:[],projectOnboardingSeenCount:5}}};
fs.writeFileSync(`${cfg}/.claude.json`,JSON.stringify(seen));
fs.writeFileSync(`${cfg}/settings.json`,JSON.stringify({ permissions:{defaultMode:'auto'}, disableAllHooks:true }));
JS
# Copy authentication read-only into the disposable credential store. Never log a token or
# allow a refresh in the lab to write back to the user's Keychain credential.
python3 - "$CFG" <<'PY'
import json, os, pathlib, subprocess, sys
cfg = pathlib.Path(sys.argv[1])
credential = subprocess.run(['security','find-generic-password','-s','Claude Code-credentials','-w'], capture_output=True, text=True, check=True)
json.loads(credential.stdout)
destination = cfg / '.credentials.json'
destination.write_text(credential.stdout)
os.chmod(destination, 0o600)
source = pathlib.Path.home() / '.claude.json'
private = json.loads((cfg / '.claude.json').read_text())
if source.exists():
    identity = json.loads(source.read_text())
    for key in ['oauthAccount', 'hasAvailableSubscription']:
        if key in identity: private[key] = identity[key]
(cfg / '.claude.json').write_text(json.dumps(private))
(cfg / 'settings.json').write_text(json.dumps({'permissions':{'defaultMode':'acceptEdits','allow':['Read','Bash(joyride:*)','WebSearch','WebFetch']},'disableAllHooks':True}))
PY
# The daemon passes this explicit private config to the job through its launch environment.
export CLAUDE_CONFIG_DIR="$CFG"
export E2E_NEW_REAL_JOB=1 E2E_NEW_LAB_PROJECT="$WORK/project"
export E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_CLAUDE_DIR="$CFG" E2E_LAB_FM_HOME="$FM_HOME"
export E2E_NEW_LAB_SESSION="$HERDR_LAB_SESSION"
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1
scripts/e2e.sh "$PORT" tests/e2e/new-real-agent.spec.ts --workers=1
