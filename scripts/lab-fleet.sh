#!/usr/bin/env bash
# One fleet (phase 2) against real software, run through tests/e2e/fleet-lab.spec.ts:
#   - an isolated Herdr lab session (never the default one) with two real Claude Code panes the
#     "captain" started, talking to tests/fixtures/fake-anthropic.mjs on 127.0.0.1;
#   - Joyride's hooks wired into those panes' own Claude config (never ~/.claude), writing to the e2e
#     sandbox, so prompts are attributed and the helm follows the captain;
#   - a marked throwaway Firstmate home (bin/fm-lab-home.sh) that the daemon files its fleet notes in,
#     and that `joyride install firstmate-feed` binds the joyride-fleet-feed extension into.
# It proves: Firstmate's steer is refused onto the captain's draft (and the draft survives), the captain
# takes the helm and hands it back, a real permission prompt is answered through the guarded path, and
# the fleet feed lands in the test home's process-event inbox. Nothing leaves the machine.
#   scripts/lab-fleet.sh [port] [playwright args...]     (port defaults to 4405)
# Needs herdr, claude, bun, jq and Firstmate's lab helpers (FM_HERDR_LAB_HELPER, default
# vendor/firstmate/bin/fm-herdr-lab.sh; fm-lab-home.sh beside it). Firstmate's checkout is read only.
# One EXIT trap stops the fake model, retires the lab home's process-event sources, and tears down
# the lab home and the Herdr lab session through the helpers.
set -u
PORT="${1:-4405}"; shift || true
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
HERDR_LAB_HELPER="${FM_HERDR_LAB_HELPER:-$ROOT/vendor/firstmate/bin/fm-herdr-lab.sh}"
LAB_HOME_HELPER="${FM_LAB_HOME_HELPER:-$(dirname "$HERDR_LAB_HELPER")/fm-lab-home.sh}"
FM_DIR="${JOYRIDE_FIRSTMATE_DIR:-$(cd "$(dirname "$HERDR_LAB_HELPER")/.." && pwd -P)}"
for f in "$HERDR_LAB_HELPER" "$LAB_HOME_HELPER" "$FM_DIR/bin/fm-extension.sh" "$FM_DIR/bin/fm-procevent.sh" "$FM_DIR/bin/fm-inbox.sh"; do
  [ -x "$f" ] || { echo "lab-fleet: $f is missing. Set FM_HERDR_LAB_HELPER (and JOYRIDE_FIRSTMATE_DIR) to a Firstmate checkout." >&2; exit 2; }
done
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
[ -x "$BUN" ] || { echo "lab-fleet: bun is needed for Joyride's hooks." >&2; exit 2; }
# A canonical path outside every Git project: Firstmate binds packages only from such a place.
WORK="${LAB_FLEET_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/joyride-lab-fleet.XXXXXX")}"
mkdir -p "$WORK" || exit 2
WORK="$(cd "$WORK" && pwd -P)"
FMH="$WORK/fm-home" CLAIMS="$WORK/claims"
SANDBOX="/tmp/joyride-e2e-$PORT"
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name "${LAB_FLEET_TASK:-jr-fleet-p2}") || exit 2
MODEL_PID=""
cleanup() {
  local rc=$?
  [ -n "$MODEL_PID" ] && kill "$MODEL_PID" 2>/dev/null
  if [ -f "$FMH/.fm-lab-home" ]; then
    FM_HOME="$FMH" FM_PROCEVENT_CLAIM_ROOT="$CLAIMS" "$FM_DIR/bin/fm-procevent.sh" sweep-home >/dev/null 2>&1 || echo "lab-fleet: sweep-home of $FMH did not finish cleanly" >&2
    "$LAB_HOME_HELPER" teardown "$FMH" || { echo "lab-fleet: lab home teardown FAILED" >&2; rc=1; }
  fi
  "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION" || { echo "lab-fleet: teardown of $HERDR_LAB_SESSION FAILED" >&2; rc=1; }
  exit $rc
}
trap cleanup EXIT
"$LAB_HOME_HELPER" create "$FMH" >/dev/null || { echo "lab-fleet: could not create the lab Firstmate home" >&2; exit 1; }
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION" || { echo "lab-fleet: could not provision $HERDR_LAB_SESSION" >&2; exit 1; }
H() { "$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" "$@"; }
SOCKET="$HOME/.config/herdr/sessions/$HERDR_LAB_SESSION/herdr.sock"
# A fake key, split so secret scanners skip it.
KEY="sk-ant-""api03-joyride-lab-fleet-00000000000000000000000000000000000000000000000000000000000-lab00AA"
CFG="$WORK/claude/config" APROJ="$WORK/claude/alpha" BPROJ="$WORK/claude/beta"
mkdir -p "$CFG/projects" "$APROJ" "$BPROJ"

MODEL_LOG="$WORK/model-requests.jsonl"; : > "$MODEL_LOG"
node "$ROOT/tests/fixtures/fake-anthropic.mjs" "$MODEL_LOG" "$WORK/model.port" & MODEL_PID=$!
for i in $(seq 1 50); do [ -s "$WORK/model.port" ] && break; sleep 0.1; done
[ -s "$WORK/model.port" ] || { echo "lab-fleet: the lab model server did not start" >&2; exit 1; }

