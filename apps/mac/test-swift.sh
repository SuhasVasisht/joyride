#!/bin/sh
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$ROOT"
mkdir -p .joyride/mac-test-build
swiftc apps/mac/Sources/JoyrideMac/Configuration.swift apps/mac/Tests/Configuration/main.swift -o .joyride/mac-test-build/configuration-tests
exec .joyride/mac-test-build/configuration-tests
