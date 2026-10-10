// Builds the daemon: loads every module under src/modules/*/index.ts,
// wires the event tailer into the bus, exposes REST + SSE, serves the UI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { openDb, migrate, type DB } from "../core/db.ts";
import { Bus } from "../core/bus.ts";
import { appendEvent, EventTailer } from "../core/eventlog.ts";
import { loadConfig } from "../core/config.ts";
import type { Ctx, JoyrideModule } from "../core/context.ts";
import { paths } from "../shared/paths.ts";
import { ensureDir } from "../core/util.ts";
import { UiSnapshot } from "./ui-snapshot.ts";
import { Diagnostics } from "../core/diagnostics.ts";
import { checkRuntimeTools } from "../core/runtime-tools.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadModules(only?: string[]): Promise<JoyrideModule[]> {
  const dir = path.resolve(here, "..", "modules");
  const names = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "index.ts")));
  const mods: JoyrideModule[] = [];
  for (const n of names) {
    if (only && !only.includes(n)) continue;
    const m = (await import(pathToFileURL(path.join(dir, n, "index.ts")).href)).default as JoyrideModule;
    if (m) mods.push(m);
  }
  return mods.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
}

export async function createDaemon(opts: { db?: DB; only?: string[]; quiet?: boolean; watchdogPort?: number } = {}) {
  ensureDir(paths.runtime);
  const config = loadConfig(true);
  const db = opts.db ?? openDb();
  const bus = new Bus();
  const app = new Hono();
  const services = new Map<string, any>();
  const log = (msg: string, extra?: unknown) => {
    if (opts.quiet) return;
    process.stderr.write(`[joyride ${new Date().toISOString().slice(11, 19)}] ${msg}${extra !== undefined ? " " + JSON.stringify(extra) : ""}\n`);
  };
  const diagnostics = new Diagnostics(log);
  const runtimeTools = checkRuntimeTools(process.env, log);
  services.set("diagnostics", diagnostics);
  app.use("*", async (c, next) => {
    const finish = diagnostics.beginRequest(c.req.method, c.req.path);
    try { await next(); } finally { finish(); }
  });
  const ctx: Ctx = {
    db, bus, config, app, log, services, emit: appendEvent,
    service<T>(name: string) {
      const s = services.get(name);
      if (!s) throw new Error(`service ${name} not registered`);
      return s as T;
    },
  };

  // CSRF guard: the daemon listens on localhost, but any website open in the browser could
  // still POST to it. Mutating requests must be JSON (which forces a CORS preflight we never
  // answer) and, when the browser sends an Origin, come from Joyride's own pages.
  const localOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
  app.use("/api/*", async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (origin && !localOrigin.test(origin)) return c.json({ error: "Cross-site request refused." }, 403);
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none" && !(origin && localOrigin.test(origin))) return c.json({ error: "Cross-site request refused." }, 403);
    // Browsers label every simple cross-site body (text/plain, forms); only JSON needs a preflight.
    const ct = c.req.header("content-type");
    if (ct && !/^application\/json\b/i.test(ct)) return c.json({ error: "Send JSON with Content-Type: application/json." }, 415);
    return next();
  });

  app.onError((err, c) => {
    log(`error ${c.req.method} ${c.req.path}: ${err.message}`);
    return c.json({ error: err.message }, 500);
  });
  app.notFound((c) => c.json({ error: "Route not found." }, 404));
  // `build` names the UI bundle on disk now, so an open tab can notice a rebuild (src/ui/lib/build.ts).
  app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, root: paths.root, code: paths.code, modules: moduleNames, build: ui.build, runtime_tools: runtimeTools, ...diagnostics.snapshot() }));

  // Raw event log queries (timelines, debugging). session accepts a key or a raw id.
  app.get("/api/events", (c) => {
    const q = c.req.query();
    const where: string[] = [], args: unknown[] = [];
    const sessions = (q.session ? [q.session] : []).concat(q.mission ? (() => { try { return (ctx.service<any>("missions").get(q.mission)?.sessions ?? []).map((s: any) => s.id); } catch { return []; } })() : []);
    if (q.mission && sessions.length === 0) return c.json([]);
    if (sessions.length) { where.push(`session IN (${sessions.map(() => "?").join(",")})`); args.push(...sessions.map((s: string) => s.replace(/^(claude|codex):/, ""))); }
    if (q.type) { where.push("type LIKE ?"); args.push(q.type.replace(/\*/g, "%")); }
    if (q.source) { where.push("source = ?"); args.push(q.source); }
    if (q.since) { where.push("ts >= ?"); args.push(q.since); }
    const limit = Math.min(Number(q.limit ?? 200), 2000);
    const rows = db.prepare(`SELECT json FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`).all(...args, limit) as any[];
    return c.json(rows.map((r) => JSON.parse(r.json)));
  });

  // SSE: change notifications + live events for the UI.
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      await stream.write("retry: 300\n\n");
      const offC = bus.onChange((ch) => { stream.writeSSE({ event: "change", data: JSON.stringify(ch) }).catch(() => {}); });
      const ping = setInterval(() => stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {}), 15000);
      await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      offC(); clearInterval(ping);
    }),
  );

  const uiDir = process.env.JOYRIDE_UI_DIR ? path.resolve(process.env.JOYRIDE_UI_DIR) : path.resolve(here, "..", "..", "dist", "ui");
  const ui = new UiSnapshot(uiDir);
  await diagnostics.refresh("ui", () => ui.refresh()).catch((error) => log(`UI refresh failed: ${error}`));
  const moduleNames: string[] = [];
  const mods = await loadModules(opts.only);
  moduleNames.push(...mods.map((m) => m.name));
  for (const m of mods) for (const [name, sql] of Object.entries(m.migrations ?? {})) migrate(db, `${m.name}:${name}`, sql);
  for (const m of mods) await m.register(ctx);

  // Index every event, then fan out.
  const insert = db.prepare(`INSERT OR IGNORE INTO events(id, ts, source, type, session, agent, cwd, pane, json) VALUES (?,?,?,?,?,?,?,?,?)`);
  const offsets = {
    get: (f: string) => ((db.prepare("SELECT off FROM event_offsets WHERE file = ?").get(f) as any)?.off ?? 0),
    set: (f: string, off: number) => db.prepare("INSERT INTO event_offsets(file, off) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET off = excluded.off").run(f, off),
  };
  const tailer = new EventTailer(offsets, (e) => {
    const r = insert.run(e.id, e.ts, e.source, e.type, e.session ?? null, e.agent ?? null, e.cwd ?? null, e.pane ?? null, JSON.stringify(e));
    if (r.changes === 0) return; // already processed
    try { bus.emitEvent(e); } catch (err: any) { log(`event handler error: ${err.message}`); }
  });

  // Static UI (built by `npm run build`).
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
    return ui.response(c.req.path);
  });

  let uiTimer: NodeJS.Timeout | null = null;
  async function start() {
    diagnostics.start(opts.watchdogPort);
    uiTimer = setInterval(() => diagnostics.refresh("ui", () => ui.refresh()).catch((error) => log(`UI refresh failed: ${error}`)), 1000);
    uiTimer.unref();
    tailer.start();
    for (const m of mods) if (m.start) { try { await m.start(ctx); } catch (e: any) { log(`module ${m.name} start failed: ${e.message}`); } }
  }
  async function stop() {
    if (uiTimer) clearInterval(uiTimer);
    tailer.stop();
    await diagnostics.stop();
    for (const m of mods) if (m.stop) await m.stop();
  }
  return { ctx, app, start, stop, tailer, modules: mods };
}
