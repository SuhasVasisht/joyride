// A task's timeline (control plane CP3b): the per-task conversation that replaces weaving
// through Firstmate's chat. Pure: the module reads the files and services, this merges them.
//   brief written   -> brief
//   status log      -> status (a needs-decision/blocked still open per the fold is "open")
//   task inbox      -> steer (pending until the crewmate moves it to handled/)
//   captain notes   -> note
//   asks on it      -> ask
//   report landed   -> report
import type { StatusEntry } from "../firstmate/state.ts";

export type TimelineKind = "brief" | "status" | "steer" | "note" | "ask" | "report";
export type TimelineEvent = {
  id: string;
  kind: TimelineKind;
  /** When it happened, else null (an unstamped status line keeps its place in the log). */
  at: string | null;
  /** The status verb (working, needs-decision, resolved, done…), else null. */
  verb: string | null;
  key: string | null;
  text: string;
  /** steer: pending | read; status decisions and asks: open | closed; else null. */
  state: "pending" | "read" | "open" | "closed" | null;
  /** The note or ask id this row stands for. */
  ref: string | null;
  needs_you: boolean;
};
export type InboxMessage = { name: string; text: string; at: string | null; handled: boolean };
export type TimelineInput = {
  task: string;
  brief: { at: string | null } | null;
  status: StatusEntry[];
  /** Keys still open per Firstmate's fold. */
  open_keys: string[];
  inbox: InboxMessage[];
  notes: { id: string; created: string | null; bullets: string[]; title: string }[];
  asks: { id: string; title: string; question: string; opened: string | null; needs_you: boolean; state: string }[];
  report: { at: string | null } | null;
};

const DECISION_VERBS = new Set(["needs-decision", "blocked"]);

/** Strip Firstmate's envelope (the fm-task-inbox header, front matter, "FIRSTMATE_…:" prefixes) from an inbox message. */
export function inboxText(raw: string) {
  const lines = raw.replace(/\r/g, "").split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") { const end = lines.indexOf("---", 1); if (end > 0) i = end + 1; }
  // fm-task-inbox.v1: "key=value" header lines, then "--", then the message.
  else if (/^schema=fm-task-inbox/.test(lines[0] ?? "")) { const end = lines.indexOf("--"); if (end > 0) i = end + 1; }
  const body = lines.slice(i).filter((l) => !/^FIRSTMATE_[A-Z_]+:\s*$/.test(l.trim()));
  return body.join("\n").replace(/^FIRSTMATE_[A-Z_]+:\s*(?:v\d+\s+)?/, "").trim();
}

export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  const out: (TimelineEvent & { sort: number; seq: number })[] = [];
  let seq = 0;
  const add = (e: TimelineEvent, sortAt: number) => out.push({ ...e, sort: sortAt, seq: seq++ });
  const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

  // The brief opens the task. Its file time counts only when nothing is older: a rewritten brief keeps its place.
  if (input.brief) {
    const others = [...input.status.map((s) => t(s.at)), ...input.inbox.map((m) => t(m.at)), ...input.notes.map((n) => t(n.created)), ...input.asks.map((a) => t(a.opened))].filter(Number.isFinite);
    const at = Number.isFinite(t(input.brief.at)) && (!others.length || t(input.brief.at) <= Math.min(...others)) ? input.brief.at : null;
    add({ id: "brief", kind: "brief", at, verb: null, key: null, text: "Firstmate wrote the brief and launched the task.", state: null, ref: null, needs_you: false }, -Infinity);
  }

  // Unstamped status lines sort just after the previous stamped one, so the log keeps its order.
  const open = new Set(input.open_keys);
  const lastOpener = new Map<string, number>();
  input.status.forEach((s, i) => { if (DECISION_VERBS.has(s.verb)) lastOpener.set(s.key ?? "default", i); });
  let prev = -Infinity;
  input.status.forEach((s, i) => {
    const at = t(s.at);
    if (Number.isFinite(at)) prev = at;
    const key = s.key ?? (DECISION_VERBS.has(s.verb) ? "default" : null);
    const isOpen = DECISION_VERBS.has(s.verb) && open.has(key ?? "default") && lastOpener.get(key ?? "default") === i;
    add({
      id: `status:${i}`, kind: "status", at: s.at, verb: s.verb, key: s.key, text: s.text,
      state: DECISION_VERBS.has(s.verb) ? (isOpen ? "open" : "closed") : null, ref: null, needs_you: false,
    }, prev);
  });

  for (const m of input.inbox) {
    add({ id: `steer:${m.name}`, kind: "steer", at: m.at, verb: null, key: null, text: inboxText(m.text), state: m.handled ? "read" : "pending", ref: m.name, needs_you: false }, Number.isFinite(t(m.at)) ? t(m.at) : Infinity);
  }
  for (const n of input.notes) {
    add({ id: `note:${n.id}`, kind: "note", at: n.created, verb: null, key: null, text: n.bullets.length ? n.bullets.join("\n") : n.title, state: null, ref: n.id, needs_you: false }, Number.isFinite(t(n.created)) ? t(n.created) : Infinity);
  }
  for (const a of input.asks) {
    add({ id: `ask:${a.id}`, kind: "ask", at: a.opened, verb: null, key: null, text: a.title || a.question, state: "open", ref: a.id, needs_you: a.needs_you }, Number.isFinite(t(a.opened)) ? t(a.opened) : Infinity);
  }
  if (input.report) add({ id: "report", kind: "report", at: input.report.at, verb: null, key: null, text: "The report landed.", state: null, ref: null, needs_you: false }, Number.isFinite(t(input.report.at)) ? t(input.report.at) : Infinity);

  out.sort((a, b) => a.sort - b.sort || a.seq - b.seq);
  return out.map(({ sort: _s, seq: _q, ...e }) => e);
}
