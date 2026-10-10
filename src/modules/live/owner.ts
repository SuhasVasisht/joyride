// Who owns a live worker. Firstmate's record is the only authority over a crewmate's pane, so crew
// identity comes from what the task's meta recorded (its Herdr pane) or from the FM_TASK_ID that
// fm-spawn exports into the pane (Claude's hooks report it). It is never guessed from the cwd: a
// captain session opened inside a crew worktree is still the captain's.
import type { WorkerOwner } from "../../shared/schema.ts";

/** One Firstmate task as the owner check needs it. `machine` is null when its Herdr session maps to no machine. */
export type CrewKey = { task: string; mission: string | null; machine: string | null; pane: string | null; pid?: number | null };

export type OwnerResult = WorkerOwner & { mission: string | null };

const WATCHED: OwnerResult = { tier: "watched", task: null, via: null, mission: null };

/**
 * In order: Firstmate's own pane, the task whose recorded pane is this worker's pane, the task named
 * by the session's FM_TASK_ID, else watched. FM_TASK_ID only counts for a task of this home, and not
 * when that task's record names a different pane on the same machine: the record wins.
 */
export function resolveOwner(
  w: { id: string; machine: string; pane: string | null; pid?: number | null },
  fmTask: string | null | undefined,
  keys: CrewKey[],
  controlId: string | null,
): OwnerResult {
  if (controlId && w.id === controlId) return { tier: "control", task: null, via: "control", mission: null };
  if (w.pane) {
    const k = keys.find((x) => x.pane === w.pane && x.machine === w.machine);
    if (k) return { tier: "crew", task: k.task, via: "pane", mission: k.mission };
  }
  const byPid = keys.find((k) => w.pid != null && k.pid === w.pid && k.machine === w.machine);
  if (byPid) return { tier: "crew", task: byPid.task, via: "pid", mission: byPid.mission };
  if (fmTask) {
    const k = keys.find((x) => x.task === fmTask);
    if (k && !(k.pane && k.machine === w.machine && k.pane !== w.pane)) return { tier: "crew", task: k.task, via: "env", mission: k.mission };
  }
  return WATCHED;
}
