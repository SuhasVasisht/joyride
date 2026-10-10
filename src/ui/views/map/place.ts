// Where a live worker sits on the map. Pure, so the rule is unit-tested apart from React.
import type { MissionProposal, WorkerView } from "../../lib/types";
import { projectOf, type Project } from "../fleet/model";

/** Where a live worker sits on the map. */
export type Placement = { at: "control" } | { at: "mission"; mission: string } | { at: "unfiled" };

/**
 * Groups say what the work is, never who launched it: a worker goes to its session's mission, else
 * its crew task's mission, so a crewmate on a mission's task sits in that mission. Firstmate's own
 * pane is the Firstmate node; everyone else, crew or not, is unfiled under its project.
 */
export function placeWorker(
  w: Pick<WorkerView, "id" | "mission" | "session" | "crew" | "owner">,
  c: { controlId: string | null; sessionMission: Map<string, string>; taskMission: Map<string, string | null>; missions: Set<string> },
): Placement {
  if (w.id === c.controlId || w.owner?.tier === "control") return { at: "control" };
  const crewTask = w.crew ?? (w.owner?.tier === "crew" ? w.owner.task : null);
  const mid = w.mission ?? (w.session ? c.sessionMission.get(w.session) : undefined) ?? (crewTask ? c.taskMission.get(crewTask) : null) ?? null;
  if (mid && c.missions.has(mid)) return { at: "mission", mission: mid };
  return { at: "unfiled" };
}

type Session = { key: string; repo: string | null; cwd: string };
/** One project's unfiled work: live workers, quiet ones, recent sessions, and pending mission proposals. */
export type UnfiledGroup<W, S> = Project & { workers: W[]; quiet: W[]; sessions: S[]; proposals: number };

/**
 * Unfiled work grouped by project. Groups with someone blocked come first, then those with someone
 * working, then the busiest; a project with only proposals gets no group.
 */
export function groupUnfiled<W extends Pick<WorkerView, "status" | "repo" | "cwd" | "crew">, S extends Session>(
  input: { workers: W[]; quiet?: W[]; sessions?: S[]; proposals?: Pick<MissionProposal, "repos">[] },
  taskRepo?: Map<string, string | null>,
): UnfiledGroup<W, S>[] {
  const out = new Map<string, UnfiledGroup<W, S>>();
  const at = (p: Project) => { let g = out.get(p.key); if (!g) out.set(p.key, (g = { ...p, workers: [], quiet: [], sessions: [], proposals: 0 })); return g; };
  for (const w of input.workers) at(projectOf(w, taskRepo)).workers.push(w);
  for (const w of input.quiet ?? []) at(projectOf(w, taskRepo)).quiet.push(w);
  for (const s of input.sessions ?? []) at(projectOf(s)).sessions.push(s);
  for (const p of input.proposals ?? []) { const g = out.get(projectOf({ repo: p.repos[0] ?? null }).key); if (g) g.proposals++; }
  const rank = (g: UnfiledGroup<W, S>) => (g.workers.some((w) => w.status === "blocked") ? 0 : g.workers.some((w) => w.status === "working") ? 1 : 2);
  const size = (g: UnfiledGroup<W, S>) => g.workers.length + g.quiet.length + g.sessions.length;
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || size(b) - size(a) || (a.key ? 0 : 1) - (b.key ? 0 : 1) || a.title.localeCompare(b.title));
}

/** Unfiled work stays on the chart while there is something to act on: a worker working, blocked, or active in the last half hour. */
export const ACTIVE_MS = 30 * 60e3;
export const hasWorkLeft = (w: Pick<WorkerView, "status" | "updated">, now: number) =>
  w.status === "working" || w.status === "blocked" || now - Date.parse(w.updated) < ACTIVE_MS;

/** Set aside on the map: hidden until it does something new (its update is newer than the time it was set aside). */
export function setAside(w: Pick<WorkerView, "id" | "session" | "updated">, hidden: Record<string, string>): boolean {
  const at = (w.session && hidden[w.session]) || hidden[w.id];
  return Boolean(at && w.updated <= at);
}

type HeldLens = { id: string; sessions: string[]; projects: string[] };
/** What a group holds outside its ideas: sessions dropped on it (live or not), and its projects' unfiled work. */
export type Held<W, S> = { workers: W[]; sessions: S[]; projects: string[] };

/**
 * Split unfiled work between groups and Unfiled. A session a group names sits in that group whatever
 * its state; otherwise a worker with work left goes to the group that holds its project's unfiled work,
 * else to Unfiled. Workers with nothing left to do leave the chart (the Agents page lists them).
 */
export function holdInGroups<W extends Pick<WorkerView, "id" | "session" | "status" | "updated" | "repo" | "cwd" | "crew">, S extends { key: string }>(
  lenses: HeldLens[],
  input: { workers: W[]; sessions: S[] },
  now: number,
  taskRepo?: Map<string, string | null>,
): { byLens: Map<string, Held<W, S>>; workers: W[] } {
  const byLens = new Map<string, Held<W, S>>();
  const at = (id: string) => { let h = byLens.get(id); if (!h) byLens.set(id, (h = { workers: [], sessions: [], projects: lenses.find((l) => l.id === id)?.projects ?? [] })); return h; };
  const bySession = new Map<string, string>();
  for (const l of lenses) for (const k of l.sessions) if (!bySession.has(k)) bySession.set(k, l.id);
  const byProject = new Map<string, string>();
  for (const l of lenses) for (const p of l.projects) if (!byProject.has(p)) byProject.set(p, l.id);
  const workers: W[] = [];
  for (const w of input.workers) {
    const named = w.session ? bySession.get(w.session) : undefined;
    if (named) { at(named).workers.push(w); continue; }
    if (!hasWorkLeft(w, now)) continue;
    const proj = byProject.get(projectOf(w, taskRepo).key);
    if (proj) at(proj).workers.push(w); else workers.push(w);
  }
  for (const s of input.sessions) { const named = bySession.get(s.key); if (named) at(named).sessions.push(s); }
  return { byLens, workers };
}
