// The New box's one planner: freeform text in, a short list of steps in plain words out. Each step is
// something the captain can already do in the UI, done the same way:
//   - map edits name a MAP_ACTIONS entry (shared/map-actions.ts) and its arguments, so they run through
//     the same requests, endpoints and Undo as the map and the agents' `joyride map …`;
//   - notes and lists come from the compose-intent rules (shared/compose.ts) and save like the composer's;
//   - work goes to Firstmate through the existing request flow (a task, or a new idea);
//   - anything else is an update or a question for Firstmate.
// Deterministic and pure (no imports beyond compose.ts and board.ts): names are matched against a snapshot of the map.

import { itemKind, parseBlock } from "./board.ts";
import { noteLines, readCompose } from "./compose.ts";

/** What the map shows, by the names the captain sees. */
export type MapIndex = {
  /** Open ideas; `group` is the authored group (lens) it sits in, `repo` the repo group it falls back to. */
  ideas: { id: string; title: string; group: string | null; repo: { path: string; title: string } | null }[];
  /** Authored groups (lenses). */
  groups: { id: string; title: string }[];
  /** Repo groups: derived from ideas that no group claims. `path` "" is No repo. */
  repoGroups: { path: string; title: string }[];
  /** Unfiled groups, one per project. `project` "" is No project. */
  unfiled: { project: string; title: string }[];
  /** Firstmate tasks, with the idea each sits in. */
  tasks: { id: string; title: string; idea: string | null }[];
  /** Sessions on the map: `key` is the session key (claude:<id>); `idea` and `group` say where it sits; `hidden` when set aside. */
  sessions: { key: string; title: string; idea: string | null; group?: string | null; hidden?: boolean }[];
  /** Map edits, newest first, for "undo". */
  history?: { commit: string | null; key?: string; summary: string; undone: boolean }[];
};

/** Where an applied step lands on the map, for "Show on map". */
export type Landing = { kind: "idea"; id: string } | { kind: "region"; id: string } | { kind: "task"; id: string } | { kind: "hub" }
  /**
   * A board item's card (or chip): `zoom` to see it at that level; `quiet` pans without the landing mark (a ghost
   * card marks it on arrival); `board`, the scope whose board must hold it (just moved: not its old spot).
   */
  | { kind: "item"; id: string; place?: Landing; zoom?: "mid" | "near"; quiet?: boolean; board?: string };

/** A value filled in at apply time from an earlier step's result: the group that step made. */
export type LensRef = { $lens: number };

export type Step =
  | { kind: "map"; action: string; args: Record<string, unknown>; say: string; lands?: Landing }
  | { kind: "note" | "list"; idea: string | null; ideaTitle: string | null; place: Place; title: string | null; lines: string[]; text: string; say: string }
  | { kind: "task"; idea: string | null; ideaTitle: string | null; text: string; unsure: boolean; say: string }
  | { kind: "idea"; title: string | null; text: string; say: string }
  | { kind: "firstmate"; text: string; idea?: string; say: string };
/**
 * A name that matches more than one thing, or text that could be a task or a message: the captain picks.
 * `pick` is the option already chosen when one is the better guess.
 */
export type Choose = { kind: "choose"; say: string; options: Step[]; pick?: number };
export type PlanStep = Step | Choose;
export type Plan = {
  steps: PlanStep[];
  /** Lines shown above the steps: names that did not match anything. */
  notes: string[];
  /** One step, nothing to pick and nothing guessed: Enter applies it. */
  sure: boolean;
};

/**
 * What New was opened on: an idea ("+ Add to this idea"), a group (a group's "+"), and the group the captain
 * is pointing at or focused on the map (`current`), the default home for a board item.
 */
export type PlanContext = {
  idea?: { id: string; title: string } | null;
  group?: { id: string; title: string } | null;
  /** Opened from the hub's "+": a board item goes to Unfiled, whatever group is current. */
  unfiled?: boolean;
  current?: { id: string; title: string } | null;
};

// ---------- names ----------

type Kind = "idea" | "task" | "session" | "group" | "repo" | "unfiled";
type Ref = { kind: Kind; id: string; title: string; created?: number };

