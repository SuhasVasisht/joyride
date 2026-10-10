import { firstmateStatus } from "../../lib/firstmate-status";
// The world as the UI sees it: missions (with health), live workers, open
// attention, lenses, verdicts and the workspace spec, joined client-side.
import { useMemo } from "react";
import { useApi } from "../../lib/api";
import type { AttentionItem, Lens, Mission, SessionView, WorkerView } from "../../lib/types";
import { useFirstmate, type CrewTask, type FirstmateStatus } from "../crew/crew";
import { placeWorker } from "./place";
import { fleetCounts, rankOf, type FleetCounts } from "../fleet/model";
import type { Ask, AsksResponse } from "../../../shared/asks";
import { buildPlane, crewTaskOf, placeReplies, readableAction, type MapReply, type MapTask, type PlaneTask } from "./plane";

export type MissionH = Mission & { health: "active" | "blocked" | "needs-review" | "idle"; health_why: string };
export type CriterionResult = { id: string; criterion: string; verdict: "pass" | "fail" | "insufficient"; p?: number; reason?: string };
export type VerdictRec = { id: string; mission: string; verdict: "pass" | "fail" | "insufficient"; per_criterion: CriterionResult[]; created: string; confidence?: number | null; reason?: string };
/** An artifact as the map shows it: a chip that opens it. Any kind renders, so new kinds need no map change. */
export type MapArtifact = { id: string; title: string; kind: string; url: string | null; session: string | null; mission: string | null; created: string };
export type MapWorker = WorkerView & { artifacts?: MapArtifact[] };
export type MapTaskW = MapTask<MapWorker> & { artifacts: MapArtifact[]; replies?: MapReply[] };
/**
 * An idea on the chart. `workers` are the live sessions that sit in it directly (captain sessions);
 * crewmates sit inside their task's card in `tasks`. `asks` are pinned to the idea itself.
 */
export type MapMission = MissionH & {
  workers: MapWorker[]; attention: AttentionItem[]; verdict: VerdictRec | null; artifacts: MapArtifact[];
  tasks: MapTaskW[]; landed: MapTaskW[]; asks: Ask[]; nudges: Ask[];
  /** Firstmate's replies to map requests filed into this idea (and not on one of its task cards). */
  replies?: MapReply[];
};
export type Spec = {
  title?: string;
  home?: { group_by?: "lens" | "repo" | "health" | "none"; show_archive?: boolean; regions?: { id: string; title: string; lens?: string; repo?: string }[]; rail?: string[] };
};

/**
 * Firstmate's own node on the chart, the fleet bridge: its control session (the Herdr pane Joyride
 * launched), the fleet's counts (crew, watched, needing the captain, at the captain's helm) and the
 * counts the captain acts on. It moors no workers: they sit with their mission or project.
 */
export type FirstmateNode = {
  status: FirstmateStatus | null;
  error: string | null;
  /** The control session's live worker, when Herdr reports it. */
  worker: WorkerView | null;
  fleet: FleetCounts;
  inFlight: number;
  /** Decisions Firstmate is holding for the captain. */
  calls: number;
  /** What the crew is doing right now, one line per task in flight: the node's ticker. */
  log: { id: string; who: string; what: string; status: string }[];
  /** Asks with nowhere else to sit (Firstmate's own, or a task the map can't place). */
  asks: Ask[];
  /** Open tasks no idea names yet, until housekeeping files them. */
  orphans: MapTaskW[];
  /** Asks the captain owns right now, across the chart; null until /api/asks answers. */
  needsYou: number | null;
  /** Replies to map requests whose task and idea are not on the chart. */
  replies?: MapReply[];
};
const CALL_STATUSES = new Set(["needs-decision", "held"]);

export { rankOf };
/** Archived, dropped and done ideas leave the chart; Show archive brings them back. */
export const offChart = (m: Pick<Mission, "archive" | "state">) => m.archive || m.state === "dropped" || m.state === "done";
export const refKey = (r: { source: string; id: string }) => `${r.source}:${r.id}`;

