// The map by the names the captain sees, for the New box's planner (shared/new-plan.ts). Built from the
// same reads and grouping rules the chart uses (groupOfIdea, projectOf, setAside), fetched only while the
// box is in use, and refreshed when the map changes under it.
import { useEffect, useState } from "react";
import { api, onChange, repoLabel } from "../../lib/api";
import type { Lens, Mission, WorkerView } from "../../lib/types";
import type { MapIndex } from "../../../shared/new-plan";
import { projectOf } from "../fleet/model";
import { groupOfIdea } from "../map/layout";
import { setAside } from "../map/place";
import { offChart } from "../map/world";

type HistoryEntry = { commit: string | null; key?: string; summary: string; undone: boolean };
type Task = { id: string; title: string; mission: string | null; status?: string };
export type MapReads = {
  map: { groups: Lens[]; ideas: Mission[] };
  tasks: Task[];
  workers: WorkerView[];
  hidden: Record<string, string>;
  history: HistoryEntry[];
  /** Firstmate's own pane: the Firstmate node, never something to file. */
  control: string | null;
};

/** The planner's index from the map's reads. Pure, so it is unit-tested apart from React. */
export function buildMapIndex(r: MapReads): MapIndex {
  const ideas = r.map.ideas.filter((m) => !offChart(m));
  const groupOf = new Map(ideas.map((m) => [m.id, groupOfIdea({ ...m, health: "idle" }, r.map.groups, null)]));
  const repoGroups = new Map<string, { path: string; title: string }>();
  for (const g of groupOf.values()) if (g.kind === "repo") repoGroups.set(g.path ?? "", { path: g.path ?? "", title: g.title });
  const inIdea = new Map<string, string>();
  for (const m of r.map.ideas) for (const s of m.sessions ?? []) inIdea.set(`${s.source}:${s.id}`, m.id);
  const heldBy = new Map<string, string>();
  for (const l of r.map.groups) for (const k of l.sessions ?? []) if (!heldBy.has(k)) heldBy.set(k, l.id);
  const unfiled = new Map<string, { project: string; title: string }>();
  const sessions: MapIndex["sessions"] = [];
  for (const w of r.workers) {
    // Firstmate's pane is the hub, and a crewmate moves with its task, never on its own.
    if (!w.session || w.id === r.control || w.owner?.tier === "control" || w.crew || w.owner?.tier === "crew") continue;
    const idea = w.mission ?? inIdea.get(w.session) ?? null;
    const group = heldBy.get(w.session) ?? null;
    if (!idea && !group) { const p = projectOf(w); unfiled.set(p.key, { project: p.key, title: p.title }); }
    sessions.push({ key: w.session, title: w.title || w.id, idea, group, hidden: setAside(w, r.hidden) });
  }
  return {
    ideas: ideas.map((m) => {
      const g = groupOf.get(m.id)!;
      const repo = m.repos[0] ?? "";
      return { id: m.id, title: m.title, group: g.kind === "lens" ? g.lens ?? null : null, repo: { path: repo, title: repo ? repoLabel(repo)! : "No repo" } };
    }),
    groups: r.map.groups.map((l) => ({ id: l.id, title: l.title })),
    repoGroups: [...repoGroups.values()],
    unfiled: [...unfiled.values()],
    tasks: r.tasks.filter((t) => t.status !== "done").map((t) => ({ id: t.id, title: t.title || t.id, idea: t.mission })),
    sessions,
    history: r.history,
  };
}

const ENTITIES = new Set(["missions", "lenses", "workers", "tasks", "*"]);

async function readMap(): Promise<MapIndex> {
  const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [map, tasks, workers, hidden, history, fm] = await Promise.all([
    api<MapReads["map"]>("/api/missions/map"),
    soft(api<Task[]>("/api/firstmate/tasks"), []),
    soft(api<WorkerView[]>("/api/workers"), []),
    soft(api<Record<string, string>>("/api/missions/hidden"), {}),
    soft(api<HistoryEntry[]>("/api/missions/move/history"), []),
    soft(api<{ pane: { worker: string } | null }>("/api/firstmate/status"), { pane: null }),
  ]);
  return buildMapIndex({ map, tasks, workers, hidden, history, control: fm.pane?.worker ?? null });
}

/** The index while `active` (the box has focus or words in it); null until the first read lands. */
export function useMapIndex(active: boolean): { index: MapIndex | null; error: string | null; refresh: () => Promise<MapIndex | null> } {
  const [index, setIndex] = useState<MapIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    try { const ix = await readMap(); setIndex(ix); setError(null); return ix; }
    catch (e: any) { setError(`Joyride couldn't read the map: ${e.message}`); return null; }
  };
  useEffect(() => {
    if (!active) return;
    let live = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => { readMap().then((ix) => { if (live) { setIndex(ix); setError(null); } }).catch((e) => { if (live) setError(`Joyride couldn't read the map: ${e.message}`); }); };
    load();
    const off = onChange((c) => { if (ENTITIES.has(c.entity)) { if (t) clearTimeout(t); t = setTimeout(load, 150); } });
    return () => { live = false; off(); if (t) clearTimeout(t); };
  }, [active]);
  return { index, error, refresh };
}
