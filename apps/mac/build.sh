#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"
MODE="${1:-release}"
case "$MODE" in debug|release) ;; *) echo 'Use debug or release' >&2; exit 2 ;; esac
swift build --package-path apps/mac --scratch-path "$ROOT/.joyride/mac-build" -c "$MODE" --jobs 2
BIN="$(swift build --package-path apps/mac --scratch-path "$ROOT/.joyride/mac-build" -c "$MODE" --show-bin-path)"
APP="$ROOT/dist/mac/Joyride.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/JoyrideMac" "$APP/Contents/MacOS/JoyrideMac"
cp apps/mac/Info.plist "$APP/Contents/Info.plist"
printf '%s\n' "$ROOT" > "$APP/Contents/Resources/repository.txt"
swift apps/mac/icon.swift "$APP/Contents/Resources/Joyride.icns"
echo "Built $APP"
