// Session readers: a read-only projection of Claude Code and Codex transcripts
// into the SQLite index. Parse results are cached by path + mtime + size (and
// resumed from a byte offset when a file grows), so restarts are cheap.
// Internal LLM sessions (cwd under .joyride/llm) are indexed but never shown.
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { resolveAccounts } from "../../core/accounts.ts";
import { now, repoRootOf, sha256 } from "../../core/util.ts";
import { oneLine, parseJson, readLines } from "./lines.ts";
import { claudeTranscriptState, feedClaude, newClaudeAcc, summarizeClaude, type ClaudeAcc } from "./claude.ts";
import { codexTranscript, codexTurns, feedCodex, newCodexAcc, readThreads, type CodexAcc, type CodexThread } from "./codex.ts";
import type { ListOpts, ScanStats, SessionItem, SessionsService, TranscriptState } from "./types.ts";
import type { IntentsApi } from "../live/intents.ts";
import { matchReplies } from "../../shared/replies.ts";

export type { SessionsService, SessionItem, Turn, ListOpts } from "./types.ts";

type Row = {
  key: string; source: "claude" | "codex"; id: string; path: string; mtime_ms: number; size: number; sig: string; head: string;
  cwd: string; repo: string | null; branch: string | null; started: string; updated: string; title: string; first_prompt: string;
  internal: number; hidden: number; view: string; state: string | null; first_seen: string;
};

const RESCAN_MS = 30_000;
const iso = (ms: number) => new Date(ms || Date.now()).toISOString();
const emptyStats = (): ScanStats => ({ files: 0, parsed: 0, incremental: 0, cached: 0, bytes: 0, removed: 0, ms: 0 });

/** Internal LLM sessions run in .joyride/llm; they never appear in the world view. */
export function isInternalCwd(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const llm = paths.llmCwd;
  return cwd === llm || cwd.startsWith(llm + path.sep) || cwd.includes(`${path.sep}.joyride${path.sep}llm`);
}

/** Accepts ISO, epoch ms, or a relative span like "30d" / "12h" / "90m". */
export function sinceIso(s: string | number | null | undefined): string | null {
  if (s == null || s === "") return null;
  if (typeof s === "number") return new Date(s).toISOString();
  const rel = /^(\d+)([mhdw])$/.exec(s.trim());
  if (rel) return new Date(Date.now() - Number(rel[1]) * ({ m: 6e4, h: 36e5, d: 864e5, w: 6048e5 } as Record<string, number>)[rel[2]]).toISOString();
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString();
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function headOf(file: string): string {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(256); const n = fs.readSync(fd, b, 0, 256, 0); return sha256(b.subarray(0, n)).slice(0, 16); } finally { fs.closeSync(fd); }
  } catch { return ""; }
}

function countSubagents(dir: string): number {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).length; } catch { return 0; }
}

const disposers: (() => void)[] = [];

