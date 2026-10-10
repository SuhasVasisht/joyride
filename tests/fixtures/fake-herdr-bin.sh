#!/bin/sh
# Stand-in for the herdr binary in tests (JOYRIDE_HERDR_BIN): `fake-herdr-bin.sh server`
# serves the fake Herdr on $HERDR_SOCKET_PATH and records the environment it was given.
ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
[ "$1" = "server" ] || { echo "fake herdr: only 'server' is supported" >&2; exit 2; }
[ -n "$HERDR_SOCKET_PATH" ] || { echo "fake herdr: HERDR_SOCKET_PATH is not set" >&2; exit 2; }
env > "$HERDR_SOCKET_PATH.env"
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/tests/fixtures/fake-herdr-server.ts"
