// Notes (control plane CP4a): the captain's quick bullets, saved against a group
// (scope group:<lens>), an idea (mission:<slug>), a task (task:<id>), an agent
// (session:<key>) or nothing (global, Unfiled on the hub). On the map they are board
// items: notes, checklists, links and mixed cards (shared/board.ts). Notes are
// authored markdown files in notes/, committed through commitPaths(). The API,
// CLI and task-note delivery keep their existing shape.
//   service `notes`: list(filter), get(id), create(input), edit(id, patch), archive(id), restore(id),
//                    forTask(id), forMission(id), rebuildTaskDigests()
//   routes: GET/POST /api/notes, GET /api/notes/task/:id, GET/PUT /api/notes/:id, POST /api/notes/:id/{archive, restore}
//           POST /api/notes/:id/tell (intent tell_note: "save and tell Firstmate" files a captain inbox note about it)
//   bus entity: notes
import fs from "node:fs";
import { z } from "zod";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { MapActor } from "../../shared/map-actions.ts";
import type { Mission } from "../../shared/schema.ts";
import {
  LIST_TITLE, TASK_DIGEST_RE, TASK_ID_RE, buildTaskNotesDigest, bulletsBody, bulletsOf, noteScope, noteTitle, parseNoteScope,
  taskDigestFile, toBullets, type NoteAnchor, type ScopeInput,
} from "../../shared/notes.ts";
import { commitPaths } from "../../core/gitstore.ts";
import { loadNoteFiles, readNoteFile, writeNoteFile, newNoteId, noteEntry, NoteFile } from "../../shared/note-files.ts";
import { itemKind, itemLabel } from "../../shared/board.ts";

/** A title made from the lines: a link's readable title, a note's first line; a list is just "List" until named. */
const autoTitle = (bullets: string[]) => (itemKind(bullets) === "list" ? LIST_TITLE : itemLabel({ bullets }, 80));
import { tellText } from "./tell.ts";

export type NoteView = ReturnType<typeof noteEntry> & { used_in: { count: number; last: string | null; digests: string[] } } & { anchor: NoteAnchor; bullets: string[] };
export type NoteFilter = { group?: string; mission?: string; task?: string; session?: string; global?: boolean; q?: string; include_archived?: boolean; limit?: number };
export type NoteInput = ScopeInput & { actor?: unknown; bullets?: unknown; body?: unknown; text?: unknown; title?: unknown; tags?: unknown; provenance?: { type?: unknown; ref?: unknown } };
export type TaskNotes = { task: string; mission: { id: string; title: string } | null; task_notes: NoteView[]; idea_notes: NoteView[]; digest: string; file: string | null };
export type NotesService = {
  list(f?: NoteFilter): NoteView[];
  get(id: string): NoteView | null;
  create(input: NoteInput): NoteView;
  edit(id: string, patch: NoteInput): NoteView;
  archive(id: string, actor?: unknown): NoteView;
  restore(id: string, actor?: unknown): NoteView;
  /** A task's own notes and its idea's, plus the digest its crewmate gets at session start. */
  forTask(id: string): TaskNotes;
  forTasks(ids: string[]): TaskNotes[];
  /** An idea's active notes, newest first. */
  forMission(id: string): NoteView[];
  rebuildTaskDigests(): { files: string[] };
};

class NoteError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function createService(ctx: Ctx): NotesService {
  const usage = (id: string): NoteView["used_in"] => {
    // Task-note usage is projected independently of the memory module.
    try {
      const rows = ctx.db.prepare("SELECT count, last, digest FROM note_usage WHERE entry = ?").all(id);
      const parsed = z.array(z.object({ count: z.number(), last: z.string().nullable(), digest: z.string() })).parse(rows);
      return { count: parsed.reduce((n, r) => n + r.count, 0), last: parsed.map(r => r.last).filter((s): s is string => s !== null).sort().at(-1) ?? null, digests: parsed.map(r => r.digest) };
    } catch { return { count: 0, last: null, digests: [] }; }
  };
  const save = (n: z.input<typeof NoteFile>, message: string) => {
    const validated = NoteFile.parse(n);
    const file = writeNoteFile(paths.notes, validated);
    commitPaths([file], message);
    return validated;
  };
  const missions = () => ctx.services.get("missions") as { get(id: string): Mission | null; list(o?: object): Mission[]; missionOfTask(task: string): string | null } | undefined;
  const firstmate = () => ctx.services.get("firstmate") as { crewKeys(): { task: string; mission: string | null }[] } | undefined;

