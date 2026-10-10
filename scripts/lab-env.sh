# Shared lab paths, sourced by scripts/lab-*.sh: . "$(dirname "$0")/lab-env.sh"
# FM_VENDOR is the pinned Firstmate checkout. A linked worktree borrows the main checkout's copy.
LAB_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
LAB_MAIN="$(dirname "$(git -C "$LAB_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$LAB_ROOT/.git")")"
FM_VENDOR="${JOYRIDE_FIRSTMATE_DIR:-}"
if [ -z "$FM_VENDOR" ]; then
  for d in "$LAB_ROOT/vendor/firstmate" "$LAB_MAIN/vendor/firstmate"; do [ -d "$d" ] && { FM_VENDOR="$d"; break; }; done
fi
FM_VENDOR="${FM_VENDOR:-$LAB_ROOT/vendor/firstmate}"
