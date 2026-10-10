import { z } from "zod";
import { Mission, type Lens } from "../../shared/schema.ts";
import { slugify, truncate } from "../../core/util.ts";

export const MAX_PLACEMENTS = 40;
export const PIN_DAYS = 7;
export const PLACE_THRESHOLD = 0.75;

const s = z.string().trim();
const why = s.max(400).default("");
const title = s.min(1, "needs a title").max(100, "the title is longer than 100 characters");
export const PlacementOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), title, goal: s.max(600).default(""), group: s.optional(), tasks: z.array(s).min(1, "a new idea needs at least one task"), why }),
  z.object({ op: z.literal("move"), task: s.min(1), to: s, why, from: s.nullable().optional() }),
]);
export type PlacementOp = z.infer<typeof PlacementOp>;

export type OpStatus = "applied" | "proposed" | "rejected";
export type OpResult = { op: PlacementOp | Record<string, unknown>; status: OpStatus; reason?: string; text: string };

export type WorldTask = { id: string; title: string; status: string; section: string | null; mission: string | null };
export type Pins = {
  /** Ideas the captain created, renamed or edited in the last PIN_DAYS days. */
  ideas: Map<string, string>;
  /** Tasks and sessions the captain moved, and ideas the captain moved between groups: pinned for good. */
  tasks: Map<string, string>;
  sessions: Map<string, string>;
  grouped: Map<string, string>;
};
export const emptyPins = (): Pins => ({ ideas: new Map(), tasks: new Map(), sessions: new Map(), grouped: new Map() });

export type World = {
  missions: Mission[];
  lenses: Lens[];
  tasks: WorldTask[];
  pins: Pins;
  /** Op signatures the captain undid before; housekeeping never repeats them. */
  vetoes: Set<string>;
  now: string;
};

/** What a model returns: one flat object per op, "" for fields it doesn't use. Drop the empties and parse. */
export function normalizeOp(raw: unknown): { op: PlacementOp } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "not an object" };
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // `from: null` is meaningful (a placement saw the task unfiled); every other empty means "unused".
    if (v === "" || v === undefined || (v === null && k !== "from")) continue;
    if (Array.isArray(v) && !v.length) continue;
    clean[k] = v;
  }
  const p = PlacementOp.safeParse(clean);
  if (p.success) return { op: p.data };
  return { error: p.error.issues.map((i) => `${i.path.join(".") || "op"}: ${i.message}`).join("; ") };
}

/** A stable key for an op, so an op the captain undid is never made again. */
export function opSignature(op: PlacementOp): string {
  switch (op.op) {
    case "create": return `create:${slugify(op.title)}`;
    case "move": return `move:task:${op.task}>${op.to}`;
  }
}

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Check each op against the world in order (later ops see earlier ones) and build the files to write.
 * `apply: false` (a dry run) marks accepted ops "proposed" instead of "applied"; the files are built either way.
 */
