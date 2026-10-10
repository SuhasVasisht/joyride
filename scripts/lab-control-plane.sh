#!/usr/bin/env bash
# The control plane (CP8) against real software, run through tests/e2e/control-plane-lab.spec.ts:
#   - an isolated Herdr lab session (never the default one) with one real Claude Code crewmate pane,
#     talking to tests/fixtures/fake-anthropic.mjs on 127.0.0.1, launched the way Firstmate launches a
#     crewmate (FM_TASK_ID, FM_TASK_INBOX) and allowed to run Bash, so it acks its steering inbox;
#   - a marked throwaway Firstmate home (bin/fm-lab-home.sh) that the e2e sandbox daemon uses as FM_HOME.
# It proves: a captain call answered on the map closes a real held task through the real
# fm-captain-hold.sh and tasks-axi, and a keyed decision answered on the map reaches the real crewmate
# pane's inbox through fm-send.sh (its doorbell routed through the lab helper) and the worker acks it
# by moving the message to handled/. Nothing leaves the machine.
#   scripts/lab-control-plane.sh [port] [playwright args...]     (port defaults to 4405)
# Needs herdr, claude, jq, tasks-axi and Firstmate's lab helpers (FM_HERDR_LAB_HELPER, default
# vendor/firstmate/bin/fm-herdr-lab.sh; fm-lab-home.sh beside it). Firstmate's checkout is read only.
# One EXIT trap stops the fake model, kills only the lab home's private tmux server, and tears down
# the lab home and the Herdr lab session through the helpers.
set -u
PORT="${1:-4405}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HERDR_LAB_HELPER="${FM_HERDR_LAB_HELPER:-$ROOT/vendor/firstmate/bin/fm-herdr-lab.sh}"
LAB_HOME_HELPER="${FM_LAB_HOME_HELPER:-$(dirname "$HERDR_LAB_HELPER")/fm-lab-home.sh}"
FM_DIR="${JOYRIDE_FIRSTMATE_DIR:-$(cd "$(dirname "$HERDR_LAB_HELPER")/.." && pwd -P)}"
for f in "$HERDR_LAB_HELPER" "$LAB_HOME_HELPER" "$FM_DIR/bin/fm-send.sh" "$FM_DIR/bin/fm-captain-hold.sh"; do
  [ -x "$f" ] || { echo "lab-control-plane: $f is missing. Set FM_HERDR_LAB_HELPER (and JOYRIDE_FIRSTMATE_DIR) to a Firstmate checkout." >&2; exit 2; }
done
WORK="${LAB_CP_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/joyride-lab-cp.XXXXXX")}"
mkdir -p "$WORK" || exit 2
WORK="$(cd "$WORK" && pwd -P)"
FMH="$WORK/fm-home"
TASK="${LAB_CP_TASK:-lab-scout}"
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name cp8-verify) || exit 2
MODEL_PID="" LAB_TMUX_DIR=""
cleanup() {
  local rc=$?
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  if [ -f "$FMH/.fm-lab-home" ]; then
    [ -n "$LAB_TMUX_DIR" ] && TMUX_TMPDIR="$LAB_TMUX_DIR" tmux kill-server >/dev/null 2>&1
    "$LAB_HOME_HELPER" teardown "$FMH" || { echo "lab-control-plane: lab home teardown FAILED" >&2; rc=1; }
  fi
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || { echo "lab-control-plane: teardown of $HERDR_LAB_SESSION FAILED" >&2; rc=1; }
  exit $rc
}
trap cleanup EXIT
"$LAB_HOME_HELPER" create "$FMH" >/dev/null || { echo "lab-control-plane: could not create the lab Firstmate home" >&2; exit 1; }
LAB_TMUX_DIR=$("$LAB_HOME_HELPER" tmux-dir "$FMH") || { echo "lab-control-plane: could not set up the lab home's tmux dir" >&2; exit 1; }
printf 'herdr\n' > "$FMH/config/backend"
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || { echo "lab-control-plane: could not provision $HERDR_LAB_SESSION" >&2; exit 1; }
H() { "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }
SOCKET="$HOME/.config/herdr/sessions/$HERDR_LAB_SESSION/herdr.sock"
# A fake key, split so secret scanners skip it.
KEY="sk-ant-""api03-joyride-lab-cp-0000000000000000000000000000000000000000000000000000000000000-lab00AA"
CFG="$WORK/claude/config" CREW="$WORK/crew/alpha"
mkdir -p "$CFG/projects" "$CREW"

MODEL_LOG="$WORK/model-requests.jsonl"; : > "$MODEL_LOG"
node "$ROOT/tests/fixtures/fake-anthropic.mjs" "$MODEL_LOG" "$WORK/model.port" & MODEL_PID=$!
for i in $(seq 1 50); do [ -s "$WORK/model.port" ] && break; sleep 0.1; done
[ -s "$WORK/model.port" ] || { echo "lab-control-plane: the lab model server did not start" >&2; exit 1; }

# The lab Claude's own config: onboarding done, the crew folder trusted, Bash allowed (a crewmate acks
# its inbox without stopping at a prompt). No Joyride hooks: the proof is the inbox, not attribution.
node -e '
  const fs = require("fs"), [cfg, crew, key] = process.argv.slice(1);
  const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], projectOnboardingSeenCount: 5 };
  const seen = { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.289", theme: "dark", autoUpdates: false, numStartups: 5, hasSeenTasksHint: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, effortCalloutDismissed: true,
    effortCalloutV2Dismissed: true, remoteDialogSeen: true, opusProMigrationComplete: true, sonnet1m45MigrationComplete: true,
    unpinOpus47LaunchEffort: true, unpinOpus48LaunchEffort: true, unpinFable5LaunchEffort: true, officialMarketplaceAutoInstallAttempted: true,
    autoPermissionsNotificationCount: 3, remoteControlUpsellSeenCount: 3, pushNotifUpsellSeenCount: 3, fullscreenUpsellSeenCount: 3,
    promptQueueUseCount: 100, birthdayHatAnimationCount: 3, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [crew]: proj } };
  fs.writeFileSync(`${cfg}/.claude.json`, JSON.stringify(seen));
  fs.writeFileSync(`${cfg}/settings.json`, JSON.stringify({ permissions: { defaultMode: "default", allow: ["Bash"] } }));
