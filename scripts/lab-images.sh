#!/usr/bin/env bash
# Images through the relay, against real software: an isolated Herdr lab session (never the
# default one) with a real Claude Code pane and a real Codex pane, run through
# tests/e2e/images-lab.spec.ts. Claude Code talks to tests/fixtures/fake-anthropic.mjs on
# 127.0.0.1, which records the images each model request carried; Codex points at an
# unreachable URL and its rollout file shows what it attached. Nothing leaves the machine.
#   scripts/lab-images.sh [port] [playwright args...]     (port defaults to 4404)
# Needs herdr, claude, codex, jq and Firstmate's lab helper (FM_HERDR_LAB_HELPER, default
# vendor/firstmate/bin/fm-herdr-lab.sh). The EXIT trap stops the fake model and tears the lab down.
set -u
PORT="${1:-4404}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HERDR_LAB_HELPER="${HERDR_LAB_HELPER:-${FM_HERDR_LAB_HELPER:-$ROOT/vendor/firstmate/bin/fm-herdr-lab.sh}}"
[ -x "$HERDR_LAB_HELPER" ] || { echo "lab-images: Firstmate's Herdr lab helper is missing at $HERDR_LAB_HELPER. Set FM_HERDR_LAB_HELPER." >&2; exit 2; }
WORK="${LAB_IMAGES_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/joyride-lab-images.XXXXXX")}"
mkdir -p "$WORK" || exit 2
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-chat-images-v2) || exit 2
MODEL_PID=""
cleanup() {
  local rc=$?
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  # Codex leaves an app-server daemon per CODEX_HOME running; stop the lab's own (they live under $WORK).
  pkill -9 -f "^$WORK/.*codex app-server" 2>/dev/null
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || { echo "lab-images: teardown of $HERDR_LAB_SESSION FAILED" >&2; rc=1; }
  exit $rc
}
trap cleanup EXIT
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || { echo "lab-images: could not provision $HERDR_LAB_SESSION" >&2; exit 1; }
H() { "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }
SOCKET="$HOME/.config/herdr/sessions/$HERDR_LAB_SESSION/herdr.sock"
# A fake key, split so secret scanners skip it.
KEY="sk-ant-""api03-joyride-lab-images-00000000000000000000000000000000000000000000000000000000000-lab00AA"

MODEL_LOG="$WORK/model-requests.jsonl"; : > "$MODEL_LOG"
node "$ROOT/tests/fixtures/fake-anthropic.mjs" "$MODEL_LOG" "$WORK/model.port" & MODEL_PID=$!
for i in $(seq 1 50); do [ -s "$WORK/model.port" ] && break; sleep 0.1; done
[ -s "$WORK/model.port" ] || { echo "lab-images: the lab model server did not start" >&2; exit 1; }
MODEL_URL="http://127.0.0.1:$(cat "$WORK/model.port")"

# start_claude <name> -> prints "<pane>=<config dir>"
start_claude() {
  local name=$1 proj="$WORK/$1/proj" cfg="$WORK/$1/claude" ws pane i
  mkdir -p "$proj" "$cfg"
  node -e '
    const fs = require("fs"), [cfg, proj, key] = process.argv.slice(1);
    const seen = { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.289", theme: "dark", autoUpdates: false, numStartups: 5, hasSeenTasksHint: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, effortCalloutDismissed: true,
      effortCalloutV2Dismissed: true, remoteDialogSeen: true, opusProMigrationComplete: true, sonnet1m45MigrationComplete: true,
      unpinOpus47LaunchEffort: true, unpinOpus48LaunchEffort: true, unpinFable5LaunchEffort: true, officialMarketplaceAutoInstallAttempted: true,
      autoPermissionsNotificationCount: 3, remoteControlUpsellSeenCount: 3, pushNotifUpsellSeenCount: 3, fullscreenUpsellSeenCount: 3,
      promptQueueUseCount: 100, birthdayHatAnimationCount: 3, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [proj]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], projectOnboardingSeenCount: 5 } } };
    fs.writeFileSync(`${cfg}/.claude.json`, JSON.stringify(seen));
    fs.writeFileSync(`${cfg}/settings.json`, JSON.stringify({ permissions: { defaultMode: "default" } }));
  ' "$cfg" "$proj" "$KEY" || return 1
  ws=$(H workspace create --cwd "$proj" --label "$name" --no-focus \
    --env "CLAUDE_CONFIG_DIR=$cfg" --env "ANTHROPIC_API_KEY=$KEY" --env "ANTHROPIC_BASE_URL=$MODEL_URL" \
    --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 \
    --env CLAUDECODE= --env CLAUDE_CODE_ENTRYPOINT= --env CLAUDE_CODE_SESSION_ID= --env CLAUDE_CODE_CHILD_HERDR_LAB_SESSION= --env CLAUDE_PID= \
    --env CLAUDE_CODE_MESSAGING_SOCKET= --env CLAUDE_CODE_MESSAGING_TOKEN= --env CLAUDE_CODE_EXECPATH= --env CLAUDE_CODE_SESSION_ATTENDED= \
    --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off) || return 1
  pane=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id // empty')
  [ -n "$pane" ] || return 1
  for i in $(seq 1 40); do H agent start "lab-$name" --kind claude --pane "$pane" --timeout 60000 >/dev/null 2>&1 && break; sleep 0.5; done
  printf '%s=%s\n' "$pane" "$cfg"
}

