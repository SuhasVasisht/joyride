// idea_brief: each idea's headline plus "now" and "next", written by the heavy model (gpt-6.1-sol, low,
// on Joyride's own login per joyride.config.yaml) and cached by the signature of its tasks' status lines,
// like session_intent. Pure prompt, schema, signature and the fake used under JOYRIDE_FAKE_MODELS.
import { sha256, truncate } from "../../core/util.ts";

export type BriefTask = { id: string; title: string; status: string; section: string | null; last_event: string };
export type BriefInput = { idea: { id: string; title: string; goal: string }; tasks: BriefTask[] };
export type BriefRaw = { headline: string; now: string; next: string };

export const BRIEF_SCHEMA = {
  type: "object",
  properties: { headline: { type: "string" }, now: { type: "string" }, next: { type: "string" } },
  required: ["headline", "now", "next"],
  additionalProperties: false,
};

const ORDER: Record<string, number> = { in_flight: 0, queued: 1, done: 2 };
/** The tasks a brief is written from: in flight, then queued, then the latest done, at most 12. */
export function briefInput(idea: { id: string; title: string; goal: string }, tasks: BriefTask[]): BriefInput {
  const picked = [...tasks].sort((a, b) => (ORDER[a.section ?? "in_flight"] ?? 3) - (ORDER[b.section ?? "in_flight"] ?? 3) || a.id.localeCompare(b.id)).slice(0, 12);
  return {
    idea: { id: idea.id, title: idea.title, goal: truncate(idea.goal.replace(/\s+/g, " "), 400) },
    tasks: picked.map((t) => ({ id: t.id, title: truncate(t.title, 140), status: t.status, section: t.section, last_event: truncate(t.last_event.replace(/\s+/g, " "), 200) })),
  };
}

/** Changes exactly when a status line, a task's section or the idea's words change. */
export const briefSig = (input: BriefInput) => sha256(JSON.stringify(input)).slice(0, 16);

export function briefPrompt(input: BriefInput): string {
  return [
    "You write the one-glance summary on a card for one idea on a developer's control-plane map. An idea is one stream of the captain's intent; its tasks are Firstmate tasks.",
    "Return three short lines in plain words, sentence case, no task ids, no emoji:",
    "- headline: at most 90 characters, where the idea stands overall (\"Roster landed; pruning in the lab\").",
    "- now: at most 140 characters, what is happening right now, from the in-flight tasks' latest status lines. Say \"Nothing in flight\" when none are.",
    "- next: at most 140 characters, what comes after, from queued tasks or what the status lines say is next. Say \"Nothing queued\" when nothing is.",
    "Use only what is given; never invent progress.",
    "<idea>",
    JSON.stringify(input),
    "</idea>",
  ].join("\n");
}

/** Clamp a model answer to the card's limits. */
export function cleanBrief(raw: Partial<BriefRaw> | null | undefined): BriefRaw | null {
  const one = (s: unknown, n: number) => truncate(String(s ?? "").replace(/\s+/g, " ").trim(), n);
  const b = { headline: one(raw?.headline, 90), now: one(raw?.now, 140), next: one(raw?.next, 140) };
  return b.headline ? b : null;
}

/** Deterministic stand-in for tests: built from the same input the model sees. */
export function fakeBrief(prompt: string): BriefRaw {
  const m = prompt.match(/<idea>\n([\s\S]*?)\n<\/idea>/);
  const input: BriefInput = m ? JSON.parse(m[1]) : { idea: { id: "", title: "This idea", goal: "" }, tasks: [] };
  const flying = input.tasks.filter((t) => t.section === "in_flight");
  const queued = input.tasks.filter((t) => t.section === "queued");
  const done = input.tasks.filter((t) => t.section === "done");
  return {
    headline: `${flying.length} in flight, ${queued.length} queued, ${done.length} done`,
    now: flying[0] ? `${flying[0].title}: ${flying[0].last_event || flying[0].status}` : "Nothing in flight",
    next: queued[0] ? queued[0].title : "Nothing queued",
  };
}
