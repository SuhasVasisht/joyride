// The Agents page as data: every agent and session (Firstmate's crew tasks with their crewmates, the
// captain's watched and kept sessions, and recently closed sessions) as one row each, grouped by the
// same groups and ideas the map uses, with "Not in an idea yet" by project for the rest. Filters
// and the old pages' routes all become one query string. Pure, so it is unit-tested apart
// from React.
import type { Ask } from "../../../shared/asks";
import type { AttentionItem, Lens, MissionProposal, SessionView, WorkerView } from "../../lib/types";
import { statusOf, type CrewTask } from "../crew/crew";
import { needsCaptain, projectOf, type Project } from "../fleet/model";
import { groupOfIdea, type IdeaGroup } from "../map/layout";
import { crewTaskOf } from "../map/plane";
import type { MissionH, Spec } from "../map/world";

export type Owner = "crew" | "yours";
export type RunState = "running" | "idle" | "done";
type Attn = Pick<AttentionItem, "level" | "worker" | "session" | "title">;

/** A pending idea proposal that covers this row's session: "looks like idea X, file it". */
export type Suggestion = { id: string; title: string; merge_into: string | null; sessions: number };

export type AgentRow = {
  /** w:<worker id>, t:<task id> or s:<session key>. */
  key: string;
  kind: "worker" | "task" | "session";
  owner: Owner;
  state: RunState;
  /** Why it needs the captain right now, else null. */
  needs: string | null;
  yourHelm: boolean;
  mission: string | null;
  project: Project;
  updated: string;
  /** The transcript key, for goals and proposals. */
  session: string | null;
  worker?: WorkerView;
  task?: CrewTask;
  /** A task's live crewmates. */
  crew?: WorkerView[];
  closed?: SessionView;
  asks: Ask[];
  suggestion: Suggestion | null;
};

const refKey = (r: { source: string; id: string }) => `${r.source}:${r.id}`;

/** Live, idle or finished, from the shared status helpers so the buckets follow their labels. */
export function workerState(status: string): RunState {
  if (status === "working" || status === "blocked") return "running";
  if (status === "done" || status === "exited") return "done";
  return "idle";
}
export function taskState(t: Pick<CrewTask, "status" | "section"> & { last_event?: string }, crew: Pick<WorkerView, "status">[] = []): RunState {
  if (crew.some((w) => workerState(w.status) === "running")) return "running";
  // A finished task whose crewmate is still live stays in view, as it does on the map.
  if (crew.some((w) => workerState(w.status) === "idle")) return "idle";
  if (t.section === "done") return "done";
  const chip = statusOf(t.status, t.last_event ?? "").chip;
  if (chip === "working" || chip === "blocked") return "running";
  if (chip === "done" || chip === "fail") return "done";
  return "idle";
}

export type AgentInput = {
  workers: WorkerView[];
  tasks: CrewTask[];
  sessions: SessionView[];
  missions: Pick<MissionH, "id" | "sessions" | "crews">[];
  attention: Attn[];
  asks: Ask[];
  proposals: Pick<MissionProposal, "id" | "title" | "sessions" | "merge_into" | "status">[];
  /** Firstmate's own pane: shown in the page header, never as a row. */
  controlId?: string | null;
  /** Firstmate's checkout: its own past sessions belong to it, not to a project. */
  firstmateDir?: string | null;
};

/**
 * One row per agent. A crewmate sits on its task's row; a task with no idea and a session with no idea
 * are unfiled. Closed sessions are those no live worker holds now; a session in a crew task's worktree
 * was crew.
 */
