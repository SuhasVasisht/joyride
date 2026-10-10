#!/usr/bin/env bash
# Replies sent from the chat view while the agent works, against real software: an isolated Herdr
# lab session (never the default one) with a real Claude Code pane and a real Codex pane, run
# through tests/e2e/staged-lab.spec.ts. Claude Code talks to tests/fixtures/fake-anthropic.mjs and
# Codex to tests/fixtures/fake-openai.mjs on 127.0.0.1; a prompt with "lab: slow <n>s" (or "lab:
# tool <n>s") keeps the agent busy so a reply has to wait in its queue. Joyride's sandbox indexes
# the lab Claude's config folder, so its transcript drives the chat view. Nothing leaves the machine.
#   scripts/lab-staged.sh [port] [playwright args...]     (port defaults to 4403)
# Needs herdr, claude, codex, jq and Firstmate's lab helper (FM_HERDR_LAB_HELPER, default
# vendor/firstmate/bin/fm-herdr-lab.sh). The EXIT trap stops the fake models and tears the lab down.
set -u
PORT="${1:-4403}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HELPER="${FM_HERDR_LAB_HELPER:-$ROOT/vendor/firstmate/bin/fm-herdr-lab.sh}"
[ -x "$HELPER" ] || { echo "lab-staged: Firstmate's Herdr lab helper is missing at $HELPER. Set FM_HERDR_LAB_HELPER." >&2; exit 2; }
WORK="${LAB_STAGED_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/joyride-lab-staged.XXXXXX")}"
mkdir -p "$WORK" || exit 2
WORK="$(cd "$WORK" && pwd -P)"
SESSION=$("$HELPER" name jr-staged-chat) || exit 2
MODEL_PID=""; OPENAI_PID=""
cleanup() {
  local rc=$?
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  [ -n "$OPENAI_PID" ] && kill "$OPENAI_PID" 2>/dev/null
  # Codex leaves an app-server daemon per CODEX_HOME running; stop the lab's own (they live under $WORK).
  pkill -9 -f "^$WORK/.*codex app-server" 2>/dev/null
  "$HELPER" teardown "$SESSION" || { echo "lab-staged: teardown of $SESSION FAILED" >&2; rc=1; }
  exit $rc
}
trap cleanup EXIT
"$HELPER" provision "$SESSION" || { echo "lab-staged: could not provision $SESSION" >&2; exit 1; }
H() { "$HELPER" run "$SESSION" "$@"; }
SOCKET="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"
# A fake key, split so secret scanners skip it.
KEY="sk-ant-""api03-joyride-lab-staged-0000000000000000000000000000000000000000000000000000000000-lab00AA"
CPROJ="$WORK/claude/proj" CFG="$WORK/claude/config" XPROJ="$WORK/codex/proj" XHOME="$WORK/codex/home"
# projects/ exists from the start, as in a real ~/.claude, so Joyride watches it for the lab's transcript.
mkdir -p "$CPROJ" "$CFG/projects" "$XPROJ" "$XHOME"
echo "Notes the lab model reads, so a turn has a tool call in it." > "$CPROJ/lab-notes.txt"

MODEL_LOG="$WORK/model-requests.jsonl"; : > "$MODEL_LOG"
LAB_TOOL_FILE="$CPROJ/lab-notes.txt" node "$ROOT/tests/fixtures/fake-anthropic.mjs" "$MODEL_LOG" "$WORK/model.port" & MODEL_PID=$!
OPENAI_LOG="$WORK/openai-requests.jsonl"; : > "$OPENAI_LOG"
node "$ROOT/tests/fixtures/fake-openai.mjs" "$OPENAI_LOG" "$WORK/openai.port" & OPENAI_PID=$!
for i in $(seq 1 50); do [ -s "$WORK/model.port" ] && [ -s "$WORK/openai.port" ] && break; sleep 0.1; done
[ -s "$WORK/model.port" ] && [ -s "$WORK/openai.port" ] || { echo "lab-staged: the lab model servers did not start" >&2; exit 1; }

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
' "$CFG" "$CPROJ" "$KEY" || exit 1
cat > "$XHOME/config.toml" <<TOML
model = "gpt-5.1"
model_provider = "lab"
check_for_update_on_startup = false
[model_providers.lab]
name = "lab"
base_url = "http://127.0.0.1:$(cat "$WORK/openai.port")/v1"
env_key = "LAB_KEY"
wire_api = "responses"
[projects."$XPROJ"]
trust_level = "trusted"
TOML

ws=$(H workspace create --cwd "$CPROJ" --label claude --no-focus \
  --env "CLAUDE_CONFIG_DIR=$CFG" --env "ANTHROPIC_API_KEY=$KEY" --env "ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat "$WORK/model.port")" \
  --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 \
  --env CLAUDECODE= --env CLAUDE_CODE_ENTRYPOINT= --env CLAUDE_CODE_SESSION_ID= --env CLAUDE_CODE_CHILD_SESSION= --env CLAUDE_PID= \
  --env CLAUDE_CODE_MESSAGING_SOCKET= --env CLAUDE_CODE_MESSAGING_TOKEN= --env CLAUDE_CODE_EXECPATH= --env CLAUDE_CODE_SESSION_ATTENDED= \
  --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off) || exit 1
CPANE=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id // empty')
ws=$(H workspace create --cwd "$XPROJ" --label codex --no-focus --env "CODEX_HOME=$XHOME" --env LAB_KEY=lab --env OPENAI_API_KEY= \
  --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off) || exit 1
XPANE=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id // empty')
[ -n "$CPANE" ] && [ -n "$XPANE" ] || { echo "lab-staged: could not create the agent panes" >&2; exit 1; }
for i in $(seq 1 40); do H agent start lab-claude --kind claude --pane "$CPANE" --timeout 60000 >/dev/null 2>&1 && break; sleep 0.5; done
for i in $(seq 1 40); do H agent start lab-codex --kind codex --pane "$XPANE" --timeout 60000 -- --no-daemon >/dev/null 2>&1 && break; sleep 0.5; done
for p in "$CPANE:claude" "$XPANE:codex"; do
  pane=${p%:*} kind=${p##*:} ok=""
  for i in $(seq 1 60); do
    [ "$(H agent list | jq -r --arg p "$pane" '.result.agents[]? | select(.pane_id == $p) | .agent')" = "$kind" ] && { ok=1; break; }
    sleep 0.5
  done
  [ -n "$ok" ] || { echo "lab-staged: $kind never started in pane $pane; its screen:" >&2; H pane read "$pane" --source visible --format text >&2; exit 1; }
done
echo "lab-staged: session $SESSION, claude $CPANE, codex $XPANE, work $WORK"
sleep 3
E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_CLAUDE_DIR="$CFG" E2E_LAB_CLAUDE="$CPANE=$CFG" E2E_LAB_CODEX="$XPANE=$XHOME" \
  E2E_LAB_MODEL_LOG="$MODEL_LOG" E2E_LAB_OPENAI_LOG="$OPENAI_LOG" \
  "$ROOT/scripts/e2e.sh" "$PORT" tests/e2e/staged-lab.spec.ts "$@"
RC=$?
for p in "$CPANE" "$XPANE"; do H pane read "$p" --source recent --format text > "$WORK/screen-${p/:/-}.txt" 2>&1; done
echo "lab-staged: final screens in $WORK/screen-*.txt"
exit $RC
