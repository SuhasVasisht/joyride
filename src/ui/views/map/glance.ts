// What an idea says at a glance: the four questions the captain asks of any piece of work, answered in
// that order. What needs me (an ask that is the captain's call), what is stuck (blocked, failed, waiting
// on a decision), what is moving (in flight), what is up next (queued or waiting on another task). What
// just finished is the landed line. Everything else (who runs it, ids, chips, last messages) waits for a
// click: idea focus shows it in full.
import { firstmateStatus } from "../../lib/firstmate-status";
import { plural } from "../../components/primitives";
import type { MapMission, MapTaskW } from "./world";

export type Bucket = "needs-you" | "stuck" | "moving" | "next";
export const BUCKETS: Bucket[] = ["needs-you", "stuck", "moving", "next"];
export const BUCKET_LABEL: Record<Bucket, string> = { "needs-you": "Needs you", stuck: "Stuck", moving: "Moving", next: "Up next" };

type TaskLike = Pick<MapTaskW, "status" | "section" | "asks" | "crew" | "last_event">;
type WorkerLike = { status: string };

export function taskBucket(t: TaskLike): Bucket {
  if (t.asks.some((a) => a.needs_you)) return "needs-you";
  const tone = firstmateStatus(t.status, t.last_event ?? "").tone;
  if (tone === "blocked" || tone === "fail" || t.crew.some((w) => w.status === "blocked")) return "stuck";
  if (t.section === "in_flight" && tone !== "idle") return "moving";
  return "next";
}

export function workerBucket(w: WorkerLike): Bucket | "idle" {
  return w.status === "blocked" ? "stuck" : w.status === "working" ? "moving" : "idle";
}

export type Glance = { needsYou: number; stuck: number; moving: number; next: number; landed: number; idle: number };

type IdeaLike = { asks: MapMission["asks"]; tasks: TaskLike[]; workers: WorkerLike[]; landed: unknown[] };
export function glanceOf(m: IdeaLike): Glance {
  const g: Glance = { needsYou: m.asks.filter((a) => a.needs_you).length, stuck: 0, moving: 0, next: 0, landed: m.landed.length, idle: 0 };
  for (const t of m.tasks) {
    const b = taskBucket(t);
    if (b === "needs-you") g.needsYou += t.asks.filter((a) => a.needs_you).length;
    else if (b === "stuck") g.stuck++;
    else if (b === "moving") g.moving++;
    else g.next++;
  }
  for (const w of m.workers) {
    const b = workerBucket(w);
    if (b === "stuck") g.stuck++; else if (b === "moving") g.moving++; else g.idle++;
  }
  return g;
}

/** The glance as short phrases, the captain's call first: "1 needs you", "2 moving", "1 up next". Empty when nothing is live. */
export function glanceParts(g: Glance): { text: string; signal?: boolean }[] {
  const out: { text: string; signal?: boolean }[] = [];
  if (g.needsYou) out.push({ text: `${g.needsYou} need${g.needsYou === 1 ? "s" : ""} you`, signal: true });
  if (g.stuck) out.push({ text: `${g.stuck} stuck` });
  if (g.moving) out.push({ text: `${g.moving} moving` });
  if (g.next) out.push({ text: `${g.next} up next` });
  return out;
}

/** Tasks and the idea's own live workers, sorted into buckets in reading order. */
export function sortIdea<T extends TaskLike, W extends WorkerLike>(tasks: T[], workers: W[]) {
  const out = { tasks: new Map<Bucket, T[]>(), workers: new Map<Bucket, W[]>(), idle: [] as W[] };
  for (const b of BUCKETS) { out.tasks.set(b, []); out.workers.set(b, []); }
  for (const t of tasks) out.tasks.get(taskBucket(t))!.push(t);
  for (const w of workers) { const b = workerBucket(w); if (b === "idle") out.idle.push(w); else out.workers.get(b)!.push(w); }
  return out;
}

/** An idea's quiet inventory, for when nothing in it is live. */
export function inventory(m: Pick<MapMission, "tasks" | "workers" | "sessions" | "artifacts">): string {
  const crew = m.tasks.reduce((a, t) => a + t.crew.length, 0);
  return [m.tasks.length ? plural(m.tasks.length, "task") : null, plural(m.workers.length + crew || m.sessions.length, m.workers.length + crew ? "worker" : "session"), m.artifacts.length ? plural(m.artifacts.length, "artifact") : null].filter(Boolean).join(" · ");
}
