// Artifact registry (DESIGN §2, §9): external outputs (Claude artifacts,
// ChatGPT pages, PRs, local reports) registered as knowledge sources.
//   - artifacts/<id>.md files, committed via commitPaths
//   - auto-detection from Claude transcripts (Artifact tool publishes, links)
//   - local snapshots in the blob store, previewable in a sandboxed iframe
//   - Firstmate's reports (<FM_HOME>/data/<task>/report.md), registered and
//     snapshotted automatically, read-only toward Firstmate (firstmate.ts)
//   - the review list (#/knowledge/artifacts): every artifact merged across
//     sources, newest first, paged (shared/artifact-review.ts)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { commitPaths, fileHistory } from "../../core/gitstore.ts";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { tombstoned } from "../../shared/knowledge-admission.ts";
import { now, truncate } from "../../core/util.ts";
import { readLines } from "../sessions/lines.ts";
import { blobPath, isSha, putBlobBuffer, sniffType } from "../evidence/blobs.ts";
import { detectLine, newScanState, type Detected, type ScanState } from "./detect.ts";
import { artifactFilter, disposableSource, repairArtifactSnapshots } from "./hygiene.ts";
import { readFirstmateReports, reportsSignature, type FmReport } from "./firstmate.ts";
import { mergeArtifacts, reviewPage, type ReviewFilter, type ReviewPage } from "../../shared/artifact-review.ts";
import {
  StoredArtifact, localSourceKey, matchesLocalSource, contentTypeOf, htmlTitle, kindOfLocal, kindOfUrl, loadArtifacts, newArtifactId, normalizeUrl,
  readArtifact, titleForUrl, writeArtifact, type ArtifactKind, type FirstmateOrigin,
} from "./store.ts";

export { StoredArtifact } from "./store.ts";

export type ArtifactView = StoredArtifact & { session_title: string | null };
export type RegisterInput = {
  url?: string | null; local_source?: string | null; title?: string | null; mission?: string | null; session?: string | null;
  kind?: ArtifactKind; source?: string; summary?: string; created?: string; project?: string | null;
};
export type ListFilter = { mission?: string; session?: string; kind?: string; project?: string; q?: string; limit?: number };
export type FirstmateSyncReport = {
  at: string; home: string; reports: number; created: number; updated: number; unchanged: number; ids: string[];
  commit: string | null; ms: number; error?: string;
};
export type ScanReport = { at: string; files: number; scanned: number; skipped: number; found: number; created: number; updated: number; commit: string | null; ms: number; error?: string };
export type ArtifactsService = {
  list(f?: ListFilter): ArtifactView[];
  get(id: string): ArtifactView | null;
  register(a: RegisterInput): ArtifactView & { deduped: boolean };
  update(id: string, patch: { title?: string; mission?: string | null; summary?: string }): ArtifactView;
  scan(): Promise<ScanReport>;
  lastScan(): ScanReport | null;
  /** Register every Firstmate report with its latest snapshot. */
  syncFirstmate(): Promise<FirstmateSyncReport>;
  lastFirstmateSync(): FirstmateSyncReport | null;
  /** The review list: every artifact merged across sources, newest first, one page at a time. */
  review(f?: ReviewFilter): ReviewPage;
};

export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const MAX_SNAPSHOT = 25 * 1024 * 1024;
const PREVIEWABLE = /^(text\/html|image\/|application\/pdf|text\/markdown|text\/plain|application\/json|text\/csv)/;
const SANDBOXED = /^(text\/html|image\/svg|text\/markdown|text\/plain|text\/csv|application\/json)/;
const DETECT_RANK: Record<string, number> = { manual: 0, transcript: 1, "artifact-tool": 2, firstmate: 3 };

function expandHome(p: string) { return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p; }

const disposers: (() => void)[] = [];

