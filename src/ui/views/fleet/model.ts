// The fleet as the UI sees it: every live session with its owner tier, its helm, whether it needs the
// captain, and the project its work belongs to. Pure, so the map, the Firstmate bridge and the Agents page
// count the same way and the rules are unit-tested apart from React.
import { repoLabel } from "../../lib/api";
import type { AttentionItem, WorkerView } from "../../lib/types";

export const rankOf = (level: string) => Number(String(level).slice(1)) || 0;

/** A project group: work that belongs to the same repo (or folder), whoever launched it. */
export type Project = { key: string; title: string; path: string | null };

/**
 * The project a worker or session belongs to: its crew task's repo, else its git repo, else its folder.
 * Keyed by name, so a crewmate's worktree and the captain's checkout of the same repo share a group.
 */
export function projectOf(x: { repo?: string | null; cwd?: string | null; crew?: string | null }, taskRepo?: Map<string, string | null>): Project {
  const path = x.repo || x.cwd || null;
  const named = (x.crew ? taskRepo?.get(x.crew) : null) || (path ? repoLabel(path) : null);
  return named ? { key: named.toLowerCase(), title: named, path } : { key: "", title: "No project", path: null };
}

type Attn = Pick<AttentionItem, "level" | "worker" | "session" | "title">;
/** Why a worker needs the captain right now (blocked at a prompt, or an open item at L3 or above), else null. */
export function needsCaptain(w: Pick<WorkerView, "id" | "status" | "session">, attention: Attn[]): string | null {
  if (w.status === "blocked") return "Waiting at a prompt";
  const a = attention.find((x) => rankOf(x.level) >= 3 && (x.worker === w.id || (!!w.session && x.session === w.session)));
  return a ? a.title || "Waiting on you" : null;
}

export type FleetCounts = { crew: number; watched: number; yoursOnly: number; needsYou: number; yourHelm: number };

/** The bridge's counts. Firstmate's own pane is not a fleet member, so it is not counted; sessions you keep to yourself count apart. */
export function fleetCounts(workers: WorkerView[], attention: Attn[]): FleetCounts {
  const c: FleetCounts = { crew: 0, watched: 0, yoursOnly: 0, needsYou: 0, yourHelm: 0 };
  for (const w of workers) {
    const tier = w.owner?.tier ?? "watched";
    if (tier === "control") continue;
    if (tier === "crew") c.crew++; else if (tier === "excluded") c.yoursOnly++; else c.watched++;
    if (needsCaptain(w, attention)) c.needsYou++;
    if (w.helm?.by === "captain") c.yourHelm++;
  }
  return c;
}

export type FleetFilter = "all" | "crew" | "watched" | "yours-only" | "needs-you" | "your-helm";
export const FLEET_FILTERS: { id: FleetFilter; label: string }[] = [
  { id: "all", label: "All" }, { id: "crew", label: "Crew" }, { id: "watched", label: "Watched" }, { id: "yours-only", label: "Yours only" },
  { id: "needs-you", label: "Needs you" }, { id: "your-helm", label: "At your helm" },
];
export const asFilter = (v: string | null): FleetFilter => (FLEET_FILTERS.some((f) => f.id === v) ? (v as FleetFilter) : "all");

export type FleetRow = { w: WorkerView; tier: "crew" | "watched" | "control" | "excluded"; needs: string | null; project: Project };

/** One row per live session: needs-you first, then working, then most recent activity. */
export function fleetRows(workers: WorkerView[], attention: Attn[], taskRepo?: Map<string, string | null>): FleetRow[] {
  const order = (r: FleetRow) => (r.needs ? 0 : r.w.status === "working" ? 1 : 2);
  return workers
    .map((w) => ({ w, tier: w.owner?.tier ?? "watched", needs: needsCaptain(w, attention), project: projectOf(w, taskRepo) }))
    .sort((a, b) => order(a) - order(b) || b.w.updated.localeCompare(a.w.updated));
}

export function matchesFilter(r: FleetRow, f: FleetFilter): boolean {
  switch (f) {
    case "all": return true;
    case "crew": return r.tier === "crew";
    case "watched": return r.tier === "watched";
    case "yours-only": return r.tier === "excluded";
    case "needs-you": return r.tier !== "control" && Boolean(r.needs);
    case "your-helm": return r.w.helm?.by === "captain";
  }
}
