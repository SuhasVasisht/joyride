// Read-only request timings. The sandbox uses captured GET data, never the live stores.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { buildSandbox } from "../tests/sandbox.ts";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".joyride/perf");
const base = process.argv[3] ?? "http://127.0.0.1:4410";
if (process.argv[2] === "capture") {
  fs.mkdirSync(dir, { recursive: true });
  for (const source of ["memory", "artifacts", "sessions", "workers"]) {
    const response = await fetch(`${base}/api/${source}?limit=100000`);
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    fs.writeFileSync(path.join(dir, `live-${source}.json`), JSON.stringify(await response.json()));
  }
} else if (process.argv[2] === "serve" || process.argv[2] === "compare") {
  const sb = buildSandbox(path.join(dir, "world"), { port: 4410 });
  Object.assign(process.env, sb.env);
  for (const folder of ["missions", "lenses"]) fs.cpSync(path.join(root, folder), path.join(sb.env.JOYRIDE_HOME, folder), { recursive: true });
  const { StoredEntry, writeEntry } = await import("../src/modules/memory/store.ts");
  const { StoredArtifact, writeArtifact } = await import("../src/modules/artifacts/store.ts");
  for (const entry of JSON.parse(fs.readFileSync(path.join(dir, "live-memory.json"), "utf8"))) writeEntry(path.join(sb.env.JOYRIDE_HOME, "memory/entries"), StoredEntry.parse(entry));
  for (const artifact of JSON.parse(fs.readFileSync(path.join(dir, "live-artifacts.json"), "utf8"))) writeArtifact(path.join(sb.env.JOYRIDE_HOME, "artifacts"), StoredArtifact.parse({ ...artifact, local_source: null }));
  const { createDaemon } = await import("../src/server/app.ts");
  const baseline = process.env.PERF_KNOWLEDGE_FILE;
  const only = baseline ? fs.readdirSync(path.join(root, "src/modules")).filter((name) => name !== "knowledge") : undefined;
  const daemon = await createDaemon({ quiet: true, only });
  const memory = daemon.ctx.service<import("../src/modules/memory/index.ts").MemoryService>("memory");
  const digest = memory.digest, digestEntries = memory.digestEntries;
  let digestCalls = 0, digestMs = 0;
  memory.digest = (repo) => { const at = performance.now(); digestCalls++; try { return digest(repo); } finally { digestMs += performance.now() - at; } };
  memory.digestEntries = (repos) => { const at = performance.now(); digestCalls++; try { return digestEntries(repos); } finally { digestMs += performance.now() - at; } };
  const sessions: unknown[] = JSON.parse(fs.readFileSync(path.join(dir, "live-sessions.json"), "utf8"));
  const { SessionView } = await import("../src/shared/schema.ts");
  const insert = daemon.ctx.db.prepare("INSERT OR REPLACE INTO sessions(key,source,id,path,cwd,repo,started,updated,title,first_prompt,view,first_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const input of sessions) {
    const s = SessionView.parse(input);
    const transcript = path.join(sb.dir, `${s.id}.jsonl`);
    s.transcript = transcript;
    const turns = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? "assistant" : "user", sessionId: s.id, cwd: s.cwd, timestamp: s.updated,
      message: { role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: "Sandbox response for first-load timing." }] : "Sandbox prompt for first-load timing." } }));
    fs.writeFileSync(transcript, turns.map((t) => JSON.stringify(t)).join("\n"));
    insert.run(s.key, s.source, s.id, transcript, s.cwd, s.repo, s.started, s.updated, s.title, s.first_prompt, JSON.stringify(s), s.started);
  }
  const { WorkerView } = await import("../src/shared/schema.ts");
  const { WorkersProjection } = await import("../src/modules/live/workers.ts");
  const workers = JSON.parse(fs.readFileSync(path.join(dir, "live-workers.json"), "utf8")).map((w: unknown) => {
    const parsed = WorkerView.parse(w);
    return { ...parsed, pane: null, controllable: false };
  });
  WorkersProjection.prototype.current = () => workers;
  if (baseline) (await import(pathToFileURL(path.resolve(baseline)).href)).default.register(daemon.ctx);
  const { setQuotaSource } = await import("../src/modules/usage/index.ts");
  const { allLiveStdout } = await import("../tests/fixtures/quota.ts");
  setQuotaSource(() => new Promise((resolve) => setTimeout(() => resolve({ kind: "ok", stdout: allLiveStdout(Date.now()) }), 3440)));
  // Register only: no background source readers, Herdr lifecycle or authored-data writers.
  // Warm the new knowledge index if the module exposes a read-only preparation hook.
  const knowledge = daemon.ctx.services.get("knowledge");
  if (process.argv[2] === "compare") {
    const before = knowledge;
    const mod = (await import("../src/modules/knowledge/index.ts")).default;
    mod.register(daemon.ctx);
    const after = daemon.ctx.service<import("../src/modules/knowledge/index.ts").KnowledgeService>("knowledge");
    const rows = [];
    const measure = (side: string, fn: () => unknown) => {
      const at = performance.now(), cpu = process.cpuUsage(), calls = digestCalls, digestAt = digestMs;
      const result = fn();
      const used = process.cpuUsage(cpu);
      rows.push({ side, wallMs: performance.now() - at, cpuMs: (used.user + used.system) / 1000,
        digestCalls: digestCalls - calls, digestMs: digestMs - digestAt, result });
    };
    measure("prepare", () => { after.prepare(); return null; });
    for (let i = 0; i < 5; i++) for (const [side, service] of [["before", before], ["after", after]]) {
      if (side === "after") measure("rebuild", () => { after.prepare(); return null; });
      measure(side, () => {
        const result = service.search({ limit: 50 });
        return { total: result.total, items: result.items.length, keys: result.items.map((item: { key: string }) => item.key) };
      });
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), load: os.loadavg(), rows }, null, 2));
    await daemon.stop(); await mod.stop?.(); daemon.ctx.db.close();
    process.exit(0);
  }
  if (typeof knowledge?.prepare === "function") knowledge.prepare();
  const server = serve({ fetch: async (request, ...args) => {
    const at = performance.now(), cpu = process.cpuUsage(), calls = digestCalls, digestAt = digestMs;
    const url = new URL(request.url);
    let response: Response;
    if (baseline && request.method === "GET" && url.pathname === "/api/knowledge/search") {
      const { KnowledgeQuery } = await import("../src/shared/knowledge.ts");
      const q = Object.fromEntries(url.searchParams);
      const query = KnowledgeQuery.parse({ ...q, types: q.types?.split(",").filter(Boolean) });
      response = Response.json(knowledge.search(query));
    } else response = await daemon.app.fetch(request, ...args);
    if (process.env.PERF_PROFILE === "1") {
      const used = process.cpuUsage(cpu);
      console.log(JSON.stringify({ url: new URL(request.url).pathname, wallMs: performance.now() - at, cpuMs: (used.user + used.system) / 1000, load: os.loadavg()[0], digestCalls: digestCalls - calls, digestMs: digestMs - digestAt }));
    }
    return response;
  }, hostname: "127.0.0.1", port: 4410 });
  console.log(JSON.stringify({ ready: true, port: 4410, sessions: sessions.length, home: sb.env.JOYRIDE_HOME }));
  process.on("SIGTERM", async () => { server.close(); await daemon.stop(); process.exit(0); });
} else {
  const workers = await (await fetch(`${base}/api/workers`)).json();
  const worker = workers.find((w: { session: string | null }) => w.session) ?? workers[0];
  const urls = new Set([
    "/api/health", "/api/workspace/spec", "/api/missions", "/api/workers", "/api/lenses",
    "/api/attention?open=1&limit=500", "/api/evidence/verdicts?limit=500", "/api/firstmate/status",
    "/api/firstmate/tasks", "/api/artifacts?limit=500", "/api/asks", "/api/firstmate/replies",
    "/api/sessions?mission=none&since=24h&limit=40", "/api/missions/proposals", "/api/guard/pending",
    "/api/attention?open=1&min_level=L3&limit=100", "/api/attention?open=1&level=L2&limit=100",
    "/api/attention?open=1&level=L1&limit=100", "/api/usage", "/api/artifacts",
    "/api/knowledge/search?q=&mode=all&limit=50", "/api/knowledge/search?mode=to-review&limit=1",
    "/api/attention?open=1&limit=200", "/api/notes?global=1", "/api/nudges",
    "/api/memory/health", "/api/memory?status=candidate&limit=2000", "/api/workspace/proposals?status=open",
    "/api/system/setup", "/api/metrics", "/api/hillclimb/runs?limit=30",
    `/api/intentions?keys=${encodeURIComponent(workers.flatMap((w: { session: string | null }) => w.session ? [w.session] : []).join(","))}`,
  ]);
  const missions = await (await fetch(`${base}/api/missions`)).json();
  for (const mission of missions.filter((m: { archive: boolean }) => !m.archive)) urls.add(`/api/notes?idea=${encodeURIComponent(mission.id)}`);
  if (worker) {
    urls.add(`/api/workers/${encodeURIComponent(worker.id)}`);
    urls.add(`/api/workers/${encodeURIComponent(worker.id)}/staged`);
    if (worker.session) {
      urls.add(`/api/sessions/${encodeURIComponent(worker.session)}`);
      urls.add(`/api/sessions/${encodeURIComponent(worker.session)}/transcript?limit=80`);
      urls.add(`/api/sessions/${encodeURIComponent(worker.session)}/transcript?limit=40`);
      urls.add(`/api/intentions/${encodeURIComponent(worker.session)}`);
      urls.add(`/api/notes?session=${encodeURIComponent(worker.session)}`);
    }
  }
  if (process.env.PERF_BROWSER_REQUESTS) {
    const pages = JSON.parse(fs.readFileSync(process.env.PERF_BROWSER_REQUESTS, "utf8"));
    for (const page of pages) for (const request of page.requests) {
      // Navigation telemetry is POST-only; never replay it against the live daemon.
      if (request.path !== "/api/workspace/interactions") urls.add(request.path);
    }
  }
  const rows = [];
  for (const url of urls) {
    const times = [], statuses = [], bytes = [];
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      const r = await fetch(`${base}${url}`);
      const body = await r.text();
      if (!r.ok) throw new Error(`${url} returned ${r.status}: ${body.slice(0, 200)}`);
      times.push(Math.round((performance.now() - at) * 10) / 10);
      statuses.push(r.status); bytes.push(body.length);
      JSON.parse(body);
    }
    const sorted = [...times].sort((a, b) => a - b);
    rows.push({ url, medianMs: sorted[2], minMs: sorted[0], maxMs: sorted[4], times, statuses, bytes });
  }
  console.log(JSON.stringify({ base, at: new Date().toISOString(), load: os.loadavg(), cores: os.cpus().length, rows }, null, 2));
}
