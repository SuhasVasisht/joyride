// `joyride notes`: read and write the captain's notes from a terminal, for the captain,
// Firstmate and crewmates alike. Talks to the daemon (/api/notes); when the daemon is
// down, listing still works from the authored files and the task digests.
import fs from "node:fs";
import path from "node:path";
import { paths, DAEMON_URL } from "../shared/paths.ts";
import { loadNoteFiles } from "../shared/note-files.ts";
import { bulletsOf, noteScope, taskDigestFile } from "../shared/notes.ts";
import { jobRequest } from "../shared/new-client.ts";

export const NOTES_USAGE = `joyride notes [where] [--all] [--json] [-q <words>]
  list notes. where is one of:
    --task <id>         a Firstmate task's notes and its idea's (the default when FM_TASK_ID is set)
    --group <id>        a group's board items (notes, lists and links on the map)
    --idea <slug>       an idea's notes (--mission works too)
    --session <key>     an agent's notes, by session key (claude:<id> or codex:<id>)
    --global            notes that hang off nothing in particular (Unfiled, on the map's hub)
  with no where (and no FM_TASK_ID), every note
joyride notes add [where] [--title <t>] <bullet>... | -
  save a note: each argument (or each stdin line, with -) is one bullet. where defaults to
  FM_TASK_ID's task, else global
joyride notes edit <id> [--title <t>] [where] [<bullet>... | -]   replace a note's bullets, title or place
joyride notes archive <id> | restore <id>`;

export type NotesArgs = {
  cmd: "list" | "add" | "edit" | "archive" | "restore" | "help";
  id: string | null;
  where: { task?: string; group?: string; mission?: string; session?: string; global?: boolean };
  bullets: string[];
  stdin: boolean;
  title: string | null;
  all: boolean;
  json: boolean;
  q: string | null;
};

export function parseNotesArgs(argv: string[]): NotesArgs {
  const a: NotesArgs = { cmd: "list", id: null, where: {}, bullets: [], stdin: false, title: null, all: false, json: false, q: null };
  const rest = [...argv];
  if (["add", "edit", "archive", "restore", "list", "help"].includes(rest[0] ?? "")) a.cmd = rest.shift() as NotesArgs["cmd"];
  if (rest[0] === "--help" || rest[0] === "-h") { a.cmd = "help"; return a; }
  if (a.cmd === "edit" || a.cmd === "archive" || a.cmd === "restore") {
    const id = rest.shift();
    if (!id || id.startsWith("-")) throw new Error(`joyride notes ${a.cmd} needs a note id, for example note-save-first-1a2b3c.`);
    a.id = id;
  }
  const value = (flag: string) => {
    const v = rest.shift();
    if (v === undefined || v === "") throw new Error(`${flag} needs a value.`);
    return v;
  };
  while (rest.length) {
    const t = rest.shift()!;
    switch (t) {
      case "--task": a.where.task = value(t); break;
      case "--group": a.where.group = value(t); break;
      case "--idea": case "--mission": a.where.mission = value(t); break;
      case "--session": a.where.session = value(t); break;
      case "--global": a.where.global = true; break;
      case "--title": a.title = value(t); break;
      case "--all": a.all = true; break;
      case "--json": a.json = true; break;
      case "-q": case "--query": a.q = value(t); break;
      case "-": a.stdin = true; break;
      case "--": a.bullets.push(...rest.splice(0)); break;
      default:
        if (t.startsWith("--")) throw new Error(`Unknown option ${t}.\n\n${NOTES_USAGE}`);
        a.bullets.push(t);
    }
  }
  if (a.cmd === "list" && a.bullets.length) throw new Error(`To save a note, use joyride notes add "<bullet>".`);
  if (Object.keys(a.where).length > 1) throw new Error("Name one place: --task, --group, --idea, --session or --global.");
  return a;
}

type Note = { id: string; scope: string; title: string; status: string; created: string; bullets?: string[]; body?: string };

/** A note as terminal lines: its place, id and day, then its bullets. */
export function formatNote(n: Note): string {
  const bullets = n.bullets ?? bulletsOf(n.body ?? "");
  return [`${n.scope} · ${n.id} · ${n.created.slice(0, 10)}${n.status !== "active" ? ` · ${n.status}` : ""}`, ...bullets.map((b) => `  - ${b}`)].join("\n");
}
export function formatNotes(notes: Note[], empty: string): string {
  return notes.length ? notes.map(formatNote).join("\n\n") : empty;
}
export function formatTaskNotes(t: { task: string; mission: { id: string; title: string } | null; task_notes: Note[]; idea_notes: Note[] }): string {
  const out = [`Task ${t.task}`, formatNotes(t.task_notes, "  no notes on this task yet")];
  out.push("", t.mission ? `Idea ${t.mission.id} (${t.mission.title})` : "Idea: this task is not filed under an idea yet");
  if (t.mission) out.push(formatNotes(t.idea_notes, "  no notes on this idea yet"));
  return out.join("\n");
}