export default defineModule({
  name: "artifacts",
  order: 70,
  migrations: {
    "001": `CREATE TABLE artifact_scan (file TEXT PRIMARY KEY, session TEXT, offset INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, state TEXT NOT NULL, scanned TEXT NOT NULL);`,
  },
  register(ctx: Ctx) {
    const { app, db } = ctx;
    const admission = knowledgePolicy(ctx);
    const dir = () => paths.artifacts;
    const optional = <T = any>(name: string): T | null => (ctx.services.get(name) as T) ?? null;

    const missionOfSession = (key: string | null): string | null => {
      if (!key) return null;
      try { return optional<any>("missions")?.missionOfSession(key) ?? null; } catch { return null; }
    };
    const sessionOf = (key: string | null): any | null => {
      if (!key) return null;
      try { return optional<any>("sessions")?.get(key) ?? null; } catch { return null; }
    };
    const missionRepo = (id: string | null): string | null => {
      if (!id) return null;
      try { const r = optional<any>("missions")?.get(id)?.repos?.[0]; return r ? path.basename(r) : null; } catch { return null; }
    };
    /** The project an artifact belongs to: what its source said, else its session's or mission's repo. */
    const projectOf = (a: StoredArtifact, mission: string | null): string | null => {
      if (a.project) return a.project;
      const repo = sessionOf(a.session)?.repo;
      return repo ? path.basename(repo) : missionRepo(mission);
    };
    const view = (a: StoredArtifact): ArtifactView => {
      const mission = a.mission ?? missionOfSession(a.session);
      return { ...a, private: a.private || admission.private(a), mission, project: projectOf(a, mission), session_title: sessionOf(a.session)?.title ?? null };
    };
    const all = () => loadArtifacts(dir());
    const mustGet = (id: string) => { const a = readArtifact(dir(), id); if (!a) throw new HttpError(404, `No artifact "${id}". It may have been removed; refresh the list.`); return a; };
    const changed = (id?: string) => ctx.bus.change({ entity: "artifacts", id });
    function commit(files: string[], msg: string): string | null {
      if (!files.length) return null;
      try { return commitPaths(files, msg); } catch (e: any) { ctx.log(`artifacts: commit failed (files stay on disk): ${e.message}`); return null; }
    }

    // ---------- snapshots ----------
    function snapshot(a: StoredArtifact): boolean {
      if (!a.local_source) return false;
      let st: fs.Stats;
      try { st = fs.statSync(a.local_source); } catch { return false; }
      if (!st.isFile() || st.size > MAX_SNAPSHOT) return false;
      let sha: string;
      try {
        const buf = fs.readFileSync(a.local_source);
        const type = contentTypeOf(a.local_source) ?? sniffType(buf.subarray(0, 4096));
        let clean: Buffer | string = buf;
        if (admission.admits({ ...a, url: a.detected_from === "transcript" ? a.url : null }) && /^(text\/(?:html|markdown|plain|csv)|application\/json)/.test(type)) {
          const filter = artifactFilter(ctx);
          clean = filter.text(buf.toString("utf8"), type);
          a.summary = filter.text(a.summary).trim();
          a.notes = filter.text(a.notes).trim();
        }
        sha = putBlobBuffer(clean);
      } catch (e: any) { ctx.log(`artifacts: snapshot of ${a.local_source} failed: ${e.message}`); return false; }
      if (sha === a.snapshot_blob) return false;
      let type: string | null = contentTypeOf(a.local_source);
      if (!type) { try { type = sniffType(fs.readFileSync(blobPath(sha)).subarray(0, 4096)); } catch { type = null; } }
      a.snapshot_blob = sha;
      a.content_type = type;
      a.embeddable = Boolean(type && PREVIEWABLE.test(type));
      a.updated = now();
      return true;
    }

    function localTitle(file: string): string {
      try {
        const head = fs.readFileSync(file, "utf8").slice(0, 64 * 1024);
        if (/\.html?$/i.test(file)) { const t = htmlTitle(head); if (t) return t; }
        if (/\.(md|markdown)$/i.test(file)) { const h = head.match(/^#\s+(.+)$/m)?.[1]?.trim(); if (h) return h; }
      } catch { /* unreadable: fall back to the name */ }
      return path.basename(file).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    }

    // ---------- registration ----------
    function findExisting(list: StoredArtifact[], url: string | null, local: string | null) {
      if (url) { const match = list.find((a) => a.url && normalizeUrl(a.url) === url); if (match) return match; }
      if (local) return list.find((a) => (!a.url || a.url === url) && (matchesLocalSource(a, local) || (a.firstmate && path.basename(local) === "report.html" && matchesLocalSource(a, path.join(path.dirname(local), "report.md"))))) ?? null;
      return null;
    }

    function detachSource(a: StoredArtifact, identity?: string) {
      if (!a.local_source || !disposableSource(a.local_source)) return false;
      if (!a.snapshot_blob && !a.url) throw new HttpError(400, "This file is in a disposable folder and could not be saved. Use a readable file under 25 MiB, a stable source path, or a hosted URL.");
      a.source_key = localSourceKey(identity ?? a.local_source);
      a.local_source = null;
      return true;
    }

    type Upsert = { artifact: StoredArtifact; created: boolean; changed: boolean; file: string | null };
    type UpsertInput = RegisterInput & { identity_source?: string; detected_from?: StoredArtifact["detected_from"]; firstmate?: FirstmateOrigin };
    function upsert(input: UpsertInput, list: StoredArtifact[], opts: { requireLocal: boolean }): Upsert {
      const rawUrl = input.url?.trim() || null;
      if (rawUrl && !/^https?:\/\//i.test(rawUrl)) throw new HttpError(400, `"${rawUrl}" is not a web address. Use a full https:// link, or pass local_source for a file.`);
      const url = rawUrl ? normalizeUrl(rawUrl) : null;
      const local = input.local_source?.trim() ? path.resolve(expandHome(input.local_source.trim())) : null;
      if (!url && !local) throw new HttpError(400, "Give a url, a local_source path, or both.");
      if (local && opts.requireLocal && !fs.existsSync(local)) throw new HttpError(400, `No file at ${local}. Check the path, or register the hosted url instead.`);
      if (input.mission) {
        const ms = optional<any>("missions");
        if (ms && !ms.get(input.mission)) throw new HttpError(400, `No mission "${input.mission}". Pick an existing mission id, or leave it empty.`);
      }
      const via = input.detected_from ?? "manual";
      if (tombstoned({ url, local_source: local }, admission.policy)) throw new HttpError(409, "This source was removed from knowledge. Remove its tombstone in joyride.config.yaml to register it again.");
      const isPrivate = admission.private({ session: input.session, local_source: local });
      const identity = input.identity_source;
      const ex = findExisting(list, url, local) ?? (identity ? list.find(a => matchesLocalSource(a, identity) || (local && matchesLocalSource(a, local))) ?? null : null);
      if (ex) {
        const before = JSON.stringify(ex);
        let dirty = false;
        if (isPrivate && !ex.private) { ex.private = true; dirty = true; }
        const set = <K extends keyof StoredArtifact>(k: K, v: StoredArtifact[K]) => { if (v != null && v !== "" && ex[k] !== v) { (ex as any)[k] = v; dirty = true; } };
        if (!ex.url && url) set("url", url);
        const better = (DETECT_RANK[via] ?? 0) > (DETECT_RANK[ex.detected_from] ?? 0) || via === "manual";
        const sameReport = via === "firstmate" && identity !== undefined && matchesLocalSource(ex, identity);
        if (!ex.mission && input.mission) set("mission", input.mission);
        if (!ex.session && input.session) set("session", input.session);
        if (local && (!ex.local_source || better || sameReport)) set("local_source", local);
        if (input.title && (better || !ex.title)) set("title", input.title.trim());
        if (better && via !== "manual") set("detected_from", via);
        if (input.summary && !ex.summary) set("summary", input.summary.trim());
        if (input.project && ex.project !== input.project) set("project", input.project);
        if (input.firstmate) {
          // The report's own heading is its title, unless someone renamed it here.
          if (input.firstmate.heading && ex.firstmate?.heading && ex.title === ex.firstmate.heading && input.firstmate.heading !== ex.title) set("title", input.firstmate.heading);
          if (JSON.stringify(ex.firstmate) !== JSON.stringify(input.firstmate)) { ex.firstmate = input.firstmate; dirty = true; }
        }
        if (snapshot(ex)) dirty = true;
        detachSource(ex, input.identity_source);
        if (input.identity_source) ex.source_key = localSourceKey(input.identity_source);
        dirty = JSON.stringify(ex) !== before;
        if (dirty) { ex.updated = now(); return { artifact: ex, created: false, changed: true, file: writeArtifact(dir(), ex) }; }
        return { artifact: ex, created: false, changed: false, file: null };
      }
      const kind: ArtifactKind = input.kind ?? (url ? kindOfUrl(url) : kindOfLocal(local!));
      const session = input.session ?? null;
      const title = input.title?.trim() || (local && fs.existsSync(local) ? localTitle(local) : url ? titleForUrl(url, kind, sessionOf(session)?.title ?? null) : path.basename(local!));
      const created = input.created && Number.isFinite(Date.parse(input.created)) ? new Date(input.created).toISOString() : now();
      const a = StoredArtifact.parse({
        id: newArtifactId(kind, title, url ?? local!), title, url, kind,
        private: isPrivate,
        source: input.source ?? (session ? session.split(":")[0] : "human"),
        session, mission: input.mission ?? missionOfSession(session), local_source: local, snapshot_blob: null,
        created, updated: created, summary: input.summary?.trim() || title, embeddable: false, detected_from: via,
        project: input.project ?? null, firstmate: input.firstmate ?? null,
      });
      snapshot(a);
      detachSource(a, input.identity_source);
      if (input.identity_source) a.source_key = localSourceKey(input.identity_source);
      list.push(a);
      return { artifact: a, created: true, changed: true, file: writeArtifact(dir(), a) };
    }

    function register(input: RegisterInput): ArtifactView & { deduped: boolean } {
      if (!input || typeof input !== "object") throw new HttpError(400, "Send {url} or {local_source}, with an optional title and mission.");
      const r = upsert(input, all(), { requireLocal: true });
      if (r.file) commit([r.file], r.created ? `artifacts: register ${r.artifact.id}` : `artifacts: update ${r.artifact.id}`);
      if (r.changed) changed(r.artifact.id);
      return { ...view(r.artifact), deduped: !r.created };
    }

    function update(id: string, patch: { title?: string; mission?: string | null; summary?: string }): ArtifactView {
      const a = mustGet(id);
      if (patch.title !== undefined) { if (!String(patch.title).trim()) throw new HttpError(400, "A title cannot be empty."); a.title = String(patch.title).trim(); }
      if (patch.mission !== undefined) {
        const m = patch.mission ? String(patch.mission) : null;
        if (m && optional<any>("missions") && !optional<any>("missions").get(m)) throw new HttpError(400, `No mission "${m}".`);
        a.mission = m;
      }
      if (patch.summary !== undefined) a.summary = String(patch.summary);
      a.updated = now();
      commit([writeArtifact(dir(), a)], `artifacts: edit ${id}`);
      changed(id);
      return view(a);
    }

    function list(f: ListFilter = {}): ArtifactView[] {
      let out = all().map(view);
      if (f.mission) out = out.filter((a) => a.mission === f.mission);
      if (f.session) out = out.filter((a) => a.session === f.session);
      if (f.kind) out = out.filter((a) => a.kind === f.kind);
      if (f.project) out = out.filter((a) => a.project === f.project);
      if (f.q?.trim()) {
        const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
        out = out.filter((a) => { const hay = `${a.title} ${a.url ?? ""} ${a.summary} ${a.local_source ?? ""} ${a.kind}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
      }
      return out.sort((a, b) => b.created.localeCompare(a.created)).slice(0, f.limit ?? 1000);
    }

    // ---------- review ----------
    function review(f: ReviewFilter = {}): ReviewPage {
      const ms = optional<any>("missions");
      const titles = new Map<string, string | null>();
      const missionTitle = (id: string) => {
        if (!titles.has(id)) { let t: string | null = null; try { t = ms?.get(id)?.title ?? null; } catch { /* untitled */ } titles.set(id, t); }
        return titles.get(id)!;
      };
      return reviewPage(mergeArtifacts(all().map(view), missionTitle), f);
    }

    // ---------- transcript scanning ----------
    let scanning: Promise<ScanReport> | null = null;
    let last: ScanReport | null = null;
    const getScan = db.prepare("SELECT offset, size, mtime, state FROM artifact_scan WHERE file = ?");
    const putScan = db.prepare(`INSERT INTO artifact_scan(file, session, offset, size, mtime, state, scanned) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(file) DO UPDATE SET session=excluded.session, offset=excluded.offset, size=excluded.size, mtime=excluded.mtime, state=excluded.state, scanned=excluded.scanned`);

    function subagentFiles(transcript: string, id: string): string[] {
      const sub = path.join(path.dirname(transcript), id, "subagents");
      try { return fs.readdirSync(sub).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(sub, n)); } catch { return []; }
    }

    async function doScan(): Promise<ScanReport> {
      const t0 = Date.now();
      const rep: ScanReport = { at: now(), files: 0, scanned: 0, skipped: 0, found: 0, created: 0, updated: 0, commit: null, ms: 0 };
      const sessions = optional<any>("sessions");
      if (!sessions) { rep.error = "the sessions module is not loaded"; return rep; }
      try { await sessions.ready?.(); } catch { /* scan what is indexed */ }
      const days = ctx.config.backfill_days ?? 30;
      const list: any[] = sessions.list({ since: `${days}d`, limit: 5000 }).filter((s: any) => s.source === "claude" && s.transcript);
      admission.discover();
      const known = all();
      const files = new Set<string>();
      let createdIds: string[] = [];
      for (const s of list) {
        for (const file of [s.transcript, ...subagentFiles(s.transcript, s.id)]) {
          rep.files++;
          let st: fs.Stats;
          try { st = fs.statSync(file); } catch { continue; }
          const row = getScan.get(file) as { offset: number; size: number; mtime: number; state: string } | undefined;
          if (row && row.size === st.size && row.mtime === st.mtimeMs) { rep.skipped++; continue; }
          let offset = row && st.size >= row.offset ? row.offset : 0;
          let state: ScanState = newScanState();
          if (row && offset > 0) { try { state = JSON.parse(row.state); } catch { state = newScanState(); } }
          const found: Detected[] = [];
          try {
            const r = await readLines(file, offset, (line) => { try { found.push(...detectLine(line, state)); } catch { /* one bad line */ } });
            offset = r.end;
          } catch (e: any) { ctx.log(`artifacts: could not read ${file}: ${e.message}`); continue; }
          const pend = Object.entries(state.pending);
          if (pend.length > 50) state.pending = Object.fromEntries(pend.slice(-50));
          putScan.run(file, s.key, offset, st.size, st.mtimeMs, JSON.stringify(state), now());
          rep.scanned++;
          for (const d of found) {
            rep.found++;
            const source = { url: d.url, session: s.key, cwd: s.cwd, local_source: d.local_source };
            // Authored publishes remain available privately; other hiring links never enter.
            if (!admission.admits(source) && !(d.via === "artifact-tool" && admission.private(source) && !tombstoned(source, admission.policy))) continue;
            try {
              const r = upsert({
                url: d.url, local_source: d.local_source, title: d.title ?? (d.via === "artifact-tool" ? d.description : null), session: s.key,
                summary: d.description ?? undefined, kind: d.kind, source: "claude", created: d.ts ?? undefined, detected_from: d.via,
              }, known, { requireLocal: false });
              if (r.file) files.add(r.file);
              if (r.created) { rep.created++; createdIds.push(r.artifact.id); } else if (r.changed) rep.updated++;
            } catch (e: any) { ctx.log(`artifacts: skipped ${d.url}: ${e.message}`); }
          }
        }
      }
      if (files.size) {
        rep.commit = commit([...files], `artifacts: detected ${rep.created} new, ${rep.updated} updated from transcripts`);
        changed();
      }
      if (createdIds.length) { try { ctx.emit({ source: "artifacts", type: "artifact.detected", data: { ids: createdIds.slice(0, 200), count: createdIds.length } }); } catch { /* optional */ } }
      rep.ms = Date.now() - t0;
      last = rep;
      return rep;
    }
    const scan = () => { if (!scanning) scanning = doScan().finally(() => { scanning = null; }); return scanning; };

    // ---------- Firstmate reports ----------
    /** Marker in the brief, then the task's mission in the Firstmate projection, then the one open mission on the same repo. */
    function missionForReport(r: FmReport, strongOnly: boolean): string | null {
      const ms = optional<any>("missions");
      if (!ms) return null;
      const exists = (id: string | null | undefined) => { try { return id && ms.get(id) ? id : null; } catch { return null; } };
      const strong = exists(r.mission) ?? exists((() => { try { return optional<any>("firstmate")?.task?.(r.task)?.mission; } catch { return null; } })());
      if (strong || strongOnly || !r.repo) return strong;
      let hits: any[] = [];
      try { hits = (ms.list({ archive: false }) as any[]).filter((m) => (m.repos ?? []).some((p: string) => path.basename(p) === r.repo)); } catch { return null; }
      return hits.length === 1 ? hits[0].id : null;
    }

    let fmSyncing: Promise<FirstmateSyncReport> | null = null;
    let fmLast: FirstmateSyncReport | null = null;
    function doSyncFirstmate(): FirstmateSyncReport {
      const t0 = Date.now();
      const home = paths.firstmateHome;
      const rep: FirstmateSyncReport = { at: now(), home, reports: 0, created: 0, updated: 0, unchanged: 0, ids: [], commit: null, ms: 0 };
      let reports: FmReport[] = [];
      try { reports = readFirstmateReports(home); } catch (e: any) { rep.error = `Could not read Firstmate reports in ${home}: ${e.message}`; }
      rep.reports = reports.length;
      const known = all();
      const files: string[] = [];
      for (const r of reports) {
        const prior = findExisting(known, null, path.resolve(r.identity_file)) ?? findExisting(known, null, path.resolve(r.file));
        const origin: FirstmateOrigin = { task: r.task, final: r.final, task_title: r.task_title, heading: r.heading, status: r.status, decisions: r.decisions, followups: r.followups, modified: r.modified };
        try {
          const u = upsert({
            local_source: r.file, identity_source: r.identity_file, kind: "report", title: r.heading, source: "firstmate", detected_from: "firstmate",
            mission: missionForReport(r, Boolean(prior)), project: r.repo, created: prior ? undefined : r.modified, firstmate: origin,
          }, known, { requireLocal: false });
          rep.ids.push(u.artifact.id);
          if (u.file) files.push(u.file);
          if (u.created) rep.created++; else if (u.changed) rep.updated++; else rep.unchanged++;
        } catch (e: any) { ctx.log(`artifacts: skipped Firstmate report ${r.file}: ${e.message}`); }
      }
      if (files.length) {
        rep.commit = commit(files, `artifacts: Firstmate reports (${rep.created} new, ${rep.updated} updated)`);
        changed();
      }
      rep.ms = Date.now() - t0;
      fmLast = rep;
      return rep;
    }
    async function syncFirstmate(): Promise<FirstmateSyncReport> {
      if (!fmSyncing) fmSyncing = Promise.resolve().then(doSyncFirstmate).finally(() => { fmSyncing = null; });
      return fmSyncing;
    }

    const service: ArtifactsService = {
      list, get: (id) => { const a = readArtifact(dir(), id); return a ? view(a) : null; },
      register, update, scan, lastScan: () => last,
      syncFirstmate, lastFirstmateSync: () => fmLast, review,
    };
    ctx.services.set("artifacts", service);

    // ---------- routes ----------
    const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => {
      try { return await fn(c); } catch (e: any) { return c.json({ error: e.message }, e instanceof HttpError ? e.status : 500); }
    };
    app.get("/api/artifacts", (c) => c.json(list({
      mission: c.req.query("mission") || undefined, session: c.req.query("session") || undefined, kind: c.req.query("kind") || undefined,
      project: c.req.query("project") || undefined, q: c.req.query("q") || undefined, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    })));
    app.post("/api/artifacts", wrap(async (c) => {
      const b = await c.req.json().catch(() => null);
      const a = register(b);
      return c.json(a, a.deduped ? 200 : 201);
    }));
    app.get("/api/artifacts/review", (c) => {
      const num = (k: string) => { const v = Number(c.req.query(k)); return Number.isFinite(v) && c.req.query(k) ? v : undefined; };
      return c.json(review({
        source: c.req.query("source") || undefined, idea: c.req.query("idea") || undefined, q: c.req.query("q") || undefined,
        offset: num("offset"), limit: num("limit"),
      }));
    });
    app.get("/api/artifacts/admission", (c) => c.json(admission.policy));
    app.post("/api/artifacts/scan", wrap(async (c) => c.json(await scan())));
    app.get("/api/artifacts/scan", (c) => c.json(last));
    app.post("/api/artifacts/firstmate/scan", wrap(async (c) => c.json(await syncFirstmate())));
    app.get("/api/artifacts/firstmate", (c) => c.json(fmLast));
    app.get("/api/artifacts/:id", wrap((c) => {
      const a = service.get(c.req.param("id"));
      if (!a) throw new HttpError(404, `No artifact "${c.req.param("id")}".`);
      return c.json({ ...a, history: fileHistory(path.join(dir(), `${a.id}.md`), 20) });
    }));
    app.put("/api/artifacts/:id", wrap(async (c) => c.json(update(c.req.param("id"), (await c.req.json().catch(() => ({}))) ?? {}))));
    app.get("/api/artifacts/:id/reading", wrap((c) => {
      const a = mustGet(c.req.param("id"));
      if (!a.snapshot_blob || !isSha(a.snapshot_blob)) return c.json({ kind: "unavailable", reason: a.url ? "remote" : "missing" });
      let buf: Buffer;
      try { buf = fs.readFileSync(blobPath(a.snapshot_blob)); }
      catch { return c.json({ kind: "unavailable", reason: "missing" }); }
      const type = a.content_type ?? sniffType(buf.subarray(0, 4096));
      if (/^text\/markdown/.test(type)) return c.json({ kind: "markdown", text: buf.toString("utf8") });
      if (/^text\/html/.test(type)) return c.json({ kind: "html" });
      if (PREVIEWABLE.test(type)) return c.json({ kind: "preview", content_type: type });
      return c.json({ kind: "unavailable", reason: "unsupported" });
    }));
    app.get("/api/artifacts/:id/download", wrap((c) => {
      const a = mustGet(c.req.param("id"));
      if (!a.snapshot_blob || !isSha(a.snapshot_blob)) throw new HttpError(404, "No saved source. Register a readable local file first.");
      let buf: Buffer;
      try { buf = fs.readFileSync(blobPath(a.snapshot_blob)); }
      catch { throw new HttpError(404, "The saved source is missing. Re-register the local file."); }
      const type = a.content_type ?? sniffType(buf.subarray(0, 4096));
      const extensions: Record<string, string> = { "text/html": "html", "text/markdown": "md", "text/plain": "txt", "text/csv": "csv", "application/json": "json", "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
      const ext = extensions[type.split(";")[0]] ?? "bin";
      return new Response(new Uint8Array(buf), { headers: {
        "content-type": "application/octet-stream", "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${c.req.param("id")}.${ext}"`, "cache-control": "no-store",
      } });
    }));
    app.get("/api/artifacts/:id/text", wrap((c) => {
      // The snapshot as text, for reports the UI renders itself (markdown).
      const a = mustGet(c.req.param("id"));
      if (!a.snapshot_blob || !isSha(a.snapshot_blob)) throw new HttpError(404, "This artifact has no local snapshot to read.");
      const type = a.content_type ?? "";
      if (!/^(text\/(markdown|plain|csv)|application\/json)/.test(type)) throw new HttpError(415, "Only text snapshots can be read as text. Use the preview instead.");
      let text: string;
      try { text = fs.readFileSync(blobPath(a.snapshot_blob), "utf8"); } catch { throw new HttpError(404, "The snapshot blob is missing. Re-register the local file to take a new snapshot."); }
      return c.json({ id: a.id, content_type: type, text: truncate(text, 2_000_000) });
    }));
    app.get("/api/artifacts/:id/preview", wrap((c) => {
      const a = mustGet(c.req.param("id"));
      if (!a.snapshot_blob || !isSha(a.snapshot_blob)) throw new HttpError(404, "This artifact has no local snapshot. Open it at its link instead.");
      const file = blobPath(a.snapshot_blob);
      if (!fs.existsSync(file)) throw new HttpError(404, "The snapshot blob is missing. Re-register the local file to take a new snapshot.");
      const buf = fs.readFileSync(file);
      let type = a.content_type ?? sniffType(buf.subarray(0, 4096));
      let body: Uint8Array<ArrayBuffer> = new Uint8Array(buf);
      if (/^(text\/markdown|text\/plain|text\/csv|application\/json)/.test(type)) {
        // Plain text renders as a readable page inside the sandboxed frame.
        const esc = buf.toString("utf8").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        body = new Uint8Array(new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><title>${a.title.replace(/</g, "&lt;")}</title><style>body{margin:0;padding:24px 28px;background:#FBFBF7;color:#14213D;font:14px/1.6 "IBM Plex Mono",ui-monospace,Menlo,monospace}pre{white-space:pre-wrap;word-break:break-word;margin:0}</style><pre>${esc}</pre>`));
        type = "text/html; charset=utf-8";
      }
      if (c.req.query("expanded") === "1" && /^text\/html/.test(type)) {
        // Sandboxed frames have an opaque origin; forward Escape without granting same-origin access.
        const escape = `<script>addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();parent.postMessage('joyride:preview-escape','*')}if(event.key==='Tab'){const controls=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el=>el.tabIndex>=0&&el.getClientRects().length);if(!event.shiftKey&&(!controls.length||event.target===controls.at(-1))){event.preventDefault();parent.postMessage('joyride:preview-tab','*')}}},true)</script>`;
        const html = new TextDecoder().decode(body);
        const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
        body = new TextEncoder().encode(doctype + escape + html.slice(doctype.length));
      }
      const headers: Record<string, string> = { "content-type": type, "content-length": String(body.length), "x-content-type-options": "nosniff", "cache-control": "no-cache", "referrer-policy": "no-referrer" };
      if (SANDBOXED.test(type)) headers["content-security-policy"] = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox";
      return new Response(body, { headers });
    }));
  },

  start(ctx: Ctx) {
    try { repairArtifactSnapshots(ctx); } catch (e) { ctx.log(`artifacts: snapshot hygiene failed: ${e instanceof Error ? e.message : String(e)}`); }
    const svc = ctx.service<ArtifactsService>("artifacts");
    const run = () => svc.scan().catch((e: any) => ctx.log(`artifacts: scan failed: ${e.message}`));
    // First scan once sessions are indexed, then every 10 minutes and shortly after session changes.
    const first = setTimeout(run, process.env.JOYRIDE_TEST === "1" ? 50 : 5000);
    const every = setInterval(run, 10 * 60e3);
    let debounce: NodeJS.Timeout | null = null;
    const off = ctx.bus.onChange((ch) => {
      if (ch.entity !== "sessions") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(run, 15000);
      debounce.unref?.();
    });
    for (const t of [first, every]) t.unref?.();
    disposers.push(() => { clearTimeout(first); clearInterval(every); if (debounce) clearTimeout(debounce); off(); });

    // Firstmate reports: a cheap signature poll (reports, briefs, backlog) plus Firstmate's own task changes.
    let sig: string | null = null;
    let fmDebounce: NodeJS.Timeout | null = null;
    const fm = () => {
      let s = "";
      try { s = reportsSignature(paths.firstmateHome); } catch { return; }
      if (s === sig) return;
      sig = s;
      if (fmDebounce) clearTimeout(fmDebounce);
      fmDebounce = setTimeout(() => {
        fmDebounce = null;
        if (reportsSignature(paths.firstmateHome) !== sig) { fm(); return; }
        svc.syncFirstmate().catch((e: any) => ctx.log(`artifacts: Firstmate report sync failed: ${e.message}`));
      }, Number(process.env.JOYRIDE_FIRSTMATE_DEBOUNCE_MS ?? 1000));
      fmDebounce.unref?.();
    };
    const fmFirst = setTimeout(fm, process.env.JOYRIDE_TEST === "1" ? 50 : 3000);
    const fmEvery = setInterval(fm, Number(process.env.JOYRIDE_FIRSTMATE_POLL_MS ?? 5000));
    for (const t of [fmFirst, fmEvery]) t.unref?.();
    const offFm = ctx.bus.onChange((ch) => { if (ch.entity === "tasks" || ch.entity === "missions") { sig = null; } });
    disposers.push(() => { clearTimeout(fmFirst); clearInterval(fmEvery); if (fmDebounce) clearTimeout(fmDebounce); offFm(); });


  },

  stop() { while (disposers.length) { try { disposers.pop()!(); } catch { /* ignore */ } } },
});