const QUOTES = /[“”"‘’'`«»]/g;
const norm = (s: string) => s.toLowerCase().replace(QUOTES, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
/** A name as typed: quotes, a leading "the" and a trailing kind word dropped. */
export function bareName(s: string): string {
  return tidy(s.replace(/[.!]+$/, "")).replace(/^(?:the|my|our)\s+/i, "").replace(QUOTES, "").replace(/\s+(?:idea|group|session|task)$/i, "").trim();
}
const STOP = new Set(["the", "a", "an", "of", "for", "and", "to", "in", "on"]);
const words = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

/** How well a typed name matches a title (or an id): 1 exact, down to 0. */
export function nameScore(typed: string, title: string, id?: string): number {
  const a = norm(bareName(typed)), b = norm(title);
  if (!a || !b) return 0;
  if (a === b || (id && a === norm(id))) return 1;
  if (b.startsWith(a) && a.length >= 3) return 0.9;
  if (b.includes(a) && a.length >= 3) return 0.8;
  const qa = words(a), qb = words(b);
  if (!qa.length) return 0;
  const hit = qa.filter((t) => qb.some((w) => w === t || (t.length >= 3 && w.startsWith(t)))).length;
  if (hit === qa.length) return 0.7;
  if (a.includes(b) && b.length >= 4) return 0.6;
  return qa.length >= 2 && hit / qa.length >= 0.66 ? 0.5 : 0;
}

/** The refs a typed name means: one when it is clear, several when it is not, none when nothing matches. */
export function resolveName(typed: string, refs: Ref[]): Ref[] {
  const scored = refs.map((r) => ({ r, s: nameScore(typed, r.title, r.kind === "repo" || r.kind === "unfiled" ? undefined : r.id) })).filter((x) => x.s >= 0.5);
  if (!scored.length) return [];
  scored.sort((x, y) => y.s - x.s);
  const top = scored[0].s;
  const near = scored.filter((x) => (top === 1 ? x.s === 1 : top - x.s < 0.15));
  // The same thing reached two ways (an idea's title and its id) counts once.
  const seen = new Set<string>();
  return near.map((x) => x.r).filter((r) => { const k = `${r.kind}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const q = (s: string) => `“${s}”`;
const short = (s: string, n = 60) => { const t = tidy(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// ---------- the index as refs ----------

function refs(ix: MapIndex, made: Ref[]) {
  return {
    ideas: ix.ideas.map((i): Ref => ({ kind: "idea", id: i.id, title: i.title })),
    tasks: ix.tasks.map((t): Ref => ({ kind: "task", id: t.id, title: t.title || t.id })),
    sessions: ix.sessions.map((s): Ref => ({ kind: "session", id: s.key, title: s.title || s.key })),
    groups: [...ix.groups.map((g): Ref => ({ kind: "group", id: g.id, title: g.title })), ...made],
    repos: ix.repoGroups.map((r): Ref => ({ kind: "repo", id: r.path, title: r.title })),
    unfiled: ix.unfiled.map((u): Ref => ({ kind: "unfiled", id: u.project, title: u.title })),
  };
}

const regionOf = (r: Ref): Landing => r.kind === "group" ? (r.created !== undefined ? { kind: "hub" } : { kind: "region", id: `lens:${r.id}` })
  : r.kind === "repo" ? { kind: "region", id: `repo:${r.id || "none"}` } : r.kind === "unfiled" ? { kind: "region", id: `unfiled:${r.id || "none"}` }
  : r.kind === "idea" ? { kind: "idea", id: r.id } : r.kind === "task" ? { kind: "task", id: r.id } : { kind: "hub" };
const groupArg = (r: Ref): string | LensRef => (r.created !== undefined ? { $lens: r.created } : r.id);

// ---------- clauses ----------

/** `final`: a miss that sending the words to Firstmate wouldn't help (nothing to undo). */
type Out = { steps: PlanStep[]; notes: string[]; made: Ref[]; final?: boolean } | null;
const one = (s: PlanStep, made: Ref[] = []): Out => ({ steps: [s], notes: [], made });
const miss = (note: string, final = false): Out => ({ steps: [], notes: [note], made: [], final });
const choose = (say: string, options: Step[]): PlanStep => (options.length === 1 ? options[0] : { kind: "choose", say, options });

const NAME = String.raw`(.+?)`;
const KIND_WORD = String.raw`(?:(idea|task|session|group)\s+)?`;
const NEW_GROUP = /^(?:a\s+)?new\s+group(?:\s+(?:called|named|titled))?\s*[:\-–—]?\s*(.+)$/i;
const UNFILED = /^(?:unfiled|no\s+idea|nowhere|out\s+of\s+(?:its|the)\s+idea)$/i;
const HOME = /^(?:its\s+)?(?:own\s+)?(?:repo|home)(?:\s+group)?$|^back$/i;

/** "A and B", "A, B": several names, unless the whole phrase is a name itself. */
function splitNames(s: string): string[] {
  return s.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/i).map((x) => x.trim()).filter(Boolean);
}
function namesIn(phrase: string, pool: Ref[]): string[] {
  const parts = splitNames(phrase);
  if (parts.length < 2 || pool.some((r) => nameScore(phrase, r.title, r.id) === 1)) return [phrase];
  return parts.every((p) => resolveName(p, pool).length) ? parts : [phrase];
}

function undoClause(text: string, ix: MapIndex): Out {
  if (!/^(?:undo|revert|take\s+back|roll\s+back)(?:\s+(?:that|it|this|the\s+last\s+(?:move|change|edit|one)|last(?:\s+(?:move|change|edit))?|my\s+last\s+(?:move|change|edit)))?$/i.test(text)) return null;
  const last = (ix.history ?? []).find((h) => !h.undone && (h.commit || h.key));
  if (!last) return miss("There's no map change to undo.", true);
  if (last.commit) return one({ kind: "map", action: "undo", args: { commit: last.commit }, say: `Undo ${q(short(last.summary))}`, lands: { kind: "hub" } });
  return one({ kind: "map", action: "unhide", args: { key: last.key }, say: `Undo ${q(short(last.summary))}: bring it back to the map`, lands: { kind: "hub" } });
}

function renameClause(text: string, ix: MapIndex, made: Ref[]): Out {
  const m = new RegExp(String.raw`^(?:rename|retitle)\s+(?:the\s+)?(?:group\s+)?${NAME}\s+(?:group\s+)?(?:to|as|into)\s+${NAME}$`, "i").exec(text);
  if (!m) return null;
  const to = bareName(m[2]);
  const r = refs(ix, made);
  const hits = resolveName(m[1], [...r.groups.filter((g) => g.created === undefined), ...r.repos, ...r.unfiled]);
  if (!hits.length) {
    const idea = resolveName(m[1], r.ideas);
    return miss(idea.length ? `New renames groups. To rename the idea ${q(idea[0].title)}, open it and edit its title.` : `There's no group called ${q(bareName(m[1]))} on the map.`);
  }
  const opts = hits.map((h): Step => {
    if (h.kind === "repo") return { kind: "map", action: "rename-repo-group", args: { repo: h.id, title: to }, say: `Name the repo group ${q(h.title)} ${q(to)}, keeping its ideas`, lands: regionOf(h) };
    if (h.kind === "unfiled") return { kind: "map", action: "rename-unfiled-group", args: { project: h.id, title: to }, say: `Name the Unfiled group ${q(h.title)} ${q(to)}, keeping its sessions`, lands: regionOf(h) };
    return { kind: "map", action: "rename-group", args: { group: h.id, title: to }, say: `Rename group ${q(h.title)} to ${q(to)}`, lands: regionOf(h) };
  });
  return one(choose(`Which ${q(bareName(m[1]))}?`, opts));
}

function mergeClause(text: string, ix: MapIndex, made: Ref[]): Out {
  const m = new RegExp(String.raw`^(?:merge|combine|fold)\s+(?:the\s+)?(?:group\s+)?${NAME}\s+(?:group\s+)?(?:into|with)\s+(?:the\s+)?(?:group\s+)?${NAME}$`, "i").exec(text);
  if (!m) return null;
  const groups = refs(ix, made).groups.filter((g) => g.created === undefined);
  const a = resolveName(m[1], groups), b = resolveName(m[2], groups);
  if (!a.length || !b.length) return miss(`There's no group called ${q(bareName(!a.length ? m[1] : m[2]))} on the map.`);
  const opts: Step[] = [];
  for (const x of a) for (const y of b) if (x.id !== y.id) opts.push({ kind: "map", action: "merge-group", args: { group: x.id, into: y.id }, say: `Merge group ${q(x.title)} into ${q(y.title)}`, lands: regionOf(y) });
  if (!opts.length) return miss(`${q(a[0].title)} can't be merged into itself.`);
  return one(choose("Which groups?", opts));
}

function deleteClause(text: string, ix: MapIndex, made: Ref[]): Out {
  const m = new RegExp(String.raw`^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?group\s+${NAME}$|^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?${NAME}\s+group$`, "i").exec(text);
  // "delete Q4 bets": only when the name is a group's and nothing else's.
  const bare = m ? null : /^(?:delete|remove|get\s+rid\s+of)\s+(?:the\s+)?(.+)$/i.exec(text);
  if (!m && !bare) return null;
  const name = m ? m[1] ?? m[2] : bare![1];
  const r = refs(ix, made);
  const hits = resolveName(name, r.groups.filter((g) => g.created === undefined));
  if (bare && (!hits.length || nameScore(name, hits[0].title) < 0.9 || resolveName(name, [...r.ideas, ...r.tasks, ...r.sessions]).length)) return null;
  if (!hits.length) return miss(`There's no group called ${q(bareName(name))} on the map.`);
  return one(choose(`Which ${q(bareName(name))}?`, hits.map((h) => ({ kind: "map", action: "delete-group", args: { group: h.id }, say: `Delete group ${q(h.title)}; its ideas and sessions go back to where they were`, lands: { kind: "hub" } }))));
}

function newGroupClause(text: string, ix: MapIndex, made: Ref[], index: number): Out {
  const m = new RegExp(String.raw`^(?:create|make|add|start|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:empty\s+)?group\s*(?:called|named|titled|for)?\s*[:\-–—]?\s*${NAME}(?:\s+(?:with|holding|containing)\s+(.+))?$`, "i").exec(text);
  if (!m) return null;
  const title = bareName(m[1]);
  if (!title) return null;
  const ref: Ref = { kind: "group", id: `new:${index}`, title, created: index };
  if (!m[2]) return one({ kind: "map", action: "new-empty-group", args: { title }, say: `Make an empty group ${q(title)}`, lands: { kind: "hub" } }, [ref]);
  // "with A and B": the first joins as the group is made; the rest move into it next.
  const r = refs(ix, made);
  const names = namesIn(m[2], [...r.ideas, ...r.sessions]);
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  names.forEach((n, i) => {
    const hits = resolveName(n, [...r.ideas, ...r.sessions]);
    if (!hits.length) { notes.push(`Nothing on the map is called ${q(bareName(n))}.`); return; }
    const opts = hits.map((h): Step => {
      if (i === 0 && !steps.length) {
        return h.kind === "idea"
          ? { kind: "map", action: "new-group", args: { title, idea: h.id }, say: `Make a group ${q(title)} with ${q(h.title)}`, lands: { kind: "idea", id: h.id } }
          : { kind: "map", action: "new-session-group", args: { title, session: h.id }, say: `Make a group ${q(title)} with session ${q(h.title)}`, lands: { kind: "hub" } };
      }
      return h.kind === "idea"
        ? { kind: "map", action: "move-idea", args: { idea: h.id, to_group: groupArg(ref) }, say: `Move ${q(h.title)} to group ${q(title)}`, lands: { kind: "idea", id: h.id } }
        : { kind: "map", action: "move-session", args: { session: h.id, to_group: groupArg(ref) }, say: `Move session ${q(h.title)} to group ${q(title)}`, lands: { kind: "hub" } };
    });
    steps.push(choose(`Which ${q(bareName(n))}?`, opts));
  });
  if (!steps.length) return { steps: [], notes, made: [] };
  return { steps, notes, made: [ref] };
}

function hideClause(text: string, ix: MapIndex): Out {
  const set = /^(?:hide|set\s+aside|put\s+aside|park)\s+(.+)$/i.exec(text) ?? /^(?:set|put)\s+(.+?)\s+aside$/i.exec(text);
  const back = /^(?:unhide|bring\s+back|restore|return)\s+(.+?)(?:\s+to\s+the\s+map)?$/i.exec(text);
  const m = set ?? back;
  if (!m) return null;
  const pool = ix.sessions.filter((s) => (set ? !s.hidden : s.hidden));
  const hits = resolveName(m[1], pool.map((s) => ({ kind: "session", id: s.key, title: s.title || s.key })));
  if (!hits.length) {
    if (!set) return null;
    return miss(`There's no session called ${q(bareName(m[1]))} to set aside. Only sessions and workers can be set aside.`);
  }
  return one(choose(`Which ${q(bareName(m[1]))}?`, hits.map((h): Step => set
    ? { kind: "map", action: "hide", args: { key: h.id }, say: `Set session ${q(h.title)} aside until it does something new`, lands: { kind: "hub" } }
    : { kind: "map", action: "unhide", args: { key: h.id }, say: `Bring session ${q(h.title)} back to the map`, lands: { kind: "hub" } })));
}

const MOVE = new RegExp(String.raw`^(?:move|put|file|drag|shift|place|stick|drop|send|add)\s+(?:the\s+)?${KIND_WORD}${NAME}\s+(?:back\s+)?(?:to|into|in|under|onto|over\s+to|in\s+with)\s+(?:the\s+)?${KIND_WORD}${NAME}$`, "i");
const TAKE_OUT = new RegExp(String.raw`^(?:take|move|remove|pull)\s+(?:the\s+)?${KIND_WORD}${NAME}\s+out\s+of\s+(?:the\s+)?${KIND_WORD}${NAME}$`, "i");

/** The steps for moving `x` to `to`, or null when that move isn't one the map makes. */
function moveStep(x: Ref, to: Ref | "unfiled" | "home" | { newGroup: string }, ix: MapIndex, index: number): { step: Step; made?: Ref } | null {
  if (x.kind === "idea") {
    const idea = ix.ideas.find((i) => i.id === x.id);
    if (to === "home") {
      if (!idea?.group) return null;
      return { step: { kind: "map", action: "move-idea", args: { idea: x.id, to_group: "none" }, say: `Move ${q(x.title)} back to its repo group${idea.repo ? ` ${q(idea.repo.title)}` : ""}`, lands: { kind: "idea", id: x.id } } };
    }
    if (to === "unfiled") return null;
    if ("newGroup" in to) {
      const made: Ref = { kind: "group", id: `new:${index}`, title: to.newGroup, created: index };
      return { step: { kind: "map", action: "new-group", args: { title: to.newGroup, idea: x.id }, say: `Make a group ${q(to.newGroup)} with ${q(x.title)}`, lands: { kind: "idea", id: x.id } }, made };
    }
    if (to.kind === "group") return idea?.group === to.id ? null : { step: { kind: "map", action: "move-idea", args: { idea: x.id, to_group: groupArg(to) }, say: `Move ${q(x.title)} to group ${q(to.title)}`, lands: { kind: "idea", id: x.id } } };
    if (to.kind === "repo" && idea?.group && idea.repo?.path === to.id) return moveStep(x, "home", ix, index);
    return null;
  }
  if (x.kind === "task") {
    if (typeof to === "object" && "kind" in to && to.kind === "idea") return { step: { kind: "map", action: "move-task", args: { task: x.id, to_idea: to.id }, say: `Move task ${q(x.title)} to idea ${q(to.title)}`, lands: { kind: "task", id: x.id } } };
    return null;
  }
  if (x.kind === "session") {
    if (to === "unfiled" || to === "home") return { step: { kind: "map", action: "file-session", args: { session: x.id, to_idea: "none" }, say: `Move session ${q(x.title)} to Unfiled`, lands: { kind: "hub" } } };
    if ("newGroup" in to) {
      const made: Ref = { kind: "group", id: `new:${index}`, title: to.newGroup, created: index };
      return { step: { kind: "map", action: "new-session-group", args: { title: to.newGroup, session: x.id }, say: `Make a group ${q(to.newGroup)} with session ${q(x.title)}`, lands: { kind: "hub" } }, made };
    }
    if (to.kind === "idea") return { step: { kind: "map", action: "file-session", args: { session: x.id, to_idea: to.id }, say: `File session ${q(x.title)} in idea ${q(to.title)}`, lands: { kind: "idea", id: to.id } } };
    if (to.kind === "group") return { step: { kind: "map", action: "move-session", args: { session: x.id, to_group: groupArg(to) }, say: `Move session ${q(x.title)} to group ${q(to.title)}`, lands: regionOf(to) } };
    if (to.kind === "unfiled") return moveStep(x, "unfiled", ix, index);
  }
  return null;
}

const kindsFor = (w: string | undefined): Kind[] | null =>
  w === "idea" ? ["idea"] : w === "task" ? ["task"] : w === "session" ? ["session"] : w === "group" ? ["group", "repo", "unfiled"] : null;

function moveClause(text: string, ix: MapIndex, made: Ref[], index: number): Out {
  const out = TAKE_OUT.exec(text);
  const m = out ?? MOVE.exec(text);
  if (!m) return null;
  const [, xKind, xName, , toNameRaw] = m;
  const toKind = m[3];
  // "add a footer row to …" names something new, not a card on the map.
  if (/^(?:a|an|some|another|more)\s/i.test(xName)) return null;
  const r = refs(ix, made);
  const subjectPool = (kindsFor(xKind) ?? ["idea", "task", "session"]).flatMap((k) => (k === "idea" ? r.ideas : k === "task" ? r.tasks : k === "session" ? r.sessions : []));
  // Where it goes: Unfiled, its repo group, a new group, or a named idea or group.
  const toName = toNameRaw.trim();
  let target: (Ref | "unfiled" | "home" | { newGroup: string })[] = [];
  const ng = NEW_GROUP.exec(toName);
  if (out) target = ["home"];
  else if (ng) target = [{ newGroup: bareName(ng[1]) }];
  else if (UNFILED.test(toName)) target = ["unfiled"];
  else if (HOME.test(toName)) target = ["home"];
  else {
    const toPool = (kindsFor(toKind) ?? ["idea", "group", "repo", "unfiled"]).flatMap((k) => (k === "idea" ? r.ideas : k === "group" ? r.groups : k === "repo" ? r.repos : k === "unfiled" ? r.unfiled : []));
    target = resolveName(toName, toPool);
    // "to group Q4 bets" when no group has that name: make it.
    if (!target.length && toKind === "group") target = [{ newGroup: bareName(toName) }];
  }
  const names = namesIn(xName, subjectPool);
  const subjects = resolveName(xName, subjectPool);
  if (!target.length) {
    const any = names.some((n) => resolveName(n, subjectPool).length);
    if (!any) return null;
    return miss(`There's no idea or group called ${q(bareName(toName))} on the map.`);
  }
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  let newMade: Ref | undefined;
  for (const n of names) {
    const hits = names.length === 1 ? subjects : resolveName(n, subjectPool);
    if (!hits.length) { if (names.length > 1) notes.push(`Nothing on the map is called ${q(bareName(n))}.`); continue; }
    const opts: Step[] = [];
    for (const h of hits) for (const t of target) {
      // After a new group is made for the first name, the rest move into it.
      const to = newMade && typeof t === "object" && "newGroup" in t ? newMade : t;
      const s = moveStep(h, to, ix, index);
      if (s) { opts.push(s.step); if (s.made && hits.length === 1 && target.length === 1) newMade = s.made; }
    }
    if (opts.length) steps.push(choose(`Which ${q(bareName(n))}?`, opts));
    else notes.push(cantMove(hits[0], target[0]));
  }
  if (!steps.length && !notes.length) return null;
  return { steps, notes, made: newMade ? [newMade] : [] };
}

function cantMove(x: Ref, to: Ref | "unfiled" | "home" | { newGroup: string }): string {
  const where = to === "unfiled" ? "Unfiled" : to === "home" ? "its repo group" : "newGroup" in to ? `a new group` : q(to.title);
  if (x.kind === "task") return `A task moves only to another idea, so ${q(x.title)} can't go to ${where}.`;
  if (x.kind === "idea" && to === "home") return `${q(x.title)} is already in its repo group.`;
  if (x.kind === "idea" && typeof to === "object" && "kind" in to && to.kind === "group") return `${q(x.title)} is already in ${q(to.title)}.`;
  if (x.kind === "idea") return `An idea moves to a group, so ${q(x.title)} can't go to ${where}.`;
  return `${q(x.title)} can't go to ${where}.`;
}

/** Where a board item lands: an authored group, an idea, or Unfiled (the hub's board). */
export type Place = { kind: "group" | "idea"; id: string; title: string } | { kind: "unfiled" };
export const placeScope = (p: Place) => (p.kind === "unfiled" ? "global" : p.kind === "group" ? `group:${p.id}` : `mission:${p.id}`);
export const placeName = (p: Place) => (p.kind === "unfiled" ? "Unfiled" : p.title);
export const placeLanding = (p: Place): Landing => (p.kind === "unfiled" ? { kind: "hub" } : p.kind === "group" ? { kind: "region", id: `lens:${p.id}` } : { kind: "idea", id: p.id });
const UNFILED_PLACE = /^(?:unfiled|the\s+hub|hub|nowhere|no\s+group)$/i;

/** The place a typed name means: Unfiled, or the groups and ideas it matches. */
function placesNamed(name: string, ix: MapIndex): Place[] {
  if (UNFILED_PLACE.test(bareName(name))) return [{ kind: "unfiled" }];
  const pool: Ref[] = [...ix.groups.map((g): Ref => ({ kind: "group", id: g.id, title: g.title })), ...ix.ideas.map((i): Ref => ({ kind: "idea", id: i.id, title: i.title }))];
  return resolveName(name, pool).map((h) => ({ kind: h.kind === "group" ? "group" : "idea", id: h.id, title: h.title }));
}

/** Where a board item goes when the words don't say: the idea or group New was opened on, else the current group, else Unfiled. */
export function defaultPlace(ctx: PlanContext): Place {
  if (ctx.idea) return { kind: "idea", ...ctx.idea };
  if (ctx.group) return { kind: "group", ...ctx.group };
  if (ctx.unfiled) return { kind: "unfiled" };
  if (ctx.current) return { kind: "group", ...ctx.current };
  return { kind: "unfiled" };
}

const BOARD_VERB = String.raw`(?:please\s+)?(?:make|start|create|add|begin|new|take|leave|write|save|jot(?:\s+down)?|drop|keep|pin|bookmark)\s+(?:me\s+)?(?:a|an|another|a\s+new|new|this|that)?\s*(?:[\w'’-]+\s+){0,3}?(?:check\s*list|checklist|to-?do\s+list|list|note|link|pdf|url|bookmark)`;
const SCOPED_PREFIX = new RegExp(String.raw`^(${BOARD_VERB})\s+(?:in|on|to|under|for|into)\s+(?:the\s+)?(?:idea\s+|group\s+)?(.+?)(?:\s+(?:idea|group))?(\s*[:\-–—\n][\s\S]*)$`, "i");

/** A board step: a note (or link, or mixed card) or a list, for `place`. New's place picker re-makes it with this. */
export function boardStep(kind: "note" | "list", place: Place, title: string | null, lines: string[], text: string): Step {
  const where = `in ${placeName(place)}`;
  const idea = place.kind === "idea" ? place : null;
  const base = { idea: idea?.id ?? null, ideaTitle: idea?.title ?? null, place, title, lines, text };
  if (kind === "list") {
    const named = title ? ` ${q(title)}` : "";
    return { kind, ...base, say: lines.length ? `Make a list${named} ${where}: ${short(lines.join(", "), 80)}` : `Make a list${named} ${where}` };
  }
  const k = itemKind(lines);
  const shown = (b: string) => { const x = parseBlock(b); return x.kind === "link" ? x.link.title : x.kind === "todo" ? x.text : b; };
  const what = k === "link" ? (lines.length > 1 ? `${lines.length} links` : "a link") : "a note";
  return { kind, ...base, say: `Save ${what} ${where}: ${short(lines.map(shown).join(" · "), 80)}` };
}

/** A note, list or link, with "in <group>" or "on <idea>" naming where it goes. */
function noteClause(text: string, ix: MapIndex, ctx: PlanContext): Out {
  let body = text;
  let places: Place[] = [defaultPlace(ctx)];
  const scoped = SCOPED_PREFIX.exec(text);
  if (scoped) {
    const hits = placesNamed(scoped[2], ix);
    if (hits.length) { places = hits; body = `${scoped[1]}${scoped[3]}`; }
  }
  const r = readCompose(body);
  if (r.kind === "task" || !r.sure) return null;
  const steps = places.map((p) => boardStep(r.kind as "note" | "list", p, r.title, r.lines, body));
  return one(choose(`Where does it go?`, steps));
}

/** On a group's (or the hub's) "+": words that aren't a map edit or a request for Firstmate are a note there. */
function groupNote(text: string, ctx: PlanContext): Out {
  if ((!ctx.group && !ctx.unfiled) || TASK.test(text) || IDEA.test(text) || TELL.test(text)) return null;
  const lines = noteLines(text);
  return lines.length ? one(boardStep("note", defaultPlace({ group: ctx.group, unfiled: ctx.unfiled }), null, lines, text)) : null;
}

// ---------- requests to Firstmate ----------

const IDEA = /^(?:(?:start|create|make|add|open|begin)\s+(?:a\s+|an\s+)?(?:new\s+)?idea|new\s+idea|idea)\b\s*(?:called|named|titled|for|about|to)?\s*[:\-–—]?\s*([\s\S]+)$/i;
const TASK = /^(?:new\s+task|task|to-?do)\s*[:\-–—]\s*([\s\S]+)$|^(?:ask|have|get)\s+(?:firstmate|the\s+crew|a\s+crewmate|someone|an\s+agent)\s+to\s+([\s\S]+)$/i;
const TELL = /^(?:@?firstmate|fm)\s*[,:\-–—]\s*([\s\S]+)$|^(?:tell|message|ping|update)\s+(?:@?firstmate|fm)\b\s*(?:that\s+|about\s+|:\s*|,\s*)?([\s\S]*)$|^(?:fyi|update|heads\s+up|question|status\s+update)\s*[:,\-–—]\s*([\s\S]+)$/i;
const QUESTION = /^(?:what|why|how|when|where|who|whose|which|is|are|was|were|can|could|should|would|will|did|does|has|have|any)\b/i;
/** "Can you …", "could you please …": a polite order. */
const POLITE = /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i;
const IMPERATIVE = new RegExp(String.raw`^(?:please\s+)?(?:fix|add|build|make|write|implement|refactor|investigate|look\s+into|look\s+at|research|create|set\s+up|setup|review|test|debug|ship|update|remove|delete|rename|migrate|clean\s+up|clean|document|draft|design|prototype|port|upgrade|bump|profile|optimi[sz]e|speed\s+up|find|check|audit|explore|try|run|land|merge|split|extract|wire|hook\s+up|figure\s+out|prepare|plan|summari[sz]e|analy[sz]e|compare|reproduce|triage|improve|replace|convert|support|handle|change|move|rewrite|polish|tighten|simplify|finish|start|continue|resume|deploy|release|verify|validate|benchmark|measure|instrument|enable|disable|turn\s+on|turn\s+off|allow|block|stop|teach|train|tune|translate|record|capture|generate|scaffold|bootstrap|install|configure|integrate|connect|sync|import|export|backfill|seed|upload|download|fetch|scrape|crawl|index|search|sort|group|tag|label|annotate|outline|spec|scope|estimate|sketch|mock|stub|cover)\b`, "i");

function taskStep(text: string, ctx: PlanContext, unsure = false): Step {
  const idea = ctx.idea ?? null;
  return { kind: "task", idea: idea?.id ?? null, ideaTitle: idea?.title ?? null, text, unsure, say: idea ? `New task in ${idea.title}: ${q(short(text, 80))}` : `New task for Firstmate: ${q(short(text, 80))}. Joyride finds where it fits.` };
}
const tellStep = (text: string, ctx: PlanContext): Step => ({ kind: "firstmate", text, ...(ctx.idea ? { idea: ctx.idea.id } : {}), say: `Send to Firstmate${ctx.idea ? ` about ${ctx.idea.title}` : ""}: ${q(short(text, 90))}` });

/** Work, a new idea, or a message for Firstmate. `sure` is false when the words didn't say which. */
function requestOf(text: string, ctx: PlanContext): { steps: PlanStep[]; sure: boolean } {
  const idea = IDEA.exec(text);
  if (idea && !ctx.idea) {
    const brief = idea[1].trim();
    const title = short(brief.split(/\n|\s[-–—]\s|[.:]\s/)[0].replace(/[.!?]+$/, ""), 80);
    return { steps: [{ kind: "idea", title, text: brief, say: `Start a new idea ${q(title)} and send it to Firstmate` }], sure: true };
  }
  const task = TASK.exec(text);
  if (task) return { steps: [taskStep((task[1] ?? task[2]).trim(), ctx)], sure: true };
  const tell = TELL.exec(text);
  if (tell) {
    const body = (tell[1] ?? tell[2] ?? tell[3] ?? "").trim();
    // "ask firstmate to …" is work; "tell firstmate to …" is too.
    const work = /^to\s+([\s\S]+)$/i.exec(body);
    if (work) return { steps: [taskStep(work[1].trim(), ctx)], sure: true };
    return body ? { steps: [tellStep(body, ctx)], sure: true } : { steps: [], sure: false };
  }
  const compose = readCompose(text);
  const polite = POLITE.exec(text);
  if (polite && IMPERATIVE.test(text.slice(polite[0].length))) return { steps: [taskStep(text, ctx, !compose.sure)], sure: true };
  if (/\?\s*$/.test(text) || QUESTION.test(text) || /^remind\s+(?:@?firstmate|fm)\b/i.test(text)) return { steps: [tellStep(text, ctx)], sure: true };
  if (IMPERATIVE.test(text)) return { steps: [taskStep(text, ctx, !compose.sure)], sure: true };
  // Neither a question nor an order: the captain picks, a message to Firstmate first.
  return { steps: [{ kind: "choose", say: "Is this a message or work?", options: [tellStep(text, ctx), taskStep(text, ctx, !compose.sure)], pick: 0 }], sure: false };
}

// ---------- the plan ----------

/** One instruction per line, sentence or "then"; a note or a list keeps its lines. */
export function clauses(text: string): string[] {
  return text.split(/\n+|;\s*|(?<=[.!])\s+(?=[A-Z“"'])|,?\s+(?:and\s+)?then\s+/).map((c) => c.trim().replace(/[.!]+$/, "").trim()).filter(Boolean);
}

/** Plan what `raw` asks for, against the map in `ix`. */
export function planNew(raw: string, ix: MapIndex, ctx: PlanContext = {}): Plan {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { steps: [], notes: [], sure: false };
  // A note or a list takes the whole text, its lines included.
  const note = noteClause(text, ix, ctx);
  if (note) return finish(note.steps, note.notes, true);
  const parts = clauses(text);
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  const rest: string[] = [];
  let made: Ref[] = [];
  let final = false;
  for (const c of parts) {
    const idx = steps.length;
    const out = undoClause(c, ix) ?? renameClause(c, ix, made) ?? mergeClause(c, ix, made) ?? newGroupClause(c, ix, made, idx)
      ?? moveClause(c, ix, made, idx) ?? deleteClause(c, ix, made) ?? hideClause(c, ix);
    if (!out) { rest.push(c); continue; }
    // Forward references count steps, so a step's group index is where it sits in the plan.
    steps.push(...out.steps);
    notes.push(...out.notes);
    made = [...made, ...out.made];
    final ||= !!out.final;
  }
  if (!steps.length) {
    // Nothing on the map to change: the words go to Firstmate, after any note on what didn't match.
    if (final) return finish([], notes, false);
    const g = notes.length ? null : groupNote(text, ctx);
    if (g) return finish(g.steps, [], true);
    const r = requestOf(text, ctx);
    return finish(r.steps, notes, r.sure);
  }
  // Map edits plus words that are not: the words go to Firstmate as they are.
  let sure = !notes.length && !rest.length;
  if (rest.length) {
    const r = requestOf(rest.join("\n"), ctx);
    steps.push(...r.steps);
    sure = false;
  }
  return finish(steps, notes, sure);
}

function finish(steps: PlanStep[], notes: string[], sure: boolean): Plan {
  return { steps, notes, sure: sure && steps.length === 1 && steps[0].kind !== "choose" && !notes.length };
}

/** The plan with the captain's picks: `picks[i]` is the option chosen for step i when it is a choice, else its default. Null while a choice is open. */
export function resolvePlan(plan: Plan, picks: Record<number, number>): Step[] | null {
  const out: Step[] = [];
  for (const [i, s] of plan.steps.entries()) {
    if (s.kind !== "choose") { out.push(s); continue; }
    const p = picks[i] ?? s.pick;
    if (p === undefined || !s.options[p]) return null;
    out.push(s.options[p]);
  }
  return out;
}

/** Fill a step's forward references from what earlier steps returned (the groups they made). */
export function bindArgs(args: Record<string, unknown>, results: ({ lens?: string | null } | null)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === "object" && "$lens" in (v as LensRef)) {
      const lens = results[(v as LensRef).$lens]?.lens;
      if (!lens) throw new Error("The group this step moves into wasn't made, so it was skipped.");
      out[k] = lens;
    } else out[k] = v;
  }
  return out;
}
