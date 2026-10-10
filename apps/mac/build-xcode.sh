#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
exec xcodebuild -project apps/mac/Joyride.xcodeproj -scheme JoyrideMac -configuration Debug -derivedDataPath "$ROOT/.joyride/mac-xcode" -destination 'platform=macOS' -jobs 2 "$@"