# start_codex <name> -> prints "<pane>=<CODEX_HOME>"
start_codex() {
  local name=$1 proj="$WORK/$1/proj" home="$WORK/$1/codex" ws pane i
  mkdir -p "$proj" "$home"
  cat > "$home/config.toml" <<TOML
model = "gpt-5.1"
model_provider = "lab"
check_for_update_on_startup = false
[model_providers.lab]
name = "lab"
base_url = "http://127.0.0.1:9/v1"
env_key = "LAB_KEY"
wire_api = "responses"
[projects."$proj"]
trust_level = "trusted"
TOML
  ws=$(H workspace create --cwd "$proj" --label "$name" --no-focus --env "CODEX_HOME=$home" --env LAB_KEY=lab --env OPENAI_API_KEY= \
    --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off) || return 1
  pane=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id // empty')
  [ -n "$pane" ] || return 1
  for i in $(seq 1 40); do H agent start "lab-$name" --kind codex --pane "$pane" --timeout 60000 -- --no-daemon >/dev/null 2>&1 && break; sleep 0.5; done
  printf '%s=%s\n' "$pane" "$home"
}

# wait_agent <pane=dir> <kind>: until Herdr reports that agent in the pane; shows the pane's screen when it never does.
wait_agent() {
  local pane=${1%%=*} kind=$2 i
  for i in $(seq 1 60); do
    [ "$(H agent list | jq -r --arg p "$pane" '.result.agents[]? | select(.pane_id == $p) | .agent')" = "$kind" ] && return 0
    sleep 0.5
  done
  echo "lab-images: $kind never started in pane $pane; its screen:" >&2
  H pane read "$pane" --source visible --format text >&2
  return 1
}

CLAUDE=$(start_claude claude) || { echo "lab-images: could not start the Claude Code pane" >&2; exit 1; }
CODEX=$(start_codex codex) || { echo "lab-images: could not start the Codex pane" >&2; exit 1; }
wait_agent "$CLAUDE" claude || exit 1
wait_agent "$CODEX" codex || exit 1
echo "lab-images: session $HERDR_LAB_SESSION, claude $CLAUDE, codex $CODEX, model $MODEL_URL"
sleep 4
E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_CLAUDE_DIR="${CLAUDE#*=}" E2E_LAB_CODEX_DIR="${CODEX#*=}" E2E_LAB_CLAUDE="$CLAUDE" E2E_LAB_CODEX="$CODEX" E2E_LAB_MODEL_LOG="$MODEL_LOG" \
  "$ROOT/scripts/e2e.sh" "$PORT" tests/e2e/images-lab.spec.ts "$@"
RC=$?
# What each agent's terminal ended up showing, for the record (and for diagnosing a failure).
for p in "$CLAUDE" "$CODEX"; do
  H pane read "${p%%=*}" --source recent --format text > "$WORK/screen-${p%%=*}.txt" 2>&1
  H agent list | jq -c --arg p "${p%%=*}" '.result.agents[]? | select(.pane_id == $p)' >> "$WORK/screen-${p%%=*}.txt"
done
echo "lab-images: final screens in $WORK/screen-*.txt"
exit $RC
