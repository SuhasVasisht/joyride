// New task from anywhere (control plane CP5): where a captain's request goes, and how far it has got.
//   placement  Jev's idea_place question over the tasks in flight, the open ideas and "new": more work
//              for a task becomes a steer, an idea gets a new task, "new" names and commits a new idea.
//              Below PLACE_THRESHOLD nothing sends on its own; the composer shows the top three and waits.
//   progress   Firstmate's own receipts (bin/fm-inbox.sh receipts, read-only, no wake) plus the backlog:
//              Sent → Read (acknowledged) → Replied → Became task <id> (a brief carrying joyride-request).
// Pure functions; the firstmate module runs the scripts and the models.
import { PLACE_THRESHOLD } from "../ideas/plan.ts";
import type { Mission } from "../../shared/schema.ts";
import type { TaskDetail } from "./state.ts";

export const requestMarker = (intentId: string) => `joyride-request: ${intentId}`;
/** A request Firstmate has not acknowledged for this long gets the "Firstmate hasn't read this" nudge. */
export const UNREAD_NUDGE_MS = 10 * 6e4;

export type PlaceTarget =
  | { kind: "task"; id: string; title: string; idea: string | null; p: number }
  | { kind: "idea"; id: string; title: string; p: number }
  | { kind: "new"; title: string | null; p: number };
export type Placement = {
  /** Jev's pick, or null when Jev was unavailable. */
  choice: PlaceTarget | null;
  /** True when the pick is confident enough to send without the captain choosing. */
  auto: boolean;
  /** The top three targets by probability, then "New idea" (always offered). */
  options: PlaceTarget[];
  via: "fixed" | "jev" | "none";
  /** For text that only mentions notes or lists (shared/compose.ts): what Jev thinks it is. */
  kind?: KindGuess;
};

// ---------- task, note or list ----------

export type KindGuess = { choice: "task" | "note" | "list"; p: number; auto: boolean };
/** Jev's criteria for what an unsure request is. */
export const KIND_CRITERIA: Record<KindGuess["choice"], string> = {
  task: "Work the captain wants an agent to do: build, fix, change, investigate or decide something.",
  note: "Something the captain wants written down to remember or for agents to read, not work to do.",
  list: "A checklist of several short items the captain wants to tick off one by one.",
};
/** Jev's kind answer as a guess; sure enough to act on at PLACE_THRESHOLD, like a placement. */
export function kindFrom(choice: string | null, probs: Record<string, number>): KindGuess | undefined {
  if (choice !== "task" && choice !== "note" && choice !== "list") return undefined;
  const p = probs[choice] ?? 0;
  return { choice, p, auto: p >= PLACE_THRESHOLD };
}

const IN_FLIGHT = new Set(["in_flight"]);
/** Tasks a request can add work to: in flight, not done, steerable. */
export const steerableTasks = (tasks: TaskDetail[]) => tasks.filter((t) => IN_FLIGHT.has(t.section ?? "in_flight") && t.status !== "done");
export const openIdeas = (missions: Mission[]) => missions.filter((m) => !m.archive && m.state === "open").sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 30);

export const placeKey = (t: Pick<PlaceTarget, "kind"> & { id?: string }) => (t.kind === "new" ? "new" : `${t.kind}:${t.id}`);

/** Jev's criteria for each target: what the captain's words would have to be about to land there. */
export function placeCriteria(tasks: TaskDetail[], ideas: Mission[]): Record<string, string> {
  const c: Record<string, string> = { new: "None of these: the request starts a separate stream of work, a new idea." };
  for (const t of tasks) c[`task:${t.id}`] = `More work for the task in flight "${t.title}"${t.last_event ? ` (now: ${t.last_event.slice(0, 160)})` : ""}. Pick this only when the request changes or extends this exact piece of work.`;
  for (const m of ideas) c[`idea:${m.id}`] = `A new task in the idea "${m.title}". ${m.goal.replace(/\s+/g, " ").slice(0, 240)}`;
  return c;
}

/** Turn Jev's choice and probabilities into a placement. A fixed idea (the "+ Add to this idea" composer) is certain. */
export function placementFrom(choice: string | null, probs: Record<string, number>, tasks: TaskDetail[], ideas: Mission[]): Placement {
  const byKey = new Map<string, PlaceTarget>();
  for (const t of tasks) byKey.set(`task:${t.id}`, { kind: "task", id: t.id, title: t.title, idea: t.mission, p: probs[`task:${t.id}`] ?? 0 });
  for (const m of ideas) byKey.set(`idea:${m.id}`, { kind: "idea", id: m.id, title: m.title, p: probs[`idea:${m.id}`] ?? 0 });
  const fresh: PlaceTarget = { kind: "new", title: null, p: probs.new ?? 0 };
  const ranked = [...byKey.values()].sort((a, b) => b.p - a.p).slice(0, 3);
  const options = [...ranked, fresh];
  if (!choice) return { choice: null, auto: false, options, via: "none" };
  const picked = choice === "new" ? fresh : byKey.get(choice) ?? null;
  if (!picked) return { choice: null, auto: false, options, via: "jev" };
  if (!options.some((o) => placeKey(o) === placeKey(picked))) options.unshift(picked);
  return { choice: picked, auto: picked.p >= PLACE_THRESHOLD, options, via: "jev" };
}

export function fixedPlacement(idea: Mission): Placement {
  const t: PlaceTarget = { kind: "idea", id: idea.id, title: idea.title, p: 1 };
  return { choice: t, auto: true, options: [t, { kind: "new", title: null, p: 0 }], via: "fixed" };
}