export function validatePlan(world: World, input: unknown[], opts: { maxOps?: number; apply?: boolean } = {}) {
  const maxOps = opts.maxOps ?? MAX_PLACEMENTS;
  const ok: OpStatus = opts.apply === false ? "proposed" : "applied";
  const ms = new Map(world.missions.map((m) => [m.id, m]));
  const tasks = new Map(world.tasks.map((t) => [t.id, t]));
  const taskMission = new Map<string, string | null>(world.tasks.map((t) => [t.id, t.mission]));
  for (const m of world.missions) for (const t of m.crews) taskMission.set(t, m.id);
  const changedM = new Set<string>();
  const results: OpResult[] = [];
  let accepted = 0;

  const open = (id: string) => { const m = ms.get(id); return m && !m.archive ? m : null; };
  const titleTaken = (t: string, except?: string) => [...ms.values()].find((m) => !m.archive && m.id !== except && norm(m.title) === norm(t));
  const setM = (m: Mission) => { ms.set(m.id, { ...m, updated: world.now }); changedM.add(m.id); };
  const uniqueId = (base: string) => {
    const b = slugify(base) || "idea";
    if (!ms.has(b)) return b;
    for (let i = 2; ; i++) if (!ms.has(`${b}-${i}`)) return `${b}-${i}`;
  };
  const label = (id: string) => ms.get(id)?.title ?? id;

  /** Why a member can't move: the captain placed it, or it is unknown. */
  function taskBlock(id: string): string | null {
    if (!tasks.has(id)) return `there is no Firstmate task ${id}`;
    const pin = world.pins.tasks.get(id);
    return pin ? `the captain put task ${id} where it is (${pin})` : null;
  }
  function moveTask(id: string, to: string) {
    const from = taskMission.get(id) ?? null;
    if (from && ms.has(from)) { const f = ms.get(from)!; if (f.crews.includes(id)) setM({ ...f, crews: f.crews.filter((x) => x !== id) }); }
    // A task its brief marked may sit in no crews list yet; it can still only be in one.
    for (const m of ms.values()) if (m.id !== to && m.crews.includes(id)) setM({ ...m, crews: m.crews.filter((x) => x !== id) });
    const t = ms.get(to)!;
    if (!t.crews.includes(id)) setM({ ...t, crews: [...t.crews, id] });
    taskMission.set(id, to);
  }
  function check(op: PlacementOp): { reason: string } | { text: string; apply: () => void } {
    if (world.vetoes.has(opSignature(op))) return { reason: "the captain undid this change before" };
    switch (op.op) {
      case "create": {
        if (titleTaken(op.title)) return { reason: `an open idea is already called "${titleTaken(op.title)!.title}"` };
        for (const t of op.tasks) { const b = taskBlock(t); if (b) return { reason: b }; }
        const group = op.group ? world.lenses.find((l) => l.id === op.group || norm(l.title) === norm(op.group!)) : undefined;
        return {
          text: `Created idea "${op.title}"${op.tasks.length ? ` with ${op.tasks.join(", ")}` : ""}${group ? ` in ${group.title}` : ""}`,
          apply: () => {
            const id = uniqueId(op.title);
            setM(Mission.parse({ id, title: op.title, goal: op.goal, lenses: group ? [group.id] : [], created: world.now, updated: world.now }));
            for (const t of op.tasks) moveTask(t, id);
            (op as any).id = id;
          },
        };
      }
      case "move": {
        const to = open(op.to);
        if (!to) return { reason: `there is no open idea ${op.to}` };
        {
          const b = taskBlock(op.task);
          if (b) return { reason: b };
          const cur = taskMission.get(op.task) ?? null;
          if (op.from !== undefined && cur !== op.from) return { reason: `task ${op.task} moved to ${cur ? label(cur) : "no idea"} meanwhile` };
          if (cur === to.id) return { reason: `task ${op.task} is already in ${to.title}` };
          const task = op.task;
          return { text: `Filed ${task} in "${to.title}"${cur ? ` (from "${label(cur)}")` : ""}`, apply: () => moveTask(task, to.id) };
        }
      }
    }
  }

  for (const raw of input) {
    const n = normalizeOp(raw);
    if ("error" in n) { results.push({ op: (raw ?? {}) as Record<string, unknown>, status: "rejected", reason: `not a valid change: ${n.error}`, text: "Skipped an invalid change" }); continue; }
    const op = n.op;
    if (accepted >= maxOps) { results.push({ op, status: "rejected", reason: `over the limit of ${maxOps} changes per run`, text: describe(op) }); continue; }
    const c = check(op);
    if ("reason" in c) { results.push({ op, status: "rejected", reason: c.reason, text: describe(op) }); continue; }
    c.apply();
    accepted++;
    results.push({ op, status: ok, text: c.text });
  }
  return {
    results,
    missions: [...changedM].map((id) => ms.get(id)!),
    lenses: [],
  };
}

/** A plain sentence for an op that was not applied. */
export function describe(op: PlacementOp): string {
  switch (op.op) {
    case "create": return `Create idea "${op.title}"`;
    case "move": return `Move ${op.task} to ${op.to}`;
  }
}

