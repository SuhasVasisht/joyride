import { firstmateStatus } from "../../lib/firstmate-status";
// The control plane's middle layers, kept pure so the rules are unit-tested apart from React:
// which Firstmate tasks an idea shows, which crewmates sit under which task, and where each ask
// is pinned (a task card, a worker line on it, the idea, or the Firstmate hub).
import type { Ask } from "../../../shared/asks";
import type { WorkerView } from "../../lib/types";
import type { CrewTask } from "../crew/crew";

/** A Firstmate task as the map shows it: who runs it, its crew, and the asks pinned to it. */
export type PlaneTask = CrewTask & {
  model?: string | null; effort?: string | null; account?: string | null;
  hold_reason?: string | null; hold_kind?: string | null;
  decisions?: { key: string; verb: string; keyed: boolean }[];
};
export type MapTask<W> = PlaneTask & { crew: W[]; asks: Ask[] };

export type Plane<W> = {
  /** Open tasks per idea, the ones with an ask first. */
  tasks: Map<string, MapTask<W>[]>;
  /** Landed (done) tasks per idea, folded into one line. */
  landed: Map<string, MapTask<W>[]>;
  /** Open tasks no idea names yet: shown on the Firstmate hub until housekeeping files them. */
  orphans: MapTask<W>[];
  /** Asks pinned to an idea itself (no task card holds them), by idea. */
  ideaAsks: Map<string, Ask[]>;
  /** Asks for the hub: Firstmate's own, and ones with nowhere else to sit. */
  hubAsks: Ask[];
  /** Crew worker id → its task id, for workers that sit inside a task card. */
  crewOf: Map<string, string>;
};

/** A worker's task when it is a crewmate (by recorded pane, else FM_TASK_ID). */
export const crewTaskOf = (w: Pick<WorkerView, "crew" | "owner">) => w.crew ?? (w.owner?.tier === "crew" ? w.owner.task : null) ?? null;

/** What sits where: tasks into ideas, crew into tasks, asks onto the card they block. */
export function buildPlane<W extends Pick<WorkerView, "id" | "crew" | "owner">>(input: {
  tasks: PlaneTask[]; workers: W[]; asks: Ask[]; missions: Set<string>; controlId?: string | null;
}): Plane<W> {
  const out: Plane<W> = { tasks: new Map(), landed: new Map(), orphans: [], ideaAsks: new Map(), hubAsks: [], crewOf: new Map() };
  const byId = new Map<string, MapTask<W>>();
  for (const t of input.tasks) byId.set(t.id, { ...t, crew: [], asks: [] });
  for (const w of input.workers) {
    if (w.id === input.controlId || w.owner?.tier === "control") continue;
    const tid = crewTaskOf(w);
    const t = tid ? byId.get(tid) : undefined;
    if (t) { t.crew.push(w); out.crewOf.set(w.id, t.id); }
  }
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  const ideaOf = (t: PlaneTask) => (t.mission && input.missions.has(t.mission) ? t.mission : null);
  const shown = new Set<string>();
  // A done task stays a card while a crewmate is still live on it or an ask names it.
  const askTasks = new Set(input.asks.map((a) => (a.place.on === "task" ? a.place.id : a.task)).filter(Boolean) as string[]);
  for (const t of byId.values()) {
    const open = t.section !== "done" || t.crew.length > 0 || askTasks.has(t.id);
    const idea = ideaOf(t);
    if (!open) { if (idea) push(out.landed, idea, t); continue; }
    shown.add(t.id);
    if (idea) push(out.tasks, idea, t); else out.orphans.push(t);
  }
  for (const a of input.asks) {
    if (a.kind === "nudge") { if (a.mission && input.missions.has(a.mission)) push(out.ideaAsks, a.mission, a); continue; }
    const crewTask = a.worker ? out.crewOf.get(a.worker) : undefined;
    const tid = (a.place.on === "task" ? a.place.id : null) ?? crewTask ?? a.task;
    const t = tid && shown.has(tid) ? byId.get(tid) : undefined;
    if (t) { t.asks.push(a); continue; }
    const idea = a.place.on === "idea" && a.place.id ? a.place.id : a.mission;
    if (idea && input.missions.has(idea)) push(out.ideaAsks, idea, a); else out.hubAsks.push(a);
  }
  const rank = (t: MapTask<W>) => (t.asks.some((a) => a.needs_you) ? 0 : t.asks.length ? 1 : t.section === "in_flight" ? 2 : t.section === "queued" ? 3 : 4);
  const order = (l: MapTask<W>[]) => l.sort((a, b) => rank(a) - rank(b) || (b.updated ?? "").localeCompare(a.updated ?? "") || a.id.localeCompare(b.id));
  for (const l of out.tasks.values()) order(l);
  order(out.orphans);
  for (const l of out.landed.values()) l.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  return out;
}