export function agentRows(input: AgentInput): AgentRow[] {
  const sessionMission = new Map<string, string>();
  for (const m of input.missions) for (const r of m.sessions) sessionMission.set(refKey(r), m.id);
  const taskMission = new Map<string, string>();
  for (const m of input.missions) for (const t of m.crews ?? []) taskMission.set(t, m.id);
  const taskRepo = new Map(input.tasks.map((t) => [t.id, t.repo ?? null]));
  const known = new Set(input.missions.map((m) => m.id));
  const idea = (id: string | null | undefined) => (id && known.has(id) ? id : null);
  const proposalOf = new Map<string, Suggestion>();
  for (const p of input.proposals) {
    if ((p.status ?? "pending") !== "pending") continue;
    for (const r of p.sessions) proposalOf.set(refKey(r), { id: p.id, title: p.title, merge_into: p.merge_into ?? null, sessions: p.sessions.length });
  }
  const asksFor = (pred: (a: Ask) => boolean) => input.asks.filter((a) => a.kind !== "nudge" && pred(a));
  const askNeeds = (asks: Ask[]) => asks.find((a) => a.needs_you)?.title ?? null;

  const rows: AgentRow[] = [];
  const byTask = new Map(input.tasks.map((t) => [t.id, [] as WorkerView[]]));
  const live = new Set<string>();
  for (const w of input.workers) {
    if (w.session) live.add(w.session);
    if (w.id === input.controlId || w.owner?.tier === "control") continue;
    const tid = crewTaskOf(w);
    if (tid && byTask.has(tid)) { byTask.get(tid)!.push(w); continue; }
    const tier = w.owner?.tier ?? "watched";
    const asks = asksFor((a) => a.worker === w.id || (!!w.session && a.session === w.session));
    const mission = idea(w.mission) ?? (w.session ? idea(sessionMission.get(w.session)) : null) ?? (tid ? idea(taskMission.get(tid)) : null);
    rows.push({
      key: `w:${w.id}`, kind: "worker", owner: tier === "crew" ? "crew" : "yours", state: workerState(w.status),
      needs: needsCaptain(w, input.attention) ?? askNeeds(asks), yourHelm: w.helm?.by === "captain",
      mission, project: projectOf(w, taskRepo), updated: w.updated, session: w.session, worker: w, asks,
      suggestion: !mission && w.session ? proposalOf.get(w.session) ?? null : null,
    });
  }
  for (const t of input.tasks) {
    const crew = byTask.get(t.id) ?? [];
    const crewIds = new Set(crew.map((w) => w.id));
    const asks = asksFor((a) => a.task === t.id || (a.place.on === "task" && a.place.id === t.id) || (!!a.worker && crewIds.has(a.worker)));
    const needs = askNeeds(asks) ?? crew.map((w) => needsCaptain(w, input.attention)).find(Boolean) ?? null;
    const updated = [t.updated ?? "", ...crew.map((w) => w.updated)].sort().pop() || "";
    rows.push({
      key: `t:${t.id}`, kind: "task", owner: "crew", state: taskState(t, crew), needs, yourHelm: crew.some((w) => w.helm?.by === "captain"),
      mission: idea(t.mission) ?? idea(taskMission.get(t.id)), project: projectOf({ repo: t.repo ?? t.worktree, crew: t.id }, taskRepo),
      updated, session: null, task: t, crew, asks, suggestion: null,
    });
  }
  const fmDir = input.firstmateDir?.replace(/\/+$/, "");
  const worktrees = input.tasks.filter((t) => t.worktree).map((t) => ({ id: t.id, dir: t.worktree!.replace(/\/+$/, "") }));
  const inside = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir + "/");
  for (const s of input.sessions) {
    if (live.has(s.key) || s.archived) continue;
    if (fmDir && inside(s.cwd, fmDir)) continue;
    const crewOf = worktrees.find((x) => inside(s.cwd, x.dir))?.id ?? null;
    const mission = idea(s.mission) ?? idea(sessionMission.get(s.key)) ?? (crewOf ? idea(taskMission.get(crewOf) ?? input.tasks.find((t) => t.id === crewOf)?.mission) : null);
    rows.push({
      key: `s:${s.key}`, kind: "session", owner: crewOf ? "crew" : "yours", state: "done", needs: null, yourHelm: false,
      mission, project: projectOf({ repo: s.repo, cwd: s.cwd, crew: crewOf }, taskRepo), updated: s.updated, session: s.key, closed: s, asks: [],
      suggestion: mission ? null : proposalOf.get(s.key) ?? null,
    });
  }
  return rows;
}