/** One line for the commit subject and the ledger. */
export function summarize(results: OpResult[], max = 3): string {
  const done = results.filter((r) => r.status !== "rejected").map((r) => r.text);
  if (!done.length) return "no changes";
  const head = done.slice(0, max).join("; ");
  return truncate(done.length > max ? `${head}; and ${done.length - max} more` : head, 220);
}

// ---------- pins from git history ----------

export type LogEntry = { sha: string; at: string; subject: string; files: string[] };

/** Commit subjects the captain's own actions write (the map, mission pages, proposals, undo). */
const CAPTAIN_RE = /^joyride: (map move|undo map move|undo housekeeping|create mission|edit mission|update mission|accept proposal|reopen proposal|create lens|update lens|remove lens|unlink |link \d+ sessions? to|mission [^ ]+: (open|paused|done|dropped) ->)/;

/** Whether a commit subject records something the captain did (not Joyride's own automation). */
export const isCaptainCommit = (subject: string) => CAPTAIN_RE.test(subject);

/**
 * Pins from commit history, newest first or in any order. Map moves pin their task, session or
 * idea-to-group placement for good; any captain commit in the last PIN_DAYS days pins the ideas it touched.
 */
export function pinsFromLog(entries: LogEntry[], nowMs: number): Pins {
  const pins = emptyPins();
  const horizon = nowMs - PIN_DAYS * 864e5;
  const set = (map: Map<string, string>, k: string, v: string) => { if (!map.has(k)) map.set(k, v); };
  for (const e of [...entries].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!isCaptainCommit(e.subject)) continue;
    const day = e.at.slice(0, 10);
    const mv = e.subject.match(/^joyride: map move: (task|session|mission) (\S+) (?:to|out of) (.*)$/);
    if (mv) {
      const why = `moved on the map ${day}`;
      if (mv[1] === "task") set(pins.tasks, mv[2], why);
      else if (mv[1] === "session") set(pins.sessions, mv[2], why);
      else set(pins.grouped, mv[2], why);
    }
    if (Date.parse(e.at) < horizon) continue;
    for (const f of e.files) {
      const m = f.match(/^missions\/([^/]+)\.md$/);
      if (m) set(pins.ideas, m[1], `${e.subject.replace(/^joyride: /, "").split(":")[0]} ${day}`);
    }
  }
  return pins;
}

/** Parse `git log --format=%x00%H%x09%aI%x09%s --name-only` output. */
export function parseGitLog(out: string): LogEntry[] {
  return out.split("\0").map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [head, ...files] = chunk.split("\n");
    const [sha, at, ...rest] = head.split("\t");
    return { sha, at, subject: rest.join("\t"), files: files.map((f) => f.trim()).filter(Boolean) };
  });
}

// ---------- placement ----------

export type Placement = { idea: string | null; p: number; escalate: boolean; candidates: string[] };

/**
 * Jev's answer for "which idea is this task part of?": its pick stands when it names an open idea with
 * probability at least PLACE_THRESHOLD; "new", an unknown id or a weaker pick escalates to the heavy model.
 */
export function placementFromJev(choice: string | null, probs: Record<string, number>, ideaIds: string[]): Placement {
  const known = new Set(ideaIds);
  const candidates = Object.entries(probs).filter(([k]) => known.has(k)).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const p = choice ? probs[choice] ?? 0 : 0;
  if (choice && choice !== "new" && known.has(choice) && p >= PLACE_THRESHOLD) return { idea: choice, p, escalate: false, candidates };
  return { idea: null, p, escalate: true, candidates };
}

/** The part of a Firstmate brief that says what the task is, without the worker boilerplate around it. */
export function briefExcerpt(text: string, max = 900): string {
  const t = text.replace(/\r/g, "");
  const start = t.search(/^#{1,2} (Task|Captain's intent)\s*$/m);
  let body = start >= 0 ? t.slice(start) : t;
  const end = body.slice(1).search(/^# (?!Task)(Herdr|Setup|Rules|Firstmate|Project memory|Definition of done|Home brief)/m);
  if (end >= 0) body = body.slice(0, end + 1);
  return truncate(body.replace(/^#+ (Task|Captain's intent)\s*$/gm, "").replace(/joyride-(mission|request):.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), max);
}
