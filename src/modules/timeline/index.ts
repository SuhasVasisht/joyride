// Task timeline (control plane CP3b): one ordered list per Firstmate task merging its
// brief, status log, steers in its inbox, the captain's notes on it, its open asks and
// its report. The task sheet (#/task/<id>) renders it; read-only, nothing is written.
//   service `timeline`: forTask(id), brief(id)
//   routes: GET /api/timeline/task/:id, GET /api/timeline/task/:id/brief
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import type { FirstmateApi } from "../firstmate/index.ts";
import { parseStatusLog, type TaskDetail } from "../firstmate/state.ts";
import type { AsksApi } from "../asks/index.ts";
import type { NotesService } from "../notes/index.ts";
import { buildTimeline, type InboxMessage, type TimelineEvent } from "./build.ts";

export type TaskTimeline = { task: string; events: TimelineEvent[]; errors: string[] };
export type TimelineService = { forTask(id: string): TaskTimeline | null; brief(id: string): { path: string; text: string } | null };

const TASK_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_INBOX = 100;

const mtimeIso = (f: string | null | undefined) => {
  if (!f) return null;
  try { return fs.statSync(f).mtime.toISOString(); } catch { return null; }
};

function readInbox(dir: string, handled: boolean): InboxMessage[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".msg")); } catch { return []; }
  return names.sort().slice(-MAX_INBOX).map((name) => {
    const f = path.join(dir, name);
    let text = "";
    try { text = fs.readFileSync(f, "utf8").slice(0, 4000); } catch {}
    return { name, text, at: mtimeIso(f), handled };
  });
}

function createService(ctx: Ctx): TimelineService {
  const svc = <T,>(name: string) => ctx.services.get(name) as T | undefined;
  return {
    brief(id) {
      if (!TASK_RE.test(id) || id.startsWith(".")) return null;
      const file = svc<FirstmateApi>("firstmate")?.home().tasks.find((t) => t.id === id)?.brief;
      if (!file) return null;
      try { return { path: file, text: fs.readFileSync(file, "utf8").slice(0, 200_000) }; } catch { return null; }
    },
    forTask(id) {
      if (!TASK_RE.test(id) || id.startsWith(".")) return null;
      const fm = svc<FirstmateApi>("firstmate");
      if (!fm) return null;
      const home = fm.home();
      const task = home.tasks.find((t) => t.id === id) as TaskDetail | undefined;
      if (!task) return null;
      const errors: string[] = [];
      const state = path.join(home.home, "state");
      let statusText = "";
      try { statusText = fs.readFileSync(path.join(state, `${id}.status`), "utf8"); } catch { /* no status yet */ }
      const inboxDir = path.join(state, `${id}.inbox`);
      const inbox = [...readInbox(path.join(inboxDir, "handled"), true), ...readInbox(inboxDir, false)];
      let notes: { id: string; created: string | null; bullets: string[]; title: string }[] = [];
      try {
        const n = svc<NotesService>("notes")?.forTask(id);
        notes = (n?.task_notes ?? []).map((x) => ({ id: x.id, created: x.created ?? null, bullets: x.bullets, title: x.title }));
      } catch (e: any) { errors.push(`Notes could not be read: ${e.message}`); }
      let asks: { id: string; title: string; question: string; opened: string | null; needs_you: boolean; state: string }[] = [];
      try {
        asks = (svc<AsksApi>("asks")?.list({ task: id }) ?? []).map((a) => ({ id: a.id, title: a.title, question: a.question, opened: a.opened, needs_you: a.needs_you, state: a.state }));
      } catch (e: any) { errors.push(`Asks could not be read: ${e.message}`); }
      const events = buildTimeline({
        task: id,
        brief: task.brief ? { at: mtimeIso(task.brief) } : null,
        status: parseStatusLog(statusText),
        open_keys: task.decisions.map((d) => d.key),
        inbox,
        notes,
        asks,
        report: task.report ? { at: mtimeIso(task.report) } : null,
      });
      return { task: id, events, errors };
    },
  };
}

export default defineModule({
  name: "timeline",
  order: 80, // after firstmate, notes and asks
  register(ctx: Ctx) {
    const svc = createService(ctx);
    ctx.services.set("timeline", svc);
    ctx.app.get("/api/timeline/task/:id", (c) => {
      const id = c.req.param("id");
      const t = svc.forTask(id);
      return t ? c.json(t) : c.json({ error: `Firstmate has no task ${id}.` }, 404);
    });
    ctx.app.get("/api/timeline/task/:id/brief", (c) => {
      const b = svc.brief(c.req.param("id"));
      return b ? c.json(b) : c.json({ error: `Task ${c.req.param("id")} has no brief Joyride can read.` }, 404);
    });
  },
});