/** The order "next ask" walks: the captain's calls first, oldest first, then everything else. */
export function askOrder(asks: Ask[]): Ask[] {
  return asks.filter((a) => a.kind !== "nudge").sort((a, b) => Number(b.needs_you) - Number(a.needs_you) || (a.opened ?? "").localeCompare(b.opened ?? "") || a.id.localeCompare(b.id));
}

/** Who runs a task, in words: "Claude Code · claude-opus-5-5, high · claude-2". */
export function whoRuns(t: Pick<PlaneTask, "harness" | "model" | "effort" | "account">): string {
  const harness = t.harness === "claude" ? "Claude Code" : t.harness === "codex" ? "Codex" : t.harness ?? null;
  const model = t.model && t.model !== "default" ? t.model : t.model === "default" ? "default model" : null;
  const run = [model, t.effort].filter(Boolean).join(", ");
  return [harness, run || null, t.account].filter(Boolean).join(" · ") || "Not started yet";
}

const RAW_CALL = /^[A-Za-z_][\w.-]*:\s*[{[]/;
/**
 * A worker's activity as a person reads it, or null. A raw tool call (`ScheduleWakeup: {"stop":true}`, a tool
 * name and its JSON arguments) or bare JSON is not; a permission wait on one keeps only "Waiting for permission".
 */
export function readableAction(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t || /^[{[]/.test(t)) return null;
  const wait = t.match(/^Waiting for permission:\s*(.*)$/);
  if (wait) return RAW_CALL.test(wait[1]) || /^[{[]/.test(wait[1]) ? "Waiting for permission" : t;
  return RAW_CALL.test(t) ? null : t;
}

/** A task's one-line "now": its crewmate's current action or goal, else its last status line. */
export function taskNow(t: Pick<PlaneTask, "last_event" | "status">, live?: { action?: string | null; goal?: string | null }): string {
  if (t.status === "paused") return readableAction(firstmateStatus(t.status, t.last_event ?? "").reason) || "Waiting on its own run";
  const action = readableAction(live?.action);
  if (action) return action;
  if (live?.goal) return live.goal;
  const ev = readableAction((t.last_event ?? "").replace(/^[a-z-]+(?:\s*\[[^\]]*\])*:\s*/i, "").trim());
  return ev || t.status || "No update yet";
}

/** The composed answer for picked options, with the captain's own words after: "1 A (the last row); 2 B (CSV and XLSX). Keep it short." */
export function composeAnswer(ask: Pick<Ask, "calls">, picks: Record<number, string>, words: string): string {
  const parts = ask.calls.map((c, i) => {
    const id = picks[i];
    const o = id ? c.options.find((x) => x.id === id) : undefined;
    if (!o) return null;
    return ask.calls.length > 1 ? `${c.n ?? i + 1} ${o.id} (${o.label})` : `${o.id} (${o.label})`;
  }).filter(Boolean);
  const text = words.trim();
  if (!parts.length) return text;
  return `${parts.join("; ")}${text ? `. ${text}` : ""}`;
}

/** The picks that take every recommendation, when each call marks one. */
export function recommendedPicks(ask: Pick<Ask, "calls">): Record<number, string> {
  const out: Record<number, string> = {};
  ask.calls.forEach((c, i) => { const r = c.options.find((o) => o.recommended); if (r) out[i] = r.id; });
  return out;
}

/** Firstmate's reply to a map request (GET /api/firstmate/replies). */
export type MapReply = {
  request: string; text: string; mission: string | null; task: { id: string; title: string } | null;
  created_idea: boolean; reply: { at: string | null; body: string };
};
/**
 * Where each reply sits: on the task card the request became when the chart shows it, else on its idea,
 * else on the Firstmate hub, so an answer is never lost off the chart.
 */
export function placeReplies(replies: MapReply[], shownTasks: Set<string>, shownIdeas: Set<string>) {
  const out = { byTask: new Map<string, MapReply[]>(), byIdea: new Map<string, MapReply[]>(), hub: [] as MapReply[] };
  const push = (m: Map<string, MapReply[]>, k: string, r: MapReply) => { const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); };
  for (const r of replies) {
    if (r.task && shownTasks.has(r.task.id)) push(out.byTask, r.task.id, r);
    else if (r.mission && shownIdeas.has(r.mission)) push(out.byIdea, r.mission, r);
    else out.hub.push(r);
  }
  return out;
}
