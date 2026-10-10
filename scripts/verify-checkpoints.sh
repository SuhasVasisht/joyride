#!/bin/sh
# Re-verify C0–C10 for the build-joyride mission: every check runs through
# joyride-evidence (attested records with exit codes, logs, screenshots), then
# Jev judges each done-when criterion.   scripts/verify-checkpoints.sh [C3 ...]
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"; cd "$ROOT"
EV="$ROOT/bin/joyride-evidence"; M=build-joyride
only="$*"
want() { [ -z "$only" ] || echo " $only " | grep -q " $1 "; }
unit() { $EV run --name "$1 unit tests" --mission $M -- node_modules/.bin/vitest run $2; }
e2e() { port=$1; shift; name=$1; shift; for spec in "$@"; do $EV run --name "$name e2e $(basename $spec .spec.ts)" --mission $M --screenshots "docs/checkpoints" -- scripts/e2e.sh $port $spec; done; }
want C0 && { unit C0 "tests/unit/guard.test.ts"; $EV run --name "C0 installer status" --mission $M -- ./bin/joyride status; e2e 4460 C0 tests/e2e/shell.spec.ts; }
want C1 && { unit C1 "tests/unit/sessions.test.ts tests/unit/missions.test.ts"; e2e 4461 C1 tests/e2e/proposals.spec.ts tests/e2e/session.spec.ts; }
want C2 && { unit C2 "tests/unit/attention.test.ts tests/unit/attention-metrics.test.ts tests/unit/live-workers.test.ts tests/unit/herdr.test.ts"; e2e 4462 C2 tests/e2e/map.spec.ts tests/e2e/mission.spec.ts tests/e2e/rail.spec.ts; }
want C3 && { unit C3 "tests/unit/intents.test.ts tests/unit/answer-prompt.test.ts tests/unit/guard.test.ts"; e2e 4463 C3 tests/e2e/worker.spec.ts; }
want C4 && { unit C4 "tests/unit/evidence.test.ts tests/unit/evidence-cli.test.ts tests/unit/evidence-intents.test.ts"; e2e 4464 C4 tests/e2e/evidence.spec.ts; }
want C5 && { unit C5 "tests/unit/memory.test.ts tests/unit/mcp.test.ts"; e2e 4465 C5 tests/e2e/memory.spec.ts; }
want C6 && { unit C6 "tests/unit/artifacts.test.ts tests/unit/learnings.test.ts"; e2e 4466 C6 tests/e2e/artifacts.spec.ts tests/e2e/learnings.spec.ts; }
want C7 && { unit C7 "tests/unit/firstmate.test.ts tests/unit/capabilities.test.ts tests/unit/pstack.test.ts"; e2e 4467 C7 tests/e2e/crew.spec.ts; }
want C8 && { unit C8 "tests/unit/workspace.test.ts tests/unit/workspace-code.test.ts tests/unit/query.test.ts"; e2e 4468 C8 tests/e2e/evolve.spec.ts tests/e2e/views.spec.ts; }
want C9 && { unit C9 "tests/unit/hillclimb.test.ts"; e2e 4469 C9 tests/e2e/hillclimb.spec.ts; }
want C10 && { $EV run --name "C10 typecheck" --mission $M -- node_modules/.bin/tsc --noEmit -p .; $EV run --name "C10 full unit suite" --mission $M -- node_modules/.bin/vitest run; $EV run --name "C10 docs present" --mission $M -- sh -c 'for f in AGENTS.md CLAUDE.md README.md HANDOFF.md docs/DESIGN.md docs/DECISIONS.md docs/CONTRACTS.md docs/API.md docs/CHECKPOINTS.md missions/build-joyride.md; do test -s "$f" && echo "ok $f" || { echo "MISSING $f"; exit 1; }; done; ls memory/entries/dec-*.md | wc -l'; }
echo "verdict:"; curl -s -X POST "http://127.0.0.1:${JOYRIDE_PORT:-4317}/api/evidence/verdict/$M" -H 'content-type: application/json' -d '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(v.verdict??v.error);for(const c of v.per_criterion??[])console.log(" ",c.verdict.padEnd(12),c.criterion.slice(0,90))})'