type Res = { status: number; body: any };
async function call(method: string, p: string, body?: unknown): Promise<Res> {
  const owned = jobRequest(method, p, body);
  method = owned.method; p = owned.path; body = owned.body;
  const r = await fetch(DAEMON_URL + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const t = await r.text();
  let b: any = t;
  try { b = t ? JSON.parse(t) : null; } catch { /* plain text */ }
  return { status: r.status, body: b };
}
const unreachable = (what: string) => `The Joyride daemon is not reachable at ${DAEMON_URL}, so ${what}. Start it with \`./bin/joyride up\`, then try again.`;
function check(r: Res): any {
  if (r.status >= 400) throw new Error(r.body?.error ?? `The daemon answered ${r.status}.`);
  return r.body;
}

/** Listing without the daemon: notes straight from notes/, and a task's digest file for its idea. */
function offlineList(a: NotesArgs, task: string | undefined): string {
  const notes = loadNoteFiles(paths.notes).notes
    .filter((e) => e.kind === "note" && (a.all || e.status === "active"))
    .sort((x, y) => y.created.localeCompare(x.created));
  const note = `(${unreachable("this list comes straight from the files")})`;
  if (task) {
    const file = taskDigestFile(task);
    const digest = file ? (() => { try { return fs.readFileSync(path.join(paths.taskNotes, file), "utf8").trim(); } catch { return ""; } })() : "";
    if (digest) return `${digest}\n\n${note}`;
    return `${formatNotes(notes.filter((e) => e.scope === `task:${task}`), `No notes on task ${task}.`)}\n\n${note}`;
  }
  const scope = Object.keys(a.where).length ? noteScope(a.where) : null;
  return `${formatNotes(notes.filter((e) => !scope || e.scope === scope), "No notes yet.")}\n\n${note}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs one `joyride notes` command; returns what to print. Throws a readable error. */
export async function runNotes(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const a = parseNotesArgs(argv);
  if (a.cmd === "help") return NOTES_USAGE;
  const fmTask = env.FM_TASK_ID && !Object.keys(a.where).length ? env.FM_TASK_ID : undefined;
  const bullets = a.stdin ? [...a.bullets, await readStdin()] : a.bullets;

  if (a.cmd === "list") {
    const task = a.where.task ?? fmTask;
    try {
      if (task && !a.q) {
        const t = check(await call("GET", `/api/notes/task/${encodeURIComponent(task)}`));
        return a.json ? JSON.stringify(t, null, 2) : formatTaskNotes(t);
      }
      const qs = new URLSearchParams();
      if (task) qs.set("task", task);
      if (a.where.group) qs.set("group", a.where.group);
      if (a.where.mission) qs.set("mission", a.where.mission);
      if (a.where.session) qs.set("session", a.where.session);
      if (a.where.global) qs.set("global", "1");
      if (a.all) qs.set("include_archived", "1");
      if (a.q) qs.set("q", a.q);
      const list = check(await call("GET", `/api/notes${qs.size ? `?${qs}` : ""}`));
      return a.json ? JSON.stringify(list, null, 2) : formatNotes(list, "No notes yet.");
    } catch (e: any) {
      if (e?.name === "TypeError" || e?.name === "TimeoutError") return offlineList(a, task);
      throw e;
    }
  }

  const write = async (method: string, p: string, body?: unknown) => {
    try { return check(await call(method, p, body)); }
    catch (e: any) { if (e?.name === "TypeError" || e?.name === "TimeoutError") throw new Error(unreachable("nothing was saved")); throw e; }
  };
  const done = (n: Note, verb: string) => (a.json ? JSON.stringify(n, null, 2) : `${verb} ${n.id}\n${formatNote(n)}`);
  const by = env.FM_TASK_ID ? { type: "agent", ref: `task:${env.FM_TASK_ID}` } : { type: "human", ref: "cli" };

  switch (a.cmd) {
    case "add": {
      const where = fmTask ? { task: fmTask } : a.where;
      return done(await write("POST", "/api/notes", { ...where, bullets, ...(a.title ? { title: a.title } : {}), provenance: by }), "Saved");
    }
    case "edit": {
      const patch: Record<string, unknown> = { ...a.where };
      if (bullets.length) patch.bullets = bullets;
      if (a.title) patch.title = a.title;
      return done(await write("PUT", `/api/notes/${encodeURIComponent(a.id!)}`, patch), "Edited");
    }
    case "archive": return done(await write("POST", `/api/notes/${encodeURIComponent(a.id!)}/archive`), "Archived");
    case "restore": return done(await write("POST", `/api/notes/${encodeURIComponent(a.id!)}/restore`), "Restored");
  }
  return NOTES_USAGE;
}