# The lab Claude's own config: onboarding done, both folders trusted, default permission mode (so a
# Bash command stops at a permission prompt), and Joyride's hooks from this checkout.
node -e '
  const fs = require("fs"), [cfg, a, b, key, bun, hook] = process.argv.slice(1);
  const proj = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [], projectOnboardingSeenCount: 5 };
  const seen = { hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.289", theme: "dark", autoUpdates: false, numStartups: 5, hasSeenTasksHint: true,
    hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, effortCalloutDismissed: true,
    effortCalloutV2Dismissed: true, remoteDialogSeen: true, opusProMigrationComplete: true, sonnet1m45MigrationComplete: true,
    unpinOpus47LaunchEffort: true, unpinOpus48LaunchEffort: true, unpinFable5LaunchEffort: true, officialMarketplaceAutoInstallAttempted: true,
    autoPermissionsNotificationCount: 3, remoteControlUpsellSeenCount: 3, pushNotifUpsellSeenCount: 3, fullscreenUpsellSeenCount: 3,
    promptQueueUseCount: 100, birthdayHatAnimationCount: 3, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] },
    projects: { [a]: proj, [b]: proj } };
  fs.writeFileSync(`${cfg}/.claude.json`, JSON.stringify(seen));
  const events = { SessionStart: 10, UserPromptSubmit: 10, PreToolUse: 30, PermissionRequest: 10, Notification: 10, Stop: 10, StopFailure: 10, SessionEnd: 10 };
  const hooks = Object.fromEntries(Object.entries(events).map(([ev, timeout]) => [ev, [{ ...(ev === "PreToolUse" || ev === "PermissionRequest" ? { matcher: "*" } : {}), hooks: [{ type: "command", command: `"${bun}" "${hook}" claude ${ev}`, timeout }] }]]));
  fs.writeFileSync(`${cfg}/settings.json`, JSON.stringify({ permissions: { defaultMode: "default" }, hooks }));
' "$CFG" "$APROJ" "$BPROJ" "$KEY" "$BUN" "$ROOT/src/hooks/hook.ts" || exit 1

pane() { # <folder> <label>: a workspace whose Claude reports to the e2e sandbox through Joyride's hooks
  H workspace create --cwd "$1" --label "$2" --no-focus \
    --env "CLAUDE_CONFIG_DIR=$CFG" --env "ANTHROPIC_API_KEY=$KEY" --env "ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat "$WORK/model.port")" \
    --env DISABLE_AUTOUPDATER=1 --env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 \
    --env CLAUDECODE= --env CLAUDE_CODE_ENTRYPOINT= --env CLAUDE_CODE_SESSION_ID= --env CLAUDE_CODE_CHILD_SESSION= --env CLAUDE_PID= \
    --env CLAUDE_CODE_MESSAGING_SOCKET= --env CLAUDE_CODE_MESSAGING_TOKEN= --env CLAUDE_CODE_EXECPATH= --env CLAUDE_CODE_SESSION_ATTENDED= \
    --env JOYRIDE_INTERNAL= --env JOYRIDE_GUARD=off --env JOYRIDE_TEST=1 --env FM_TASK_ID= --env FM_HOME= \
    --env "JOYRIDE_RUNTIME=$SANDBOX/runtime" --env "JOYRIDE_HOME=$SANDBOX/home" --env "JOYRIDE_URL=http://127.0.0.1:$PORT" \
    | jq -r '.result.root_pane.pane_id // empty'
}
APANE=$(pane "$APROJ" alpha) BPANE=$(pane "$BPROJ" beta)
[ -n "$APANE" ] && [ -n "$BPANE" ] || { echo "lab-fleet: could not create the agent panes" >&2; exit 1; }
for p in "$APANE:lab-alpha" "$BPANE:lab-beta"; do
  for i in $(seq 1 40); do H agent start "${p##*:}" --kind claude --pane "${p%:*}" --timeout 60000 >/dev/null 2>&1 && break; sleep 0.5; done
done
for p in "$APANE" "$BPANE"; do
  ok=""
  for i in $(seq 1 60); do
    [ "$(H agent list | jq -r --arg p "$p" '.result.agents[]? | select(.pane_id == $p) | .agent')" = "claude" ] && { ok=1; break; }
    sleep 0.5
  done
  [ -n "$ok" ] || { echo "lab-fleet: claude never started in pane $p; its screen:" >&2; H pane read "$p" --source visible --format text >&2; exit 1; }
done
echo "lab-fleet: session $HERDR_LAB_SESSION, alpha $APANE, beta $BPANE, Firstmate lab home $FMH, work $WORK"
sleep 3
E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_CLAUDE_DIR="$CFG" E2E_LAB_FM_HOME="$FMH" E2E_LAB_CLAIMS="$CLAIMS" E2E_LAB_WORK="$WORK" \
  E2E_LAB_ALPHA="$APANE=$APROJ" E2E_LAB_BETA="$BPANE=$BPROJ" E2E_LAB_MODEL_LOG="$MODEL_LOG" \
  JOYRIDE_FIRSTMATE_DIR="$FM_DIR" JOYRIDE_FM_PACKAGES_DIR="$WORK/packages" \
  "$ROOT/scripts/e2e.sh" "$PORT" "${LAB_FLEET_SPEC:-tests/e2e/fleet-lab.spec.ts}" "$@"
RC=$?
for p in "$APANE" "$BPANE"; do H pane read "$p" --source recent --format text > "$WORK/screen-${p/:/-}.txt" 2>&1; done
mkdir -p "$ROOT/test-results/fleet-lab"
cp "$WORK"/screen-*.txt "$ROOT/test-results/fleet-lab/" 2>/dev/null
[ -d "$FMH/state" ] && { ls -la "$FMH/state/inbox" "$FMH/state/procevent-inbox" > "$ROOT/test-results/fleet-lab/fm-home-inbox.txt" 2>&1; cat "$FMH"/state/inbox/*.note "$FMH"/state/procevent-inbox/*.result >> "$ROOT/test-results/fleet-lab/fm-home-inbox.txt" 2>/dev/null; }
echo "lab-fleet: final screens and the lab home's inbox in test-results/fleet-lab/"
exit $RC