  const toView = (e: NoteFile): NoteView => ({ ...noteEntry(e), used_in: usage(e.id), anchor: parseNoteScope(e.scope) ?? { kind: "global" }, bullets: bulletsOf(e.body) });
  const newestFirst = (a: NoteView, b: NoteView) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id);

  function all(includeArchived = false): NoteView[] {
    return loadNoteFiles(paths.notes).notes
      .filter((e) => includeArchived || e.status === "active")
      .map(toView);
  }

  function list(f: NoteFilter = {}): NoteView[] {
    const scopes = new Set<string>();
    if (f.group) scopes.add(`group:${f.group}`);
    if (f.mission) scopes.add(`mission:${f.mission}`);
    if (f.task) scopes.add(`task:${f.task}`);
    if (f.session) scopes.add(`session:${f.session}`);
    if (f.global) scopes.add("global");
    const words = f.q?.trim().toLowerCase().split(/\s+/) ?? [];
    return all(f.include_archived).sort(newestFirst)
      .filter(n => (!scopes.size || scopes.has(n.scope)) && words.every(w => `${n.title} ${n.body}`.toLowerCase().includes(w)))
      .slice(0, f.limit ?? 500);
  }

  function mustNote(id: string): NoteFile {
    const e = readNoteFile(paths.notes, id);
    if (!e) throw new NoteError(`There is no note ${id}.`, 404);
    return e;
  }

  const lenses = () => ctx.services.get("lenses") as { list(): { id: string; title: string }[] } | undefined;
  function checkScope(scope: string) {
    const a = parseNoteScope(scope);
    if (a?.kind === "group") {
      const l = lenses();
      if (l && !l.list().some((x) => x.id === a.id)) throw new NoteError(`There is no group "${a.id}". Pick a group from map show, or save the note in Unfiled (global).`);
      return;
    }
    if (a?.kind !== "mission") return;
    const m = missions();
    if (m && !m.get(a.id)) throw new NoteError(`There is no idea "${a.id}". Pick an existing idea, or save the note on its task or globally.`);
  }

  function bulletsFrom(input: NoteInput): string[] | null {
    const raw = input.bullets ?? input.body ?? input.text;
    return raw === undefined ? null : toBullets(raw);
  }

  function actorOf(value: unknown) {
    if (value === undefined) return null;
    const actor = MapActor.safeParse(value);
    if (!actor.success) throw new NoteError("Send a valid agent actor {kind: agent, id, via: cli or mcp}.");
    return actor.data;
  }
  const attributed = (message: string, actor: MapActor | null) => actor ? `${message}\n\nMap-actor: ${JSON.stringify(actor)}` : message;

  function provenanceOf(p: NoteInput["provenance"]) {
    const type = typeof p?.type === "string" && p.type.trim() ? p.type.trim() : "human";
    return { type, ref: typeof p?.ref === "string" ? p.ref : "api" };
  }

  function changed(id: string) {
    safeRebuild();
    ctx.bus.change({ entity: "notes", id });
  }

  function create(input: NoteInput): NoteView {
    const actor = actorOf(input.actor);
    const bullets = bulletsFrom(input ?? {}) ?? [];
    if (!bullets.length) throw new NoteError("A note needs at least one bullet. Type what you want to remember, then save it again.");
    let scope: string;
    try { scope = noteScope(input); } catch (e: any) { throw new NoteError(e.message); }
    checkScope(scope);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : autoTitle(bullets);
    const created = new Date().toISOString();
    const e = save({ id: newNoteId(title), kind: "note", title, body: bulletsBody(bullets), scope,
      status: "active", created, updated: created, tags: z.array(z.string()).parse(input.tags ?? []),
      provenance: actor ? { type: "agent", ref: `${actor.via}:${actor.id}` } : provenanceOf(input.provenance) }, attributed(`notes: add a note to ${scope}`, actor));
    changed(e.id);
    return toView(e);
  }

  function edit(id: string, patch: NoteInput): NoteView {
    const actor = actorOf(patch.actor);
    const cur = mustNote(id);
    const next: Partial<NoteFile> & { id: string } = { id };
    const bullets = bulletsFrom(patch ?? {});
    if (bullets) {
      if (!bullets.length) throw new NoteError("A note needs at least one bullet. To remove it, archive it instead.");
      next.body = bulletsBody(bullets);
      // A title that followed the lines keeps following them (a list keeps its name).
      const was = bulletsOf(cur.body);
      if (cur.title === noteTitle(was) || (cur.title === autoTitle(was) && cur.title !== LIST_TITLE)) next.title = autoTitle(bullets);
    }
    if (typeof patch?.title === "string" && patch.title.trim()) next.title = patch.title.trim();
    const { scope: s, group, mission, idea, task, session, global } = patch ?? {};
    if ([s, group, mission, idea, task, session, global].some((x) => x != null && x !== "")) {
      try { next.scope = noteScope({ scope: s, group, mission, idea, task, session, global }); } catch (e: any) { throw new NoteError(e.message); }
      checkScope(next.scope);
    }
    if (Object.keys(next).length === 1) throw new NoteError("Send the note's new bullets, title or place.");
    // A note the captain edits is theirs again as of now: the board sorts and dates it by this.
    next.updated = new Date().toISOString();
    const e = save({ ...cur, ...next }, attributed(`notes: edit ${id}${next.scope && next.scope !== cur.scope ? ` (moved to ${next.scope})` : ""}`, actor));
    changed(id);
    return toView(e);
  }

  function setStatus(id: string, status: "archived" | "active", verb: string, actorInput?: unknown): NoteView {
    const actor = actorOf(actorInput);
    const cur = mustNote(id);
    if (cur.status === status) return toView(cur);
    const e = save({ ...cur, status }, attributed(`notes: ${verb} ${id}`, actor));
    changed(id);
    return toView(e);
  }

  /** The task's idea: what Firstmate's projection says, else the idea whose authored `crews` lists it. */
  function missionOfTask(task: string): string | null {
    try { const k = firstmate()?.crewKeys().find((x) => x.task === task); if (k?.mission) return k.mission; } catch { /* firstmate absent */ }
    try { return missions()?.missionOfTask(task) ?? null; } catch { return null; }
  }
  function missionRef(id: string | null): { id: string; title: string } | null {
    if (!id) return null;
    let title = id;
    try { title = missions()?.get(id)?.title ?? id; } catch { /* missions absent */ }
    return { id, title };
  }

  function plan(task: string, notes: NoteView[]) {
    const mission = missionRef(missionOfTask(task));
    const admission = knowledgePolicy(ctx);
    notes = notes.filter(n => n.scope === `task:${task}` || (mission && n.scope === `mission:${mission.id}`))
      .filter(n => admission.note(n));
    const task_notes = notes.filter((n) => n.scope === `task:${task}`).sort(newestFirst);
    const idea_notes = mission ? notes.filter((n) => n.scope === `mission:${mission.id}`).sort(newestFirst) : [];
    const d = buildTaskNotesDigest({ task, mission, taskNotes: task_notes, ideaNotes: idea_notes });
    return { mission, task_notes, idea_notes, ...d };
  }

  function forTask(task: string): TaskNotes {
    if (!TASK_ID_RE.test(task)) throw new NoteError(`"${task}" is not a Firstmate task id.`);
    const p = plan(task, all());
    return { task, mission: p.mission, task_notes: p.task_notes, idea_notes: p.idea_notes, digest: p.text, file: p.text ? taskDigestFile(task) : null };
  }

  /** One digest per task that has notes of its own or on its idea; stale task digests are removed. */
  function rebuildTaskDigests(): { files: string[] } {
    const notes = all();
    const tasks = new Set<string>();
    for (const n of notes) if (n.anchor.kind === "task") tasks.add(n.anchor.id);
    const ideas = new Set(notes.filter((n) => n.anchor.kind === "mission").map((n) => n.scope.slice("mission:".length)));
    if (ideas.size) {
      try { for (const k of firstmate()?.crewKeys() ?? []) if (k.mission && ideas.has(k.mission)) tasks.add(k.task); } catch { /* firstmate absent */ }
      try { for (const m of missions()?.list({}) ?? []) if (ideas.has(m.id)) for (const t of m.crews ?? []) tasks.add(t); } catch { /* missions absent */ }
    }
    const dir = paths.taskNotes;
    fs.mkdirSync(dir, { recursive: true });
    const built = new Date().toISOString();
    const upsert = ctx.db.prepare("INSERT INTO note_digest_map(file, repo, entries, built) VALUES (?,?,?,?) ON CONFLICT(file) DO UPDATE SET repo=excluded.repo, entries=excluded.entries, built=excluded.built");
    const files: string[] = [];
    for (const task of [...tasks].sort()) {
      const file = taskDigestFile(task);
      if (!file) continue;
      const d = plan(task, notes);
      if (!d.text) continue;
      const p = path.join(dir, file);
      let same = false;
      try { same = fs.readFileSync(p, "utf8") === d.text; } catch { /* new */ }
      if (!same) { fs.writeFileSync(`${p}.tmp`, d.text); fs.renameSync(`${p}.tmp`, p); }
      upsert.run(file, null, JSON.stringify(d.ids), built);
      files.push(file);
    }
    const keep = new Set(files);
    for (const n of fs.readdirSync(dir)) {
      if (!TASK_DIGEST_RE.test(n) || keep.has(n)) continue;
      fs.rmSync(path.join(dir, n), { force: true });
      ctx.db.prepare("DELETE FROM note_digest_map WHERE file = ?").run(n);
    }
    return { files };
  }
  function safeRebuild() {
    try { rebuildTaskDigests(); } catch (e: any) { ctx.log(`notes: task digest rebuild failed: ${e.message}`); }
  }

  return {
    list,
    get(id) { const e = readNoteFile(paths.notes, id); return e ? toView(e) : null; },
    create, edit,
    archive: (id, actor) => setStatus(id, "archived", "archive", actor),
    restore: (id, actor) => setStatus(id, "active", "restore", actor),
    forTask,
    forTasks(tasks) {
      const notes = all();
      return tasks.map((task) => {
        if (!TASK_ID_RE.test(task)) throw new NoteError(`"${task}" is not a Firstmate task id.`);
        const p = plan(task, notes);
        return { task, mission: p.mission, task_notes: p.task_notes, idea_notes: p.idea_notes, digest: p.text, file: p.text ? taskDigestFile(task) : null };
      });
    },
    forMission: (id) => list({ mission: id }),
    rebuildTaskDigests,
  };
}