' "$CFG" "$CREW" "$KEY" || exit 1

# The crewmate, launched with what bin/fm-spawn.sh exports into every launch.
PANE=$(H workspace create --cwd "$CREW" --label "fm-$TASK" --no-focus \
  --env "CLAUDE_CONFIG_DIR=$CFG" --env "ANTHROPIC_API_KEY=$KEY" --env "ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat "$WORK/model.port")" \
  --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 \
  --env CLAUDECODE= --env CLAUDE_CODE_ENTRYPOINT= --env CLAUDE_CODE_SESSION_ID= --env CLAUDE_CODE_CHILD_SESSION= --env CLAUDE_PID= \
  --env CLAUDE_CODE_MESSAGING_SOCKET= --env CLAUDE_CODE_MESSAGING_TOKEN= --env CLAUDE_CODE_EXECPATH= --env CLAUDE_CODE_SESSION_ATTENDED= \
  --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off --env "FM_HOME=$FMH" --env "FM_TASK_ID=$TASK" --env "FM_TASK_INBOX=$FMH/state/$TASK.inbox" \
  | jq -r '.result.root_pane.pane_id // empty')
[ -n "$PANE" ] || { echo "lab-control-plane: could not create the crewmate pane" >&2; exit 1; }
for i in $(seq 1 40); do H agent start "lab-crew" --kind claude --pane "$PANE" --timeout 60000 >/dev/null 2>&1 && break; sleep 0.5; done
ok=""
for i in $(seq 1 60); do
  [ "$(H agent list | jq -r --arg p "$PANE" '.result.agents[]? | select(.pane_id == $p) | .agent')" = "claude" ] && { ok=1; break; }
  sleep 0.5
done
[ -n "$ok" ] || { echo "lab-control-plane: claude never started in pane $PANE; its screen:" >&2; H pane read "$PANE" --source visible --format text >&2; exit 1; }
WSID=$(H pane get "$PANE" | jq -r '.result.pane.workspace_id // empty')
echo "lab-control-plane: session $HERDR_LAB_SESSION, crewmate $PANE (workspace $WSID), Firstmate lab home $FMH, work $WORK"
sleep 3
E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_FM_HOME="$FMH" E2E_LAB_HERDR_SESSION="$HERDR_LAB_SESSION" E2E_LAB_HERDR_HELPER="$HERDR_LAB_HELPER" \
  E2E_LAB_CREW="$PANE=$CREW" E2E_LAB_CREW_WORKSPACE="$WSID" E2E_LAB_CREW_TASK="$TASK" E2E_LAB_MODEL_LOG="$MODEL_LOG" \
  JOYRIDE_FIRSTMATE_DIR="$FM_DIR" \
  "$ROOT/scripts/e2e.sh" "$PORT" "${LAB_CP_SPEC:-tests/e2e/control-plane-lab.spec.ts}" "$@"
RC=$?
OUT="$ROOT/test-results/control-plane-lab"; mkdir -p "$OUT"
H pane read "$PANE" --source recent --format text > "$OUT/crewmate-screen.txt" 2>&1
{ echo "## $FMH/state"; ls -laR "$FMH/state" 2>&1; echo; echo "## backlog"; cat "$FMH/data/backlog.md" 2>&1; echo; echo "## $TASK.status"; cat "$FMH/state/$TASK.status" 2>&1; } > "$OUT/fm-home.txt"
cp "$MODEL_LOG" "$OUT/model-requests.jsonl" 2>/dev/null
echo "lab-control-plane: the crewmate's final screen, the lab home and the model log in test-results/control-plane-lab/"
exit $RC