// ---------- progress ----------

export type ReceiptNote = {
  id: string; at: string | null; source: string | null; request_id: string | null; body?: string;
  acknowledged: boolean; announced: boolean | null; reply: { id: string; at: string | null; body: string; cursor: string } | null;
};
export type Receipts = { schema: string; pending: ReceiptNote[]; handled: ReceiptNote[] };

export type RequestStage = "sent" | "read" | "replied" | "task";
export type RequestProgress = {
  id: string;
  stage: RequestStage | "unknown";
  note: { id: string; at: string | null; acknowledged: boolean; announced: boolean | null } | null;
  reply: { at: string | null; body: string } | null;
  task: { id: string; title: string; mission: string | null; status: string } | null;
  /** Unread for UNREAD_NUDGE_MS or more: offer Nudge. */
  unread_too_long: boolean;
};

/** Parse `fm-inbox.sh receipts` output (fm-inbox-receipts.v1); throws on anything else. */
export function parseReceipts(stdout: string): Receipts {
  const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  const r = line ? JSON.parse(line) : null;
  if (!r || r.schema !== "fm-inbox-receipts.v1") throw new Error(`unexpected receipts output: ${stdout.slice(0, 200)}`);
  return { schema: r.schema, pending: r.pending ?? [], handled: r.handled ?? [] };
}

export function findRequestNote(r: Receipts, requestId: string): ReceiptNote | null {
  return r.handled.find((n) => n.request_id === requestId) ?? r.pending.find((n) => n.request_id === requestId) ?? null;
}

/** How far a request has got. The backlog row wins: once a brief carries the marker, the ghost is that task. */
export function requestProgress(requestId: string, note: ReceiptNote | null, tasks: Pick<TaskDetail, "id" | "title" | "mission" | "status" | "request">[], nowMs = Date.now()): RequestProgress {
  const t = tasks.find((x) => x.request === requestId) ?? null;
  const task = t ? { id: t.id, title: t.title, mission: t.mission, status: t.status } : null;
  const reply = note?.reply ? { at: note.reply.at, body: note.reply.body } : null;
  const stage: RequestProgress["stage"] = task ? "task" : reply ? "replied" : note?.acknowledged ? "read" : note ? "sent" : "unknown";
  const age = note?.at ? nowMs - Date.parse(note.at) : 0;
  return {
    id: requestId, stage, task, reply,
    note: note ? { id: note.id, at: note.at, acknowledged: note.acknowledged, announced: note.announced } : null,
    unread_too_long: stage === "sent" && age >= UNREAD_NUDGE_MS,
  };
}

// ---------- replies on the map ----------

/** How long a reply stays on the map unless the captain dismisses it first. */
export const REPLY_KEEP_MS = 7 * 864e5;

/** Firstmate's reply to a map request, on the card the request became (its task, else its idea). */
export type MapReply = {
  request: string;
  text: string;
  mission: string | null;
  task: { id: string; title: string } | null;
  created_idea: boolean;
  reply: { at: string | null; body: string };
};
type RequestIntent = { id: string; kind: string; status: string; created: string; payload?: Record<string, unknown>; result?: any };

/**
 * A captain message from the New box (tell_firstmate): an update or a question, not a task request.
 * The request marker lets Firstmate's fm-inbox.sh reply reach the map.
 */
export function captainMessage(o: { requestId: string; text: string; idea?: { id: string; title: string } | null }): string {
  return [
    `The captain wrote to you from Joyride's New box${o.idea ? `, on the idea "${o.idea.title}"` : ""}:`,
    "",
    o.text.trim(),
    "",
    "This is an update or a question, not a task request. Act on it as you see fit, and answer it with `fm-inbox.sh reply <note id>` so Joyride shows your answer on the map.",
    ...(o.idea ? [`joyride-mission: ${o.idea.id}`] : []),
    requestMarker(o.requestId),
  ].join("\n");
}

/** The intents whose answers show on the map: task requests and captain messages. */
export const REPLY_KINDS = ["create_task", "tell_firstmate"];

/**
 * Every request from the map that Firstmate answered (fm-inbox.sh reply), newest first, until the captain
 * dismisses it or it ages out: a task request (create_task) or a captain message (tell_firstmate). A request
 * that became a task carries that task; otherwise its idea.
 */
export function mapReplies(intents: RequestIntent[], r: Receipts, tasks: Pick<TaskDetail, "id" | "title" | "request">[], dismissed: Record<string, unknown>, nowMs = Date.now()): MapReply[] {
  const notes = new Map<string, ReceiptNote>();
  for (const n of [...r.pending, ...r.handled]) if (n.request_id && n.reply) notes.set(n.request_id, n);
  const out: MapReply[] = [];
  for (const it of intents) {
    if (!REPLY_KINDS.includes(it.kind) || it.status === "failed" || dismissed[it.id] || it.result?.via === "steer") continue;
    if (nowMs - Date.parse(it.created) > REPLY_KEEP_MS) continue;
    const reply = notes.get(it.id)?.reply;
    if (!reply) continue;
    const t = tasks.find((x) => x.request === it.id) ?? null;
    out.push({
      request: it.id, text: String(it.payload?.brief ?? it.payload?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      mission: it.result?.mission ?? null, task: t ? { id: t.id, title: t.title } : null,
      created_idea: Boolean(it.result?.created_idea), reply: { at: reply.at, body: reply.body },
    });
  }
  return out.sort((a, b) => (b.reply.at ?? "").localeCompare(a.reply.at ?? ""));
}
