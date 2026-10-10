// The fleet roster: one row per live session but Firstmate's own pane, with its owner tier, helm and
// inferred state. Pure, so the daemon, the CLI and the tests read the same rows.
import type { AttentionItem, WorkerHelm, WorkerView } from "../../shared/schema.ts";
import { inferState, type FleetState } from "./state.ts";

export type FleetMember = {
  worker: string; session: string | null; agent: string; machine: string;
  tier: "crew" | "watched" | "excluded"; task: string | null;
  helm: WorkerHelm | null;
  /** Inferred from Herdr, hooks and attention: watched sessions write no Firstmate status lines. */
  state: FleetState; why: string; inferred: true;
  title: string; goal: string | null; cwd: string; repo: string | null; mission: string | null;
  status: string; controllable: boolean; updated: string; current_action: string;
};

export type FleetCounts = { crew: number; watched: number; excluded: number; needs_you: number; captain_helm: number };

export function roster(workers: WorkerView[], attention: AttentionItem[], goalOf: (session: string) => string | null = () => null): FleetMember[] {
  const out: FleetMember[] = [];
  for (const w of workers) {
    const tier = w.owner?.tier ?? "watched";
    if (tier === "control") continue;
    const s = inferState(w, attention);
    out.push({
      worker: w.id, session: w.session, agent: w.agent, machine: w.machine, tier, task: tier === "crew" ? w.owner?.task ?? w.crew : null,
      helm: w.helm, state: s.state, why: s.why, inferred: true,
      title: w.title, goal: w.session ? goalOf(w.session) : null, cwd: w.cwd, repo: w.repo, mission: w.mission,
      status: w.status, controllable: w.controllable, updated: w.updated, current_action: w.current_action,
    });
  }
  return out;
}

export function counts(members: FleetMember[]): FleetCounts {
  const c: FleetCounts = { crew: 0, watched: 0, excluded: 0, needs_you: 0, captain_helm: 0 };
  for (const m of members) {
    c[m.tier]++;
    if (m.tier !== "excluded" && (m.state === "blocked" || m.state === "needs-decision" || m.state === "failed")) c.needs_you++;
    if (m.helm?.by === "captain") c.captain_helm++;
  }
  return c;
}
