#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"
if [ "${JOYRIDE_MAC_BACKGROUND_TEST:-}" != 1 ]; then
  echo 'Run the sandbox coordinator: node_modules/.bin/tsx apps/mac/Tests/Background/run.ts' >&2
  exit 1
fi
exec dist/mac/Joyride.app/Contents/MacOS/JoyrideMac