// ---------- filters ----------

export type Show = "all" | "needs-you" | "your-helm" | "suggested";
export type OwnerFilter = "all" | Owner;
export type StateFilter = "all" | RunState;
export type Order = "ideas" | "recent";
export type AgentFilter = { show: Show; owner: OwnerFilter; state: StateFilter; order: Order };
export const DEFAULT_FILTER: AgentFilter = { show: "all", owner: "all", state: "all", order: "ideas" };

export const SHOW: { id: Show; label: string }[] = [
  { id: "all", label: "All" }, { id: "needs-you", label: "Needs you" }, { id: "your-helm", label: "At your helm" }, { id: "suggested", label: "Suggested ideas" },
];
export const OWNERS: { id: OwnerFilter; label: string; title: string }[] = [
  { id: "all", label: "Everyone", title: "Crew and your own sessions" },
  { id: "crew", label: "Crew", title: "Firstmate's tasks and the crewmates it launched for them" },
  { id: "yours", label: "Yours", title: "Sessions you started, including those you keep to yourself" },
];
export const STATES: { id: StateFilter; label: string }[] = [
  { id: "all", label: "Any state" }, { id: "running", label: "Running" }, { id: "idle", label: "Idle" }, { id: "done", label: "Done" },
];
export const ORDERS: { id: Order; label: string }[] = [{ id: "ideas", label: "By idea" }, { id: "recent", label: "Most recent" }];

const pick = <T extends string>(v: string | null, ok: { id: T }[], d: T): T => (ok.some((o) => o.id === v) ? (v as T) : d);
export function parseFilter(q: URLSearchParams): AgentFilter {
  return {
    show: pick(q.get("show"), SHOW, "all"), owner: pick(q.get("owner"), OWNERS, "all"), state: pick(q.get("state"), STATES, "all"),
    order: pick(q.get("order"), ORDERS, "ideas"),
  };
}
/** "agents?show=needs-you&owner=crew": defaults are left out, so the plain page is plain #/agents. */
export function filterPath(f: Partial<AgentFilter>): string {
  const q = new URLSearchParams();
  const all = { ...DEFAULT_FILTER, ...f };
  for (const k of ["show", "owner", "state", "order"] as const) if (all[k] && all[k] !== DEFAULT_FILTER[k]) q.set(k, String(all[k]));
  const s = q.toString();
  return s ? `agents?${s}` : "agents";
}

export function matches(r: AgentRow, f: Pick<AgentFilter, "show" | "owner" | "state">): boolean {
  if (f.show === "needs-you" && !r.needs) return false;
  if (f.show === "your-helm" && !r.yourHelm) return false;
  if (f.owner !== "all" && r.owner !== f.owner) return false;
  if (f.state !== "all" && r.state !== f.state) return false;
  return true;
}

/** How many rows each choice would show, with the other choices kept. */
export function facetCounts(rows: AgentRow[], f: AgentFilter) {
  const n = (g: Partial<AgentFilter>) => rows.filter((r) => matches(r, { ...f, ...g })).length;
  return {
    show: Object.fromEntries(SHOW.map((s) => [s.id, s.id === "suggested" ? 0 : n({ show: s.id })])) as Record<Show, number>,
    owner: Object.fromEntries(OWNERS.map((o) => [o.id, n({ owner: o.id })])) as Record<OwnerFilter, number>,
    state: Object.fromEntries(STATES.map((s) => [s.id, n({ state: s.id })])) as Record<StateFilter, number>,
  };
}

// ---------- grouping ----------

export type IdeaBlock = { id: string; title: string; mission: string | null; rows: AgentRow[] };
export type AgentGroup = { id: string; title: string; kind: IdeaGroup["kind"] | "unfiled"; ideas: IdeaBlock[]; count: number };
export const UNFILED = "unfiled";

