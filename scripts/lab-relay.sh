#!/usr/bin/env bash
# The reply-relay regression against real software: an isolated Herdr lab session (never the
# default one) with two real Claude Code panes, run through tests/e2e/relay-lab.spec.ts.
# Each Claude keeps its config, prompt history and transcripts in a temp folder, uses a dummy API
# key and an unreachable API URL (nothing leaves the machine), and starts with the launch prompt
# in its history, like the Firstmate pane the captain replies to.
#   scripts/lab-relay.sh [port] [playwright args...]     (port defaults to 4401)
# Needs herdr, claude, jq and Firstmate's lab helper (FM_HERDR_LAB_HELPER, default
# vendor/firstmate/bin/fm-herdr-lab.sh). The EXIT trap tears the lab session down.
set -u
PORT="${1:-4401}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HELPER="${FM_HERDR_LAB_HELPER:-$ROOT/vendor/firstmate/bin/fm-herdr-lab.sh}"
[ -x "$HELPER" ] || { echo "lab-relay: Firstmate's Herdr lab helper is missing at $HELPER. Set FM_HERDR_LAB_HELPER." >&2; exit 2; }
WORK="${LAB_RELAY_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/joyride-lab-relay.XXXXXX")}"
SESSION=$("$HELPER" name jr-relay) || exit 2
cleanup() {
  local rc=$?
  "$HELPER" teardown "$SESSION" || { echo "lab-relay: teardown of $SESSION FAILED" >&2; rc=1; }
  exit $rc
}
trap cleanup EXIT
"$HELPER" provision "$SESSION" || { echo "lab-relay: could not provision $SESSION" >&2; exit 1; }
H() { "$HELPER" run "$SESSION" "$@"; }
SOCKET="$HOME/.config/herdr/sessions/$SESSION/herdr.sock"
# A fake key, split so secret scanners skip it.
KEY="sk-ant-""api03-joyride-lab-relay-0000000000000000000000000000000000000000000000000000000000-lab00AA"
LAUNCH="Ahoy. I am the captain. Please run your first-time setup and tell me what you need from me. All projects are local-only: never push, never open PRs. My work happens through Joyride (http://127.0.0.1:4317), which will relay your questions to me."

# start_claude <name> -> prints "<pane>=<config dir>"
start_claude() {
  local name=$1 proj="$WORK/$1/proj" cfg="$WORK/$1/claude" ws pane i
  mkdir -p "$proj" "$cfg"
  node -e '
    const fs = require("fs"), [cfg, proj, key, launch] = process.argv.slice(1);
    const seen = { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.289", theme: "dark", autoUpdates: false, numStartups: 5, hasSeenTasksHint: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, effortCalloutDismissed: true,
      effortCalloutV2Dismissed: true, remoteDialogSeen: true, opusProMigrationComplete: true, sonnet1m45MigrationComplete: true,
      unpinOpus47LaunchEffort: true, unpinOpus48LaunchEffort: true, unpinFable5LaunchEffort: true, officialMarketplaceAutoInstallAttempted: true,
      autoPermissionsNotificationCount: 3, remoteControlUpsellSeenCount: 3, pushNotifUpsellSeenCount: 3, fullscreenUpsellSeenCount: 3,
      promptQueueUseCount: 100, birthdayHatAnimationCount: 3, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
      projects: { [proj]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], projectOnboardingSeenCount: 5 } } };
    fs.writeFileSync(`${cfg}/.claude.json`, JSON.stringify(seen));
    fs.writeFileSync(`${cfg}/settings.json`, JSON.stringify({ permissions: { defaultMode: "default" } }));
    fs.writeFileSync(`${cfg}/history.jsonl`, JSON.stringify({ display: launch, pastedContents: {}, timestamp: Date.now() - 3600e3, project: proj, sessionId: "00000000-0000-4000-8000-000000000001" }) + "\n");
  ' "$cfg" "$proj" "$KEY" "$LAUNCH" || return 1
  ws=$(H workspace create --cwd "$proj" --label "$name" --no-focus \
    --env "CLAUDE_CONFIG_DIR=$cfg" --env "ANTHROPIC_API_KEY=$KEY" --env "ANTHROPIC_BASE_URL=http://127.0.0.1:9" \
    --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 \
    --env CLAUDECODE= --env CLAUDE_CODE_ENTRYPOINT= --env CLAUDE_CODE_SESSION_ID= --env CLAUDE_CODE_CHILD_SESSION= --env CLAUDE_PID= \
    --env CLAUDE_CODE_MESSAGING_SOCKET= --env CLAUDE_CODE_MESSAGING_TOKEN= --env CLAUDE_CODE_EXECPATH= --env CLAUDE_CODE_SESSION_ATTENDED= \
    --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off) || return 1
  pane=$(printf '%s' "$ws" | jq -r '.result.root_pane.pane_id // empty')
  [ -n "$pane" ] || return 1
  for i in $(seq 1 40); do H agent start "lab-$name" --kind claude --pane "$pane" --timeout 60000 >/dev/null 2>&1 && break; sleep 0.5; done
  printf '%s=%s\n' "$pane" "$cfg"
}

SCROLL=$(start_claude scroll) || { echo "lab-relay: could not start the scroll pane" >&2; exit 1; }
UP=$(start_claude up) || { echo "lab-relay: could not start the up pane" >&2; exit 1; }
echo "lab-relay: session $SESSION, panes $SCROLL $UP"
sleep 3
E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_SCROLL="$SCROLL" E2E_LAB_UP="$UP" "$ROOT/scripts/e2e.sh" "$PORT" tests/e2e/relay-lab.spec.ts "$@"