/** The workspace spec; served by the map module at /api/workspace/spec. */
export function useSpec(): Spec | null {
  const { data } = useApi<Spec>("/api/workspace/spec", ["workspace"]);
  return data ?? null;
}

export function useWorld() {
  const missions = useApi<MissionH[]>("/api/missions", ["missions", "attention", "workers", "verdicts", "evidence"]);
  const workers = useApi<WorkerView[]>("/api/workers", ["workers"]);
  const attention = useApi<AttentionItem[]>("/api/attention?open=1&limit=500", ["attention"]);
  const lenses = useApi<Lens[]>("/api/lenses", ["lenses"]);
  const verdicts = useApi<VerdictRec[]>("/api/evidence/verdicts?limit=500", ["verdicts", "evidence"]);
  const fm = useFirstmate();
  const fmTasks = useApi<CrewTask[]>("/api/firstmate/tasks", ["tasks", "workers"]);
  const artifacts = useApi<MapArtifact[]>("/api/artifacts?limit=500", ["artifacts", "missions"]);
  const asks = useApi<AsksResponse>("/api/asks", ["asks"]);
  const replies = useApi<MapReply[]>("/api/firstmate/replies", ["requests", "tasks", "missions"]);

  const joined = useMemo(() => {
    const ms = missions.data ?? [];
    const sessionMission = new Map<string, string>();
    for (const m of ms) for (const r of m.sessions) sessionMission.set(refKey(r), m.id);
    const workerMission = (w: WorkerView) => w.mission ?? (w.session ? sessionMission.get(w.session) ?? null : null);
    const ws = workers.data ?? [];
    const workerById = new Map(ws.map((w) => [w.id, w]));
    const attnMission = (a: AttentionItem): string | null => {
      if (a.mission) return a.mission;
      const viaSession = a.session ? sessionMission.get(a.session) : undefined;
      if (viaSession) return viaSession;
      const w = a.worker ? workerById.get(a.worker) : undefined;
      return w ? workerMission(w) : null;
    };
    const latest = new Map<string, VerdictRec>();
    for (const v of verdicts.data ?? []) { const cur = latest.get(v.mission); if (!cur || v.created > cur.created) latest.set(v.mission, v); }
    // Newest first from the API; a mission's chips are the artifacts linked to it or to one of its sessions.
    const artifactsBySession = new Map<string, MapArtifact[]>();
    const artifactsByMission = new Map<string, MapArtifact[]>();
    const push = (m: Map<string, MapArtifact[]>, k: string, a: MapArtifact) => { const l = m.get(k); if (l) l.push(a); else m.set(k, [a]); };
    for (const a of artifacts.data ?? []) {
      if (a.session) push(artifactsBySession, a.session, a);
      const mid = a.mission ?? (a.session ? sessionMission.get(a.session) : undefined);
      if (mid) push(artifactsByMission, mid, a);
    }
    const byMission = new Map<string, MapMission>();
    for (const m of ms) byMission.set(m.id, { ...m, workers: [], attention: [], verdict: latest.get(m.id) ?? null, artifacts: artifactsByMission.get(m.id) ?? [], tasks: [], landed: [], asks: [], nudges: [], replies: [] });
    // Firstmate's control session is the Firstmate node; every other worker sits with its mission, or unfiled under its project.
    const controlId = fm.data?.pane?.worker ?? null;
    const taskMission = new Map((fmTasks.data ?? []).map((t) => [t.id, t.mission ?? null]));
    const taskRepo = new Map((fmTasks.data ?? []).map((t) => [t.id, t.repo ?? null]));
    const place = { controlId, sessionMission, taskMission, missions: new Set(byMission.keys()) };
    const unfiledWorkers: MapWorker[] = [];
    const tasks = fmTasks.data ?? [];
    const known = new Set(tasks.map((t) => t.id));
    const withArt = (w0: WorkerView): MapWorker => { const art = w0.session ? artifactsBySession.get(w0.session) : undefined; return art ? { ...w0, artifacts: art } : w0; };
    const crew: MapWorker[] = [];
    for (const w0 of ws) {
      const p = placeWorker(w0, place);
      if (p.at === "control") continue;
      const w = withArt(w0);
      // A crewmate sits inside its task's card, never loose in an idea or unfiled.
      const tid = crewTaskOf(w0);
      if (tid && known.has(tid)) { crew.push(w); continue; }
      if (p.at === "mission") byMission.get(p.mission)!.workers.push(w); else unfiledWorkers.push(w);
    }
    const plane = buildPlane<MapWorker>({ tasks: tasks as PlaneTask[], workers: crew, asks: asks.data?.asks ?? [], missions: new Set(byMission.keys()), controlId });
    // A reply sits on the task card the request became, else its idea (unarchived), else the hub.
    const shownTasks = new Set([...[...plane.tasks.values()].flat(), ...plane.orphans].map((t) => t.id));
    const pinned = placeReplies(replies.data ?? [], shownTasks, new Set(ms.filter((m) => !m.archive).map((m) => m.id)));
    const taskArt = (t: MapTask<MapWorker>): MapTaskW => {
      const seen = new Set<string>(), list: MapArtifact[] = [];
      for (const w of t.crew) for (const a of w.artifacts ?? []) if (!seen.has(a.id)) { seen.add(a.id); list.push(a); }
      return { ...t, artifacts: list, replies: pinned.byTask.get(t.id) ?? [] };
    };
    for (const [mid, l] of pinned.byIdea) byMission.get(mid)!.replies = l;
    for (const [mid, l] of plane.tasks) byMission.get(mid)!.tasks = l.map(taskArt);
    for (const [mid, l] of plane.landed) byMission.get(mid)!.landed = l.map(taskArt);
    for (const [mid, l] of plane.ideaAsks) { const m = byMission.get(mid)!; m.asks = l.filter((a) => a.kind !== "nudge"); m.nudges = l.filter((a) => a.kind === "nudge"); }
    const firstmate: FirstmateNode = {
      status: fm.data ?? null,
      error: fm.data ? null : fm.error,
      worker: controlId ? workerById.get(controlId) ?? null : null,
      fleet: fleetCounts(ws.filter((w) => w.id !== controlId), attention.data ?? []),
      inFlight: fm.data?.tasks.in_flight ?? 0,
      calls: fm.data?.summary ? fm.data.summary.decisions_open : tasks.filter((t) => t.section !== "done" && CALL_STATUSES.has(t.status)).length,
      log: tasks.filter((t) => t.section === "in_flight").map((t) => {
        // Never a raw tool call: the crew's last readable action, else the task's last readable line.
        const live = t.workers.map((x) => readableAction(workerById.get(x.id)?.current_action)).find(Boolean);
        return { id: t.id, who: t.title || t.id, what: t.status === "paused" ? `${firstmateStatus(t.status).label}: ${firstmateStatus(t.status, t.last_event).reason}` : live || readableAction(t.last_event) || firstmateStatus(t.status).label, status: t.status };
      }),
      asks: plane.hubAsks,
      orphans: plane.orphans.map(taskArt),
      needsYou: asks.data ? asks.data.counts.needs_you : null,
      replies: pinned.hub,
    };
    for (const a of attention.data ?? []) {
      const mid = attnMission(a);
      const mm = mid ? byMission.get(mid) : undefined;
      if (mm) mm.attention.push(a);
    }
    return { missions: [...byMission.values()], unfiledWorkers, taskRepo, sessionMission, workerMission, attnMission, firstmate, artifactsBySession, asks: asks.data?.asks ?? [] };
  }, [missions.data, workers.data, attention.data, verdicts.data, fm.data, fm.error, fmTasks.data, artifacts.data, asks.data, replies.data]);

  return {
    ...joined,
    lenses: lenses.data ?? [],
    attention: attention.data ?? [],
    workers: workers.data ?? [],
    loading: missions.loading && !missions.data,
    error: missions.error ?? workers.error ?? attention.error,
    ready: Boolean(missions.data),
    reloadFirstmate: () => { fm.reload(); fmTasks.reload(); },
  };
}

export type UnfiledSession = SessionView & { subagents?: number };