let offChange: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;
let offEvent: (() => void) | null = null;
let fileTimer: NodeJS.Timeout | null = null;

export default defineModule({
  name: "notes",
  order: 65, // after missions and firstmate
  migrations: {
    "001": `CREATE TABLE note_usage (entry TEXT NOT NULL, digest TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last TEXT, PRIMARY KEY (entry, digest));
            CREATE TABLE note_digest_map (file TEXT PRIMARY KEY, repo TEXT, entries TEXT NOT NULL, built TEXT NOT NULL);`,
  },
  register(ctx: Ctx) {
    const { app } = ctx;
    const svc = createService(ctx);
    ctx.services.set("notes", svc);
    offEvent = ctx.bus.onEvent(e => {
      const file = e.data?.injected_notes;
      if (e.type !== "session.start" || !e.source.startsWith("hook.") || typeof file !== "string" || !TASK_DIGEST_RE.test(file)) return;
      const row = ctx.db.prepare("SELECT entries FROM note_digest_map WHERE file = ?").get(file);
      const parsed = z.object({ entries: z.string() }).safeParse(row);
      if (!parsed.success) return;
      const ids = z.array(z.string()).parse(JSON.parse(parsed.data.entries));
      const upsert = ctx.db.prepare("INSERT INTO note_usage(entry, digest, count, last) VALUES (?,?,1,?) ON CONFLICT(entry, digest) DO UPDATE SET count=count+1, last=excluded.last");
      ctx.db.transaction(() => { for (const id of ids) upsert.run(id, file, e.ts); })();
      ctx.emit({ source: "notes", type: "notes.injected", session: e.session, agent: e.agent, cwd: e.cwd, data: { file, entries: ids } });
    });

    const fail = (c: any, e: any) => c.json({ error: e.message ?? String(e) }, e instanceof NoteError ? e.status : 400);
    const json = async (c: any) => { try { return (await c.req.json()) ?? {}; } catch { return {}; } };
    const flag = (v: string | undefined) => v === "1" || v === "true";

    app.get("/api/notes", (c) => {
      try {
        return c.json(svc.list({
          group: c.req.query("group") || undefined, mission: c.req.query("mission") || c.req.query("idea") || undefined, task: c.req.query("task") || undefined,
          session: c.req.query("session") || undefined, global: flag(c.req.query("global")), q: c.req.query("q") || undefined,
          include_archived: flag(c.req.query("include_archived")), limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
        }));
      } catch (e) { return fail(c, e); }
    });
    app.post("/api/notes", async (c) => { try { return c.json(svc.create(await json(c)), 201); } catch (e) { return fail(c, e); } });
    app.get("/api/notes/task/:id", (c) => { try { return c.json(svc.forTask(c.req.param("id"))); } catch (e) { return fail(c, e); } });
    app.get("/api/notes/:id", (c) => {
      const n = svc.get(c.req.param("id"));
      return n ? c.json(n) : c.json({ error: `There is no note ${c.req.param("id")}.` }, 404);
    });
    app.put("/api/notes/:id", async (c) => { try { return c.json(svc.edit(c.req.param("id"), await json(c))); } catch (e) { return fail(c, e); } });
    app.post("/api/notes/:id/archive", async (c) => { try { return c.json(svc.archive(c.req.param("id"), (await json(c)).actor)); } catch (e) { return fail(c, e); } });
    app.post("/api/notes/:id/restore", async (c) => { try { return c.json(svc.restore(c.req.param("id"), (await json(c)).actor)); } catch (e) { return fail(c, e); } });

    // "Save and tell Firstmate": an intent (so it shows in the log and a retry replays) that files a
    // captain inbox note through the firstmate service. It works while Firstmate is stopped: the note
    // waits in its inbox for the next drain.
    type Intents = { create(kind: string, target: string, payload?: Record<string, unknown>): Promise<{ status: string }>; registerHandler(kind: string, fn: (it: any) => unknown): void };
    const intents = () => ctx.services.get("intents") as Intents | undefined;
    intents()?.registerHandler("tell_note", async (it: any) => {
      const n = svc.get(String(it.target ?? ""));
      if (!n) throw new NoteError(`There is no note ${it.target}, so there is nothing to tell Firstmate about.`, 404);
      const fm = ctx.services.get("firstmate") as { note(requestId: string, body: string): Promise<{ note: string; outcome: string; announced: boolean | null }> } | undefined;
      if (!fm) throw new NoteError("The firstmate module is not running, so the note was saved but Firstmate was not told.", 503);
      let mission: { id: string; title: string } | null = null;
      if (n.anchor.kind === "mission") {
        const m = (ctx.services.get("missions") as { get(id: string): Mission | null } | undefined)?.get(n.anchor.id);
        mission = { id: n.anchor.id, title: m?.title ?? n.anchor.id };
      } else if (n.anchor.kind === "task") {
        try { mission = svc.forTask(n.anchor.id).mission; } catch { /* not a task id */ }
      }
      const r = await fm.note(it.id, tellText({ requestId: it.id, note: n, mission }));
      return { note: n.id, inbox_note: r.note, outcome: r.outcome, announced: r.announced, ...(mission ? { mission: mission.id } : {}) };
    });
    app.post("/api/notes/:id/tell", async (c) => {
      const id = c.req.param("id");
      if (!svc.get(id)) return c.json({ error: `There is no note ${id}.` }, 404);
      const r = intents();
      if (!r) return c.json({ error: "The intents service is not running, so Firstmate can't be told. Restart the daemon." }, 503);
      const it = await r.create("tell_note", id, {});
      return c.json(it, it.status === "failed" ? 400 : 200);
    });
  },

  start(ctx: Ctx) {
    const svc = ctx.service<NotesService>("notes");
    fs.mkdirSync(paths.notes, { recursive: true });
    const syncFiles = () => {
      try {
        const { errors } = loadNoteFiles(paths.notes);
        for (const error of errors) ctx.log(`notes: could not read ${error}`);
        commitPaths([paths.notes], "notes: sync authored files");
        svc.rebuildTaskDigests();
        ctx.bus.change({ entity: "notes" });
      } catch (e) { ctx.log(`notes: file sync failed: ${e instanceof Error ? e.message : String(e)}`); }
    };
    syncFiles(); // Also retry any authored write whose commit failed before startup.
    try { watcher = fs.watch(paths.notes, () => {
      if (fileTimer) clearTimeout(fileTimer);
      fileTimer = setTimeout(syncFiles, 500);
      fileTimer.unref();
    }); } catch (e) { ctx.log(`notes: file watcher unavailable: ${e instanceof Error ? e.message : String(e)}`); }
    // A note edited by hand, a task linked to an idea, or a new crew task all move a task digest.
    offChange = ctx.bus.onChange((ch) => {
      if (ch.entity !== "tasks" && ch.entity !== "missions") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { svc.rebuildTaskDigests(); } catch (e: any) { ctx.log(`notes: task digest rebuild failed: ${e.message}`); } }, 500);
      timer.unref?.();
    });
  },

  stop() {
    offEvent?.();
    offEvent = null;
    watcher?.close();
    watcher = null;
    offChange?.();
    offChange = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (fileTimer) clearTimeout(fileTimer);
    fileTimer = null;
  },
});