const rank = (r: AgentRow) => (r.needs ? 0 : r.state === "running" ? 1 : r.state === "idle" ? 2 : 3);
const byUrgency = (a: AgentRow, b: AgentRow) => rank(a) - rank(b) || b.updated.localeCompare(a.updated);
const blockRank = (rows: AgentRow[]) => Math.min(4, ...rows.map(rank));
const newest = (rows: AgentRow[]) => rows.reduce((m, r) => (r.updated > m ? r.updated : m), "");

/**
 * Rows into the map's groups and ideas: each idea sits in the group the map draws it in (spec region,
 * lens, repo or health), and rows outside any idea sit in "Not in an idea yet", one block per project.
 * Groups and ideas with someone needing you come first, then running ones, then the most recent.
 */
export function groupRows(rows: AgentRow[], missions: Pick<MissionH, "id" | "title" | "goal" | "repos" | "lenses" | "health">[], lenses: Lens[], spec: Spec | null): AgentGroup[] {
  const byId = new Map(missions.map((m) => [m.id, m]));
  const groups = new Map<string, AgentGroup & { blocks: Map<string, IdeaBlock> }>();
  const at = (g: { id: string; title: string; kind: AgentGroup["kind"] }, b: { id: string; title: string; mission: string | null }) => {
    let grp = groups.get(g.id);
    if (!grp) groups.set(g.id, (grp = { ...g, ideas: [], count: 0, blocks: new Map() }));
    let blk = grp.blocks.get(b.id);
    if (!blk) grp.blocks.set(b.id, (blk = { ...b, rows: [] }));
    return blk;
  };
  for (const r of rows) {
    const m = r.mission ? byId.get(r.mission) : undefined;
    if (m) {
      const g = groupOfIdea(m, lenses, spec);
      at(g, { id: `idea:${m.id}`, title: m.title, mission: m.id }).rows.push(r);
    } else {
      at({ id: UNFILED, title: "Not in an idea yet", kind: "unfiled" }, { id: `project:${r.project.key || "none"}`, title: r.project.title, mission: null }).rows.push(r);
    }
  }
  const out = [...groups.values()].map(({ blocks, ...g }) => {
    const ideas = [...blocks.values()];
    for (const b of ideas) b.rows.sort(byUrgency);
    ideas.sort((a, b) => blockRank(a.rows) - blockRank(b.rows) || newest(b.rows).localeCompare(newest(a.rows)) || a.title.localeCompare(b.title));
    return { ...g, ideas, count: ideas.reduce((n, b) => n + b.rows.length, 0) };
  });
  const all = (g: AgentGroup) => g.ideas.flatMap((b) => b.rows);
  // "Not in an idea yet" always comes last, after every group the map draws.
  return out.sort((a, b) => Number(a.kind === "unfiled") - Number(b.kind === "unfiled") || blockRank(all(a)) - blockRank(all(b)) || newest(all(b)).localeCompare(newest(all(a))) || a.title.localeCompare(b.title));
}

/** "Most recent": every row in one list, newest activity first. */
export const recentRows = (rows: AgentRow[]) => [...rows].sort((a, b) => b.updated.localeCompare(a.updated));

// ---------- old routes ----------

const FLEET_SHOW: Record<string, Partial<AgentFilter>> = {
  crew: { owner: "crew" }, watched: { owner: "yours" }, "yours-only": { owner: "yours" }, "needs-you": { show: "needs-you" }, "your-helm": { show: "your-helm" },
};

/**
 * Where an old page's route lands on the Agents page: #/fleet and its tabs, #/task and #/crew (the
 * crew list; a task id keeps its sheet), #/proposals, and #/view with a saved view. Null when the
 * route is not an old page.
 */
export function legacyTarget(route: { name: string; params: string[]; query: URLSearchParams }): string | null {
  switch (route.name) {
    case "fleet": return filterPath(FLEET_SHOW[route.query.get("show") ?? ""] ?? {});
    case "task": case "crew": return route.params[0] ? null : filterPath({ owner: "crew" });
    case "proposals": return filterPath({ show: "suggested" });
    case "view": case "views": case "evolve": case "hillclimb": case "capabilities": case "learnings": return "agents";
    default: return null;
  }
}
