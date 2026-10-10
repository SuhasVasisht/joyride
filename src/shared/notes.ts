// Notes: the captain's quick bullets, stored as authored markdown files with `kind: note`.
// Pure helpers shared by the notes module, the `joyride notes` CLI and the
// SessionStart hook (which must stay dependency-light: no imports here).

/** Firstmate task ids, mission slugs: the same shape fm-send.sh accepts. */
export const TASK_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** The per-task notes digest the SessionStart hook appends for a crewmate (FM_TASK_ID), in .joyride/task-notes. */
export const taskDigestFile = (task: string) => (TASK_ID_RE.test(task) ? `task-${task}.md` : null);
export const TASK_DIGEST_RE = /^task-[A-Za-z0-9._-]{1,128}\.md$/;

/** Where a note hangs: nowhere (global, shown as Unfiled on the hub), a group (lens), an idea, a task or an agent. */
export type NoteAnchor = { kind: "global" } | { kind: "group" | "mission" | "task" | "session"; id: string };

/** A note's scope as an anchor, or null when the scope is not one a note can have. */
export function parseNoteScope(scope: string): NoteAnchor | null {
  if (scope === "global") return { kind: "global" };
  const m = /^(group|mission|task|session):(.+)$/.exec(scope);
  if (!m) return null;
  const kind = m[1] as "group" | "mission" | "task" | "session";
  if (!(kind === "session" ? SESSION_KEY_RE : TASK_ID_RE).test(m[2])) return null;
  return { kind, id: m[2] };
}
export const SCOPE_HELP = "Use global, group:<group>, mission:<idea>, task:<task id> or session:<session key>.";

export type ScopeInput = { scope?: unknown; group?: unknown; mission?: unknown; idea?: unknown; task?: unknown; session?: unknown; global?: unknown };

/**
 * The one scope a note gets from `scope`, or from exactly one of `group`, `mission`/`idea`, `task`, `session`
 * or `global`. Nothing given means `fallback`. Throws a readable error for anything else.
 */
export function noteScope(o: ScopeInput, fallback = "global"): string {
  const given: string[] = [];
  if (o.scope != null && o.scope !== "") given.push(String(o.scope));
  if (o.group != null && o.group !== "") given.push(`group:${o.group}`);
  const idea = o.idea ?? o.mission;
  if (idea != null && idea !== "") given.push(`mission:${idea}`);
  if (o.task != null && o.task !== "") given.push(`task:${o.task}`);
  if (o.session != null && o.session !== "") given.push(`session:${o.session}`);
  if (o.global === true || o.global === "1" || o.global === "true") given.push("global");
  if (given.length > 1) throw new Error(`A note hangs off one place, but this names ${given.join(" and ")}. Pick one.`);
  const scope = given[0] ?? fallback;
  if (!parseNoteScope(scope)) throw new Error(`"${scope}" is not a place a note can go. ${SCOPE_HELP}`);
  return scope;
}

/** Bullets from a list or a block of text: one per non-empty line, list markers dropped. */
export function toBullets(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map((x) => String(x ?? "")) : input == null ? [] : [String(input)];
  return parts.flatMap((p) => p.split(/\r?\n/))
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
export const bulletsBody = (bullets: string[]) => bullets.map((b) => `- ${b}`).join("\n");
export const bulletsOf = (body: string) => toBullets(body);

/** A list is a note whose every bullet is a checkbox: "[ ] milk", "[x] eggs" (markdown task items to agents). */
export const LIST_ITEM_RE = /^\[([ xX])\]\s+/;
export const isListBullets = (bullets: string[]) => bullets.length > 0 && bullets.every((b) => LIST_ITEM_RE.test(b));
export const listItem = (text: string, done = false) => `[${done ? "x" : " "}] ${text.replace(/\s+/g, " ").trim()}`;
export function parseListItem(b: string): { done: boolean; text: string } {
  const m = LIST_ITEM_RE.exec(b);
  return m ? { done: m[1] !== " ", text: b.slice(m[0].length) } : { done: false, text: b };
}
/** A list saved without a name of its own. */
export const LIST_TITLE = "List";

const TITLE_MAX = 80;
export function noteTitle(bullets: string[]): string {
  const t = bullets[0] ?? "Note";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + "…" : t;
}

export const NOTES_DIGEST_MAX_LINES = 40;
export const NOTES_DIGEST_MAX_CHARS = 4000;
const BULLET_MAX = 320;

type DigestNote = { id: string; bullets: string[] };
/**
 * What a crewmate on `task` reads at session start: its task's notes, then its idea's, newest first.
 * Empty when neither has a note. ≤40 lines and ≤4000 chars; the header says when some did not fit.
 */
export function buildTaskNotesDigest(o: { task: string; mission: { id: string; title?: string } | null; taskNotes: DigestNote[]; ideaNotes: DigestNote[] }): { text: string; ids: string[] } {
  const total = o.taskNotes.length + o.ideaNotes.length;
  if (!total) return { text: "", ids: [] };
  const clip = (b: string) => (b.length > BULLET_MAX ? b.slice(0, BULLET_MAX - 1) + "…" : b);
  const header = (shown: number) =>
    `Joyride notes from the captain for task ${o.task}${o.mission ? ` and its idea ${o.mission.title ? `"${o.mission.title}" (${o.mission.id})` : o.mission.id}` : ""}: ${shown}${shown < total ? ` of ${total}` : ""} ${total === 1 ? "note" : "notes"}; ${shown < total ? "the rest" : "edit or add"} via \`joyride notes --task ${o.task}\``;
  let budget = NOTES_DIGEST_MAX_CHARS - header(0).length - 8;
  const lines: string[] = [];
  const ids: string[] = [];
  const section = (label: string, notes: DigestNote[]) => {
    let opened = false;
    for (const n of notes) {
      const ls = n.bullets.map((b) => `- ${clip(b)}`);
      const cost = ls.reduce((s, l) => s + l.length + 1, 0) + (opened ? 0 : label.length + 1);
      if (lines.length + ls.length + (opened ? 0 : 1) > NOTES_DIGEST_MAX_LINES - 1 || cost > budget) continue;
      if (!opened) { lines.push(label); opened = true; }
      lines.push(...ls); ids.push(n.id); budget -= cost;
    }
  };
  section(`Task ${o.task}:`, o.taskNotes);
  if (o.mission) section(`Idea ${o.mission.id}:`, o.ideaNotes);
  return { text: [header(ids.length), ...lines].join("\n") + "\n", ids };
}
