#!/usr/bin/env bash
set -eu
. "$(dirname "$0")/lab-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
export FM_HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
export FM_LAB_HOME_HELPER="$FM_VENDOR/bin/fm-lab-home.sh"
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
export LAB_FLEET_TASK=jr-fleet-p3
export LAB_FLEET_SPEC=tests/e2e/fleet-pruning-lab.spec.ts
exec "$ROOT/scripts/lab-fleet.sh" 4405 "$@"
