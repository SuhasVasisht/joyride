#!/usr/bin/env bash
# Native Codex proof through New. Every Herdr lifecycle action belongs to the guarded lab.
set -eu
. "$(dirname "$0")/lab-env.sh"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
PORT="${1:-4327}"
case "$PORT" in 432[0-9]) ;; *) echo 'Use a private preview port 4320-4329.' >&2; exit 2;; esac
HERDR_LAB_HELPER="$FM_VENDOR/bin/fm-herdr-lab.sh"
LAB_HOME_HELPER="$FM_VENDOR/bin/fm-lab-home.sh"
WORK=$(mktemp -d "$ROOT/.joyride/standalone-lab.XXXXXX")
FM_HOME="$WORK/firstmate"
LAB_TMUX_DIR=''
HERDR_LAB_SESSION=$("$HERDR_LAB_HELPER" name jr-new-standalone)
cleanup() {
  local rc=$?
  if [ -n "$LAB_TMUX_DIR" ]; then TMUX_TMPDIR="$LAB_TMUX_DIR" tmux kill-server >/dev/null 2>&1 || true; fi
  if [ -f "$FM_HOME/.fm-lab-home" ]; then "$LAB_HOME_HELPER" teardown "$FM_HOME" || rc=1; fi
  if "$HERDR_LAB_HELPER" teardown "$HERDR_LAB_SESSION"; then echo "Guarded teardown verified the identical running default fleet state."; else rc=1; fi
  # Preserve the private transcripts for diagnosis; credentials remain private and gitignored.
  exit "$rc"
}
trap cleanup EXIT
"$LAB_HOME_HELPER" create "$FM_HOME" >/dev/null
"$HERDR_LAB_HELPER" provision "$HERDR_LAB_SESSION"
"$HERDR_LAB_HELPER" run "$HERDR_LAB_SESSION" status --json
SOCKET="$HOME/.config/herdr/sessions/$HERDR_LAB_SESSION/herdr.sock"
CFG="$WORK/codex"
PROJECT="$WORK/project"
mkdir -p "$CFG" "$PROJECT"
git -C "$PROJECT" init -q
printf 'Standalone lab context\n' > "$PROJECT/README.md"
# Copy login/config/catalog into this worktree. Retain every model/provider/account pin.
# Only hooks are disabled, so the lab cannot write events to the protected live daemon.
python3 - "$CFG" "$PROJECT" <<'PY'
import os, pathlib, re, shutil, sys
cfg, project = map(pathlib.Path, sys.argv[1:])
source = pathlib.Path(os.environ.get('CODEX_HOME', str(pathlib.Path.home()/'.codex')))
for name in ['auth.json','config.toml','models_cache.json']:
    if (source/name).exists(): shutil.copy2(source/name,cfg/name)
if not (cfg/'auth.json').exists(): raise SystemExit('The Codex account has no auth.json. Native proof cannot launch.')
os.chmod(cfg/'auth.json',0o600)
file = cfg/'config.toml'
text = file.read_text() if file.exists() else ''
lines = text.splitlines(); result=[]; in_features=False; saw_features=False; wrote=False
for line in lines:
    if line.strip().startswith('['):
        if in_features and not wrote: result.append('hooks = false'); wrote=True
        in_features = line.strip() == '[features]'
        if in_features: saw_features=True
    if in_features and re.match(r'\s*hooks\s*=',line): line='hooks = false'; wrote=True
    result.append(line)
if in_features and not wrote: result.append('hooks = false')
if not saw_features: result.extend(['[features]','hooks = false'])
result.extend(['',f'[projects."{project}"]','trust_level = "trusted"'])
file.write_text('\n'.join(result)+'\n')
print('Native lab credentials and config copied; model/provider/account pins preserved.')
PY
export E2E_NEW_NATIVE=1 E2E_NEW_LAB_PROJECT="$PROJECT"
export E2E_LAB_HERDR_SOCKET="$SOCKET" E2E_LAB_CODEX_DIR="$CFG" E2E_LAB_FM_HOME="$FM_HOME"
export E2E_NEW_LAB_SESSION="$HERDR_LAB_SESSION"
export JOYRIDE_FIRSTMATE_DIR="$FM_VENDOR"
scripts/e2e.sh "$PORT" tests/e2e/new-real-standalone.spec.ts --workers=1