export default defineModule({
  name: "sessions",
  order: 10,
  migrations: {
    "001": `CREATE TABLE sessions (
      key TEXT PRIMARY KEY, source TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL,
      mtime_ms REAL NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, sig TEXT NOT NULL DEFAULT '', head TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '', repo TEXT, branch TEXT, started TEXT NOT NULL, updated TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', first_prompt TEXT NOT NULL DEFAULT '',
      internal INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
      view TEXT NOT NULL, state TEXT, first_seen TEXT NOT NULL);
    CREATE INDEX sessions_updated ON sessions(updated);
    CREATE INDEX sessions_repo ON sessions(repo, updated);
    CREATE INDEX sessions_path ON sessions(path);`,
  },

  register(ctx: Ctx) {
    const { db, app } = ctx;
    const diagnostics = ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics");
    const projectsDir = () => path.join(paths.claudeDir, "projects");

    const upsertStmt = db.prepare(`INSERT INTO sessions(key, source, id, path, mtime_ms, size, sig, head, cwd, repo, branch, started, updated, title, first_prompt, internal, hidden, view, state, first_seen)
      VALUES (@key, @source, @id, @path, @mtime_ms, @size, @sig, @head, @cwd, @repo, @branch, @started, @updated, @title, @first_prompt, @internal, @hidden, @view, @state, @first_seen)
      ON CONFLICT(key) DO UPDATE SET source=excluded.source, id=excluded.id, path=excluded.path, mtime_ms=excluded.mtime_ms, size=excluded.size, sig=excluded.sig, head=excluded.head,
        cwd=excluded.cwd, repo=excluded.repo, branch=excluded.branch, started=excluded.started, updated=excluded.updated, title=excluded.title, first_prompt=excluded.first_prompt,
        internal=excluded.internal, hidden=excluded.hidden, view=excluded.view, state=excluded.state`);
    const getRow = (key: string) => db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as Row | undefined;
    const rowsOf = (source: string) => new Map((db.prepare("SELECT key, source, id, path, mtime_ms, size, sig, head, state FROM sessions WHERE source = ?").all(source) as Row[]).map((r) => [r.key, r]));
    const delRow = db.prepare("DELETE FROM sessions WHERE key = ?");

    /** Collects what changed during one scan so a single bus change goes out. */
    type Delta = { added: string[]; changed: string[] };
    const newDelta = (): Delta => ({ added: [], changed: [] });
    const publish = (d: Delta) => {
      if (!d.changed.length) return;
      ctx.bus.change({ entity: "sessions", op: "refresh", id: d.changed.length === 1 ? d.changed[0] : undefined, data: { added: d.added, changed: d.changed.length, keys: d.changed.slice(0, 200) } });
    };

    function write(view: SessionItem, extra: { path: string; mtime_ms: number; size: number; sig: string; head: string; state: string | null; internal: boolean; hidden: boolean }, existed: boolean, d: Delta) {
      upsertStmt.run({
        key: view.key, source: view.source, id: view.id, path: extra.path, mtime_ms: extra.mtime_ms, size: extra.size, sig: extra.sig, head: extra.head,
        cwd: view.cwd, repo: view.repo, branch: view.branch, started: view.started, updated: view.updated, title: view.title, first_prompt: view.first_prompt,
        internal: extra.internal ? 1 : 0, hidden: extra.hidden ? 1 : 0, view: JSON.stringify(view), state: extra.state, first_seen: now(),
      });
      if (extra.internal || extra.hidden) return;
      d.changed.push(view.key);
      if (!existed) d.added.push(view.key);
    }

    // ---------- Claude ----------
    async function parseClaudeFile(file: string, id: string, st: fs.Stats, sub: number, cached: Row | undefined, stats: ScanStats, d: Delta) {
      const sig = String(sub);
      if (cached && cached.path === file && cached.mtime_ms === st.mtimeMs && cached.size === st.size && cached.sig === sig) { stats.cached++; return; }
      const head = headOf(file);
      let acc: ClaudeAcc | null = null;
      if (cached && cached.path === file && cached.state && cached.head === head) {
        const a = parseJson(cached.state);
        if (a?.v === 1 && typeof a.offset === "number" && a.offset <= st.size) acc = a;
      }
      acc ??= newClaudeAcc(id);
      const from = acc.offset;
      if (from < st.size) {
        const res = await readLines(file, from, (l) => feedClaude(acc!, l));
        acc.offset = res.end;
        stats.bytes += res.end - from;
      }
      stats.parsed++;
      if (from > 0) stats.incremental++;
      const s = summarizeClaude(acc);
      const internal = isInternalCwd(s.cwd);
      const view: SessionItem = {
        key: `claude:${id}`, source: "claude", id, title: s.title, cwd: s.cwd, repo: s.cwd && !internal ? repoRootOf(s.cwd) : null, branch: s.branch,
        first_prompt: s.first_prompt, started: s.started ?? iso(st.mtimeMs), updated: s.updated ?? iso(st.mtimeMs), turns: s.turns, tokens: s.tokens,
        model: s.model, transcript: file, mission: null, archived: false, subagents: sub,
      };
      write(view, { path: file, mtime_ms: st.mtimeMs, size: st.size, sig, head, state: JSON.stringify(acc), internal, hidden: !s.started }, Boolean(cached), d);
    }

    const accountHomes = (provider: "claude" | "codex") => [...new Set([provider === "claude" ? paths.claudeDir : paths.codexDir, ...resolveAccounts(ctx.config.usage.accounts).filter(a => a.provider === provider && a.home).flatMap(a => a.home ? [a.home] : [])])];

    async function scanClaude(d: Delta): Promise<ScanStats> {
      const stats = emptyStats();
      const t0 = Date.now();
      const best = new Map<string, { file: string; st: fs.Stats; sub: number }>();
      let unreadable = false;
      for (const home of accountHomes("claude")) {
        const root = path.join(home, "projects");
        let slugs: fs.Dirent[];
        try { slugs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e: unknown) {
          if (fs.existsSync(root)) { unreadable = true; stats.error = `cannot read ${root}: ${e instanceof Error ? e.message : String(e)}`; }
          continue;
        }
        // Pick the newest file when an id appears in several login folders.
        for (const slug of slugs) {
          if (!slug.isDirectory()) continue;
          const dir = path.join(root, slug.name);
          let ents: fs.Dirent[];
          try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          const dirs = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name));
          for (const ent of ents) {
            if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
            const id = ent.name.slice(0, -6);
            const file = path.join(dir, ent.name);
            let st: fs.Stats;
            try { st = await fs.promises.stat(file); } catch { continue; }
            const prev = best.get(id);
            if (prev && prev.st.mtimeMs >= st.mtimeMs) continue;
            best.set(id, { file, st, sub: dirs.has(id) ? countSubagents(path.join(dir, id, "subagents")) : 0 });
          }
        }
      }
      const cached = rowsOf("claude");
      for (const [id, f] of best) {
        stats.files++;
        if (stats.files % 100 === 0) await new Promise<void>((r) => setImmediate(r));
        try { await parseClaudeFile(f.file, id, f.st, f.sub, cached.get(`claude:${id}`), stats, d); }
        catch (e: any) { ctx.log(`sessions: cannot parse ${f.file}: ${e.message}`); }
      }
      for (const key of cached.keys()) {
        if (unreadable || best.has(key.slice("claude:".length))) continue;
        delRow.run(key); stats.removed++; d.changed.push(key);
      }
      stats.ms = Date.now() - t0;
      return stats;
    }

    async function refreshClaudeFile(file: string, d: Delta) {
      const id = path.basename(file, ".jsonl");
      const key = `claude:${id}`;
      const cached = getRow(key);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch {
        if (cached && cached.path === file) { delRow.run(key); d.changed.push(key); }
        return;
      }
      const sub = countSubagents(path.join(path.dirname(file), id, "subagents"));
      await parseClaudeFile(file, id, st, sub, cached, emptyStats(), d);
    }

    // ---------- Codex ----------
    function codexView(t: CodexThread, acc: CodexAcc | null, sub: number, internal: boolean): SessionItem {
      return {
        key: `codex:${t.id}`, source: "codex", id: t.id, title: oneLine(t.title || t.first_user_message || "Untitled session", 120),
        cwd: t.cwd, repo: t.cwd && !internal ? repoRootOf(t.cwd) : null, branch: t.branch, first_prompt: oneLine(t.first_user_message, 500),
        started: iso(t.created_ms), updated: iso(t.updated_ms || t.created_ms), turns: acc ? codexTurns(acc) : 0, tokens: t.tokens_used,
        model: t.model ?? acc?.model ?? null, transcript: t.rollout_path, mission: null, archived: t.archived, subagents: sub,
      };
    }

    async function scanCodex(d: Delta): Promise<ScanStats> {
      const stats = emptyStats();
      const t0 = Date.now();
      const rows = new Map<string, CodexThread>();
      let found = false, unreadable = false;
      for (const home of accountHomes("codex")) {
        try {
          const res = readThreads(home);
          if (!res) { unreadable = true; stats.error = `no Codex state database in ${home}`; continue; }
          found = true; stats.via = res.via === "copy" || stats.via === "copy" ? "copy" : "direct";
          for (const row of res.rows) { const prior = rows.get(row.id); if (!prior || row.updated_ms > prior.updated_ms) rows.set(row.id, row); }
        } catch (e: unknown) { unreadable = true; stats.error = `cannot read Codex state: ${e instanceof Error ? e.message : String(e)}`; }
      }
      if (!found) { stats.error ??= "no Codex state database"; stats.ms = Date.now() - t0; return stats; }
      const subs = new Map<string, number>();
      for (const t of rows.values()) if (t.subagent && t.parent) subs.set(t.parent, (subs.get(t.parent) ?? 0) + 1);
      const threads = [...rows.values()].filter((t) => !t.subagent).sort((a, b) => b.updated_ms - a.updated_ms);
      const cached = rowsOf("codex");
      const seen = new Set<string>();
      for (const t of threads) {
        const key = `codex:${t.id}`;
        seen.add(key);
        stats.files++;
        const internal = isInternalCwd(t.cwd);
        let st: fs.Stats | null = null;
        try { st = t.rollout_path ? fs.statSync(t.rollout_path) : null; } catch {}
        const mtime = st?.mtimeMs ?? 0, size = st?.size ?? 0;
        const sub = subs.get(t.id) ?? 0;
        const sig = JSON.stringify([t.updated_ms, t.tokens_used, t.title, t.archived, t.branch, t.model, t.cwd, t.first_user_message.length, sub]);
        const c = cached.get(key);
        if (c && c.sig === sig && c.path === t.rollout_path && c.mtime_ms === mtime && c.size === size) { stats.cached++; continue; }
        let acc: CodexAcc | null = null;
        if (c?.state && c.path === t.rollout_path) { const a = parseJson(c.state); if (a?.v === 1 && a.offset <= size) acc = a; }
        if (st && !internal) {
          acc ??= newCodexAcc();
          const from = acc.offset;
          if (from < size) {
            try {
              const r = await readLines(t.rollout_path, from, (l) => feedCodex(acc!, l));
              acc.offset = r.end; stats.bytes += r.end - from;
            } catch (e: any) { ctx.log(`sessions: cannot read rollout ${t.rollout_path}: ${e.message}`); }
          }
          stats.parsed++;
          if (from > 0) stats.incremental++;
        }
        write(codexView(t, acc, sub, internal), { path: t.rollout_path, mtime_ms: mtime, size, sig, head: "", state: acc ? JSON.stringify(acc) : null, internal, hidden: false }, Boolean(c), d);
      }
      for (const key of cached.keys()) if (!unreadable && !seen.has(key)) { delRow.run(key); stats.removed++; d.changed.push(key); }
      stats.ms = Date.now() - t0;
      return stats;
    }

    // ---------- scheduling (one scan at a time; queued full scans coalesce) ----------
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
    type ScanResult = { claude: ScanStats; codex: ScanStats; ms: number };
    let last: ScanResult | null = null;
    const queued: Record<string, Promise<ScanResult> | null> = { all: null, codex: null };

    function scan(which: "all" | "codex"): Promise<ScanResult> {
      if (queued[which]) return queued[which]!;
      const p = serial(() => diagnostics.refresh(`sessions ${which}`, async () => {
        const t0 = Date.now();
        const d = newDelta();
        const claude = which === "all" ? await scanClaude(d) : (last?.claude ?? emptyStats());
        const codex = await scanCodex(d);
        const result = { claude, codex, ms: Date.now() - t0 };
        if (which === "all") last = result;
        publish(d);
        return result;
      }));
      queued[which] = p;
      void p.finally(() => { queued[which] = null; }).catch(() => {});
      return p;
    }

    const pendingFiles = new Set<string>();
    let fileTimer: NodeJS.Timeout | null = null;
    function queueFiles(files: string[], delay = 500) {
      for (const f of files) pendingFiles.add(f);
      if (fileTimer) return;
      fileTimer = setTimeout(() => {
        fileTimer = null;
        const batch = [...pendingFiles];
        pendingFiles.clear();
        serial(async () => {
          const d = newDelta();
          for (const f of batch) { try { await refreshClaudeFile(f, d); } catch (e: any) { ctx.log(`sessions: refresh ${f} failed: ${e.message}`); } }
          publish(d);
        }).catch(() => {});
      }, delay);
      fileTimer.unref?.();
    }
    let codexTimer: NodeJS.Timeout | null = null;
    function queueCodex(delay = 1500) {
      if (codexTimer) return;
      codexTimer = setTimeout(() => { codexTimer = null; scan("codex").catch(() => {}); }, delay);
      codexTimer.unref?.();
    }

    let initial: Promise<ScanResult> | null = null;
    const ready = () => (initial ??= scan("all")).then(() => undefined);

    // ---------- service ----------
    const missionsSvc = (): any => ctx.services.get("missions");
    const decorate = (v: SessionItem): SessionItem => {
      try { v.mission = missionsSvc()?.missionOfSession(v.key) ?? null; } catch { v.mission = null; }
      return v;
    };

    const transcriptCache = new Map<string, TranscriptState>();
    const service: SessionsService = {
      list(opts: ListOpts = {}) {
        const where = ["internal = 0", "hidden = 0"];
        const args: unknown[] = [];
        if (opts.repo) {
          if (opts.repo.includes("/")) { where.push("repo = ?"); args.push(opts.repo); }
          else { where.push("repo LIKE ?"); args.push(`%/${opts.repo}`); }
        }
        const since = sinceIso(opts.since);
        if (since) { where.push("updated >= ?"); args.push(since); }
        if (opts.q) { const q = `%${opts.q}%`; where.push("(title LIKE ? OR first_prompt LIKE ? OR cwd LIKE ? OR key LIKE ?)"); args.push(q, q, q, q); }
        if (opts.keys) {
          if (!opts.keys.length) return [];
          where.push(`key IN (${opts.keys.map(() => "?").join(",")})`);
          args.push(...opts.keys);
        }
        const unassigned = opts.mission === "none";
        if (opts.mission && !unassigned) {
          let keys: string[] = [];
          try { keys = (missionsSvc()?.get(opts.mission)?.sessions ?? []).map((r: any) => `${r.source}:${r.id}`); } catch {}
          if (!keys.length) return [];
          where.push(`key IN (${keys.map(() => "?").join(",")})`);
          args.push(...keys);
        }
        const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 100_000));
        const sql = `SELECT view FROM sessions WHERE ${where.join(" AND ")} ORDER BY updated DESC${unassigned ? "" : " LIMIT ?"}`;
        const rows = db.prepare(sql).all(...args, ...(unassigned ? [] : [limit])) as { view: string }[];
        const out = rows.map((r) => decorate(JSON.parse(r.view)));
        return unassigned ? out.filter((s) => !s.mission).slice(0, limit) : out;
      },
      get(keyOrId: string) {
        const keys = keyOrId.includes(":") ? [keyOrId] : [`claude:${keyOrId}`, `codex:${keyOrId}`];
        for (const k of keys) {
          const r = db.prepare("SELECT view, internal FROM sessions WHERE key = ?").get(k) as { view: string; internal: number } | undefined;
          if (r && !r.internal) return decorate(JSON.parse(r.view));
        }
        return null;
      },
      async transcript(keyOrId: string, opts: { limit?: number } = {}) {
        return (await service.transcriptState(keyOrId, opts))?.turns ?? null;
      },
      async transcriptState(keyOrId: string, opts: { limit?: number; fullText?: boolean } = {}) {
        const v = service.get(keyOrId);
        if (!v) return null;
        const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 5000));
        const empty: TranscriptState = { turns: [], queue: v.source === "claude" ? [] : null, pulled: v.source === "claude" ? [] : null };
        if (!v.transcript) return empty;
        let st: fs.Stats;
        try { st = fs.statSync(v.transcript); }
        catch (error) { if (opts.fullText) throw error; return empty; }
        // Recover missing source paths from this session's sent image intents.
        const intents = ctx.services.has("intents") ? ctx.service<IntentsApi>("intents") : null;
        const replies = (intents?.imageReplies(v.key) ?? []).map((it) => ({
          id: it.id, created: it.created, text: String(it.payload.text ?? it.payload.message ?? ""),
          images: Array.isArray(it.payload.images) ? it.payload.images.filter((p): p is string => typeof p === "string") : [],
        }));
        // Keep only the requested tail in the cache. New sent intents invalidate a parse
        // even if the transcript has not changed, so recovery can follow a late relay result.
        const ck = `${v.transcript}|${st.size}|${st.mtimeMs}|${limit}|${Boolean(opts.fullText)}|${replies.map((r) => r.id).join(",")}`;
        const hit = transcriptCache.get(ck);
        if (hit) { transcriptCache.delete(ck); transcriptCache.set(ck, hit); return hit; }
        const out: TranscriptState = v.source === "claude"
          ? await claudeTranscriptState(v.transcript, replies.length ? Infinity : limit, opts)
          : { turns: await codexTranscript(v.transcript, replies.length ? Infinity : limit, opts), queue: null, pulled: null };
        const turns = out.turns;
        for (const m of matchReplies(replies, turns)) {
          if (!m.images.length) continue;
          const images = (turns[m.turn].images ??= []);
          m.images.forEach((p, i) => { if (!images[m.offset + i]) images[m.offset + i] = p; });
        }
        // Match before clipping so an older identical reply cannot claim a later turn's image.
        const result = { ...out, turns: turns.slice(-limit) };
        transcriptCache.set(ck, result);
        while (transcriptCache.size > 40) transcriptCache.delete(transcriptCache.keys().next().value!);
        return result;
      },
      async reindex(opts: { full?: boolean } = {}) {
        if (opts.full) await serial(async () => { db.prepare("DELETE FROM sessions").run(); });
        const r = await scan("all");
        initial ??= Promise.resolve(r);
        return r;
      },
      ready,
      counts() {
        const r = db.prepare(`SELECT COUNT(*) total, SUM(internal = 0 AND hidden = 0) visible, SUM(internal) internal, SUM(hidden) hidden,
          SUM(source = 'claude' AND internal = 0 AND hidden = 0) claude, SUM(source = 'codex' AND internal = 0 AND hidden = 0) codex FROM sessions`).get() as any;
        return { total: r.total ?? 0, visible: r.visible ?? 0, internal: r.internal ?? 0, hidden: r.hidden ?? 0, claude: r.claude ?? 0, codex: r.codex ?? 0 };
      },
    };
    (service as any).lastScan = () => last;
    ctx.services.set("sessions", service);

    // ---------- routes ----------
    app.get("/api/sessions", (c) => {
      const q = c.req.query();
      const keys = q.keys !== undefined ? q.keys.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 500) : undefined;
      return c.json(service.list({ repo: q.repo, since: q.since, mission: q.mission, q: q.q, keys, limit: q.limit ? Number(q.limit) : undefined }));
    });
    app.post("/api/sessions/reindex", async (c) => c.json(await service.reindex({ full: c.req.query("full") === "1" })));
    app.get("/api/sessions/:key/transcript", async (c) => {
      const key = c.req.param("key");
      const turns = await service.transcript(key, { limit: Number(c.req.query("limit") ?? 200) });
      return turns ? c.json({ key, turns }) : c.json({ error: `No session ${key}. Check the key (source:id) or reindex.` }, 404);
    });
    app.get("/api/sessions/:key", (c) => {
      const v = service.get(c.req.param("key"));
      return v ? c.json(v) : c.json({ error: `No session ${c.req.param("key")}. Check the key (source:id) or reindex.` }, 404);
    });

    // ---------- live refresh hooks (wired in start) ----------
    (service as any)._start = () => {
      ready().catch((e) => ctx.log(`sessions: initial scan failed: ${e.message}`));
      const proj = projectsDir();
      for (const home of accountHomes("claude")) {
        const watchedProjects = path.join(home, "projects");
        try {
          const w = fs.watch(watchedProjects, { recursive: true }, (_ev, name) => {
            if (!name) return;
            const rel = String(name);
            if (!rel.endsWith(".jsonl")) return;
            const parts = rel.split(path.sep);
            if (parts.length === 2) queueFiles([path.join(watchedProjects, rel)]);
            else if (parts.length === 4 && parts[2] === "subagents") queueFiles([path.join(watchedProjects, parts[0], `${parts[1]}.jsonl`)]);
          });
          w.on("error", () => {});
          disposers.push(() => w.close());
        } catch { /* periodic rescan covers it */ }
      }
      for (const home of accountHomes("codex")) {
        try {
          const w = fs.watch(home, (_ev, name) => { if (name && String(name).startsWith("state_5.sqlite")) queueCodex(); });
          w.on("error", () => {});
          disposers.push(() => w.close());
        } catch {}
      }
      const timer = setInterval(() => { scan("all").catch((e) => ctx.log(`sessions: rescan failed: ${e.message}`)); }, RESCAN_MS);
      timer.unref?.();
      disposers.push(() => clearInterval(timer));
      const off = ctx.bus.onEvent((e) => {
        if (!e.session || !e.agent) return;
        if (!["session.start", "prompt.submit", "turn.stop", "turn.stop_failure", "session.end"].includes(e.type)) return;
        if (e.agent === "codex") { queueCodex(300); return; }
        if (e.agent !== "claude") return;
        const row = getRow(`claude:${e.session}`);
        if (row) { queueFiles([row.path], 250); return; }
        const guess = e.cwd ? path.join(proj, e.cwd.replace(/[^A-Za-z0-9]/g, "-"), `${e.session}.jsonl`) : null;
        if (guess && fs.existsSync(guess)) queueFiles([guess], 250);
        else scan("all").catch(() => {});
      });
      disposers.push(off);
      disposers.push(() => { if (fileTimer) clearTimeout(fileTimer); if (codexTimer) clearTimeout(codexTimer); });
    };
  },

  start(ctx) {
    ctx.service<any>("sessions")._start();
  },

  stop() {
    while (disposers.length) { try { disposers.pop()!(); } catch {} }
  },
});
