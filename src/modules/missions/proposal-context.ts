// Proposal context service: assembles what a proposal's sessions did (digests,
// files, commits, artifacts, live state, why grouped, noise) and keeps a cached
// heavy-LLM brief per proposal. Briefs are computed lazily when a proposal is
// opened and in a background batch for every pending proposal.
//   digests: kv "missions:digest:<session key>", keyed by transcript size + mtime (rebuildable)
//   briefs:  <runtime>/proposals/briefs/<proposal id>.json, keyed by session set + updated times
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx } from "../../core/context.ts";
import { knowledgePolicy } from "../../core/knowledge-policy.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { llm } from "../../core/llm.ts";
import { now, readJson, sha256, writeJsonAtomic } from "../../core/util.ts";
import { paths } from "../../shared/paths.ts";
import type { SessionItem, SessionsService } from "../sessions/types.ts";
import {
  BRIEF_BATCH, BRIEF_CONCURRENCY, BRIEF_SCHEMA, BRIEF_VERSION, DIGEST_VERSION, briefPrompt, cleanBrief, digestTranscript, fmtSpan,
  emptyDigest, mergeHookEvents, noiseOf, placeText, subagentFilesOf, whyGrouped, type Brief, type BriefInput, type Commit, type SessionDigest,
} from "./context.ts";
import type { StoredProposal } from "./store.ts";

export type LiveStatus = "working" | "blocked" | "idle";
export type SessionContext = {
  key: string; source: "claude" | "codex"; title: string; first_prompt: string; last_prompts: string[]; final_message: string;
  turns: number; tokens: number; started: string | null; updated: string | null; branch: string | null; cwd: string; model: string | null;
  live: LiveStatus | null; files: number; commits: number; missing: boolean;
};
export type FileTouch = { path: string; display: string; edits: number; sessions: number };
export type BriefStatus = "ready" | "stale" | "running" | "pending" | "failed" | "skipped";
export type BriefState = { brief: Brief | null; brief_status: BriefStatus; brief_at: string | null; brief_error: string | null };
export type ProposalContext = BriefState & {
  id: string; sessions: SessionContext[]; files: FileTouch[]; files_total: number; commits: (Commit & { session: string })[]; commits_total: number;
  artifacts: { id: string; title: string; url: string | null; kind: string; session: string | null }[];
  running: boolean; why: string[]; noise: boolean; noise_reason: string;
};
export type SummaryItem = BriefState & { id: string; noise: boolean; noise_reason: string; running: boolean; files: number; commits: number; recommended: boolean | null };
export type BriefStats = { calls: number; proposals: number; errors: number; ms: number; max_ms: number; prompt_chars: number };
export type BatchState = { running: boolean; total: number; done: number; calls: number; failed: number; started: string | null; finished: string | null; ms: number };
export type ProposalSummary = { items: SummaryItem[]; batch: BatchState; stats: BriefStats };

type Deps = { proposals: () => StoredProposal[]; get: (id: string) => StoredProposal | null; missionTitle: (id: string) => string | null };
type StoredBrief = { id: string; sig: string; brief: Brief; at: string; ms: number; batch: number };
type Prepared = { p: StoredProposal; items: SessionItem[]; digests: SessionDigest[]; live: (LiveStatus | null)[]; sig: string; noise: { noise: boolean; reason: string } };

const FAIL_RETRY_MS = 10 * 60e3;
const STALE_REFRESH_MS = 30 * 60e3;
const EMPTY_STATS = (): BriefStats => ({ calls: 0, proposals: 0, errors: 0, ms: 0, max_ms: 0, prompt_chars: 0 });

export class NotFound extends Error {}

export function createProposalContext(ctx: Ctx, deps: Deps) {
  const admission = knowledgePolicy(ctx);
  const sessions = (): SessionsService | undefined => ctx.services.get("sessions");
  const optional = (name: string): any => ctx.services.get(name);
  const briefDir = () => path.join(paths.proposals, "briefs");
  const briefFile = (id: string) => path.join(briefDir(), `${id}.json`);

  // ---------- digests ----------
  const mem = new Map<string, { sig: string; d: SessionDigest }>();
  let scanChain: Promise<unknown> = Promise.resolve();
  const hookEvents = (rawId: string) => {
    try {
      const rows = ctx.db.prepare("SELECT json FROM events WHERE type = 'tool.pre' AND session = ? ORDER BY ts LIMIT 20000").all(rawId) as { json: string }[];
      return rows.map((r) => { try { return JSON.parse(r.json).data ?? {}; } catch { return {}; } });
    } catch { return []; }
  };
  /** A session's digest; `stale` accepts any cached digest (cheap, for list-level noise). */
  async function digestOf(item: SessionItem, opts: { stale?: boolean } = {}): Promise<SessionDigest> {
    if (!admission.admits({ session: item.key, cwd: item.cwd })) {
      mem.delete(item.key);
      ctx.db.prepare("DELETE FROM kv WHERE k = ?").run(`missions:digest:${item.key}`);
      return emptyDigest();
    }
    let st: fs.Stats | null = null;
    try { st = item.transcript ? fs.statSync(item.transcript) : null; } catch {}
    const subs = item.source === "claude" && st ? subagentFilesOf(item.transcript, item.id) : [];
    let subSig = "";
    for (const f of subs) { try { const s = fs.statSync(f); subSig += `${s.size}:${s.mtimeMs},`; } catch {} }
    const sig = `${DIGEST_VERSION}|${item.transcript}|${st?.size ?? 0}|${st?.mtimeMs ?? 0}|${sha256(subSig).slice(0, 12)}`;
    const hit = mem.get(item.key);
    if (hit && (hit.sig === sig || opts.stale)) return hit.d;
    const kvKey = `missions:digest:${item.key}`;
    const stored = kvGet<{ sig: string; d: SessionDigest } | null>(ctx.db, kvKey, null);
    if (stored?.d?.v === DIGEST_VERSION && (stored.sig === sig || opts.stale)) { mem.set(item.key, stored); return stored.d; }
    const job = scanChain.then(async () => {
      const again = mem.get(item.key);
      if (again?.sig === sig) return again.d;
      // Hook events clip long inputs; they only stand in when the transcript gave nothing.
      const t = await digestTranscript(item.source, st ? item.transcript : null, subs, item.repo ?? item.cwd ?? null);
      const d = t.prompt_count || Object.keys(t.files).length || t.commits.length ? t : mergeHookEvents(t, hookEvents(item.id));
      mem.set(item.key, { sig, d });
      try { kvSet(ctx.db, kvKey, { sig, d }); } catch {}
      return d;
    });
    scanChain = job.catch(() => {});
    return job;
  }

  const liveOf = (key: string): LiveStatus | null => {
    try {
      const w = optional("workers")?.forSession?.(key);
      return w && (w.status === "working" || w.status === "blocked" || w.status === "idle") ? w.status : null;
    } catch { return null; }
  };

  const itemsOf = (p: StoredProposal): (SessionItem | null)[] => p.sessions.map((r) => { try { return sessions()?.get(`${r.source}:${r.id}`) ?? null; } catch { return null; } });
  const sigOf = (p: StoredProposal, items: (SessionItem | null)[]) =>
    sha256(`${BRIEF_VERSION}.${DIGEST_VERSION}|${JSON.stringify(admission.policy)}|${p.sessions.map((r, i) => `${r.source}:${r.id}@${items[i]?.updated ?? ""}`).sort().join(",")}`).slice(0, 16);

  async function prepare(p: StoredProposal, opts: { stale?: boolean } = {}): Promise<Prepared> {
    const all = itemsOf(p);
    const items = all.filter((x): x is SessionItem => Boolean(x && admission.admits({ session: x.key, cwd: x.cwd }))).sort((a, b) => a.started.localeCompare(b.started));
    const digests: SessionDigest[] = [];
    for (const it of items) digests.push(await digestOf(it, opts));
    const live = items.map((it) => liveOf(it.key));
    return { p, items, digests, live, sig: sigOf(p, all), noise: noiseOf(items.map((item, i) => ({ item, digest: digests[i] }))) };
  }

  // ---------- briefs ----------
  const readBrief = (id: string): StoredBrief | null => { const b = readJson<StoredBrief | null>(briefFile(id), null); return b?.brief ? b : null; };
  const inflight = new Map<string, Promise<void>>();
  const failures = new Map<string, { at: number; error: string }>();
  const stats: BriefStats = EMPTY_STATS();
  const batch: BatchState = { running: false, total: 0, done: 0, calls: 0, failed: 0, started: null, finished: null, ms: 0 };

  function briefState(pr: Prepared): BriefState {
    const stored = readBrief(pr.p.id);
    const fail = failures.get(pr.p.id);
    const status: BriefStatus = inflight.has(pr.p.id) ? "running"
      : stored && stored.sig === pr.sig ? "ready"
      : pr.noise.noise ? "skipped"
      : fail ? "failed"
      : stored ? "stale" : "pending";
    return { brief: stored?.brief ?? null, brief_status: status, brief_at: stored?.at ?? null, brief_error: status === "failed" ? fail?.error ?? null : null };
  }

  const relPath = (f: string, repo: string | null) => (repo && f.startsWith(repo + path.sep) ? path.relative(repo, f) : f.replace(os.homedir(), "~"));

  function briefInput(pr: Prepared, index: number): BriefInput {
    const repo = pr.p.repos[0] ?? null;
    const recent = pr.items.map((it, i) => ({ it, d: pr.digests[i], live: pr.live[i] })).slice(-12);
    return {
      index,
      place: placeText(pr.items[0] ?? null, repo),
      branch: pr.p.branches.join(", "),
      sessions: recent.map(({ it, d, live }) => {
        const first = d.first_prompt ?? it.first_prompt ?? "";
        return {
          title: it.title,
          first_prompt: first.slice(0, 300),
          later_prompts: d.last_prompts.filter((t) => t !== first).slice(-3).map((t) => t.slice(0, 200)),
          final_message: d.final_message.slice(0, 400),
          prompts: d.prompt_count || (it.turns ?? 0),
          active: fmtSpan(Math.max(0, Date.parse(it.updated) - Date.parse(it.started))) || "unknown",
          files_changed: Object.entries(d.files).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([f]) => relPath(f, repo)),
          commits: d.commits.slice(-6).map((c) => c.subject),
          still_running: live === "working" || live === "blocked",
        };
      }),
    };
  }

  /** One model call for up to BRIEF_BATCH proposals. */
  async function callBriefs(list: Prepared[]): Promise<void> {
    if (!list.length) return;
    const prompt = briefPrompt(list.map((pr, i) => briefInput(pr, i)));
    const t0 = Date.now();
    stats.calls++; stats.proposals += list.length; stats.prompt_chars += prompt.length;
    try {
      const r = await llm<{ briefs: any[] }>(prompt, { task: "proposal_brief", schema: BRIEF_SCHEMA, timeoutMs: 240_000 });
      const ms = Date.now() - t0;
      stats.ms += ms; stats.max_ms = Math.max(stats.max_ms, ms);
      const got: any[] = Array.isArray(r?.briefs) ? r.briefs : Array.isArray(r) ? (r as any[]) : [];
      list.forEach((pr, i) => {
        const b = cleanBrief(got.find((x) => x?.index === i) ?? (got.length === list.length ? got[i] : null));
        if (!b) { failures.set(pr.p.id, { at: Date.now(), error: "The model returned no usable brief for this proposal." }); return; }
        failures.delete(pr.p.id);
        writeJsonAtomic(briefFile(pr.p.id), { id: pr.p.id, sig: pr.sig, brief: b, at: now(), ms, batch: list.length } satisfies StoredBrief);
      });
    } catch (e: any) {
      stats.errors++;
      stats.ms += Date.now() - t0;
      const error = `The brief could not be written: ${String(e?.message ?? e).slice(0, 200)}`;
      for (const pr of list) failures.set(pr.p.id, { at: Date.now(), error });
      ctx.log(`missions: proposal brief call failed for ${list.length}: ${e?.message ?? e}`);
    } finally {
      for (const pr of list) ctx.bus.change({ entity: "proposal_briefs", id: pr.p.id });
    }
  }

  function track(list: Prepared[], job: Promise<void>) {
    for (const pr of list) inflight.set(pr.p.id, job);
    job.finally(() => { for (const pr of list) if (inflight.get(pr.p.id) === job) inflight.delete(pr.p.id); }).catch(() => {});
    return job;
  }

  /** Lazy path: brief one proposal now unless it is fresh, running, noise, or failed recently. */
  function ensureBrief(pr: Prepared, opts: { retry?: boolean } = {}): Promise<void> | null {
    const running = inflight.get(pr.p.id);
    if (running) return running;
    if (pr.noise.noise) return null;
    const stored = readBrief(pr.p.id);
    if (stored && stored.sig === pr.sig) return null;
    const fail = failures.get(pr.p.id);
    if (fail && !opts.retry && Date.now() - fail.at < FAIL_RETRY_MS) return null;
    const job = callBriefs([pr]);
    track([pr], job);
    ctx.bus.change({ entity: "proposal_briefs", id: pr.p.id });
    return job;
  }

  let batchP: Promise<BatchState> | null = null;
  /** Background batch: every pending, non-noise proposal without a fresh brief; BRIEF_BATCH per call, BRIEF_CONCURRENCY calls at once. */
  function runBriefs(): Promise<BatchState> {
    if (batchP) return batchP;
    batchP = (async () => {
      const s = sessions();
      if (!s) return batch;
      await s.ready();
      const t0 = Date.now();
      const todo: Prepared[] = [];
      for (const p of deps.proposals()) {
        if (p.status !== "pending" || inflight.has(p.id)) continue;
        const pr = await prepare(p);
        if (pr.noise.noise) continue;
        const stored = readBrief(p.id);
        if (stored && (stored.sig === pr.sig || Date.now() - Date.parse(stored.at) < STALE_REFRESH_MS)) continue;
        const fail = failures.get(p.id);
        if (fail && Date.now() - fail.at < FAIL_RETRY_MS) continue;
        todo.push(pr);
      }
      if (!todo.length) return batch;
      Object.assign(batch, { running: true, total: todo.length, done: 0, calls: 0, failed: 0, started: now(), finished: null, ms: 0 });
      ctx.bus.change({ entity: "proposal_briefs" });
      const chunks: Prepared[][] = [];
      for (let i = 0; i < todo.length; i += BRIEF_BATCH) chunks.push(todo.slice(i, i + BRIEF_BATCH));
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const chunk = chunks[next++].filter((pr) => !inflight.has(pr.p.id));
          if (!chunk.length) continue;
          batch.calls++;
          await track(chunk, callBriefs(chunk));
          batch.done += chunk.length;
          batch.failed += chunk.filter((pr) => failures.has(pr.p.id)).length;
        }
      };
      await Promise.all(Array.from({ length: Math.min(BRIEF_CONCURRENCY, chunks.length) }, worker));
      Object.assign(batch, { running: false, finished: now(), ms: Date.now() - t0 });
      ctx.log(`missions: proposal briefs for ${batch.done} proposals in ${batch.calls} calls (${batch.ms}ms, ${batch.failed} failed)`);
      ctx.bus.change({ entity: "proposal_briefs" });
      return batch;
    })().catch((e) => { ctx.log(`missions: proposal brief batch failed: ${e?.message ?? e}`); batch.running = false; return batch; })
      .finally(() => { batchP = null; });
    return batchP;
  }

  let timer: NodeJS.Timeout | null = null;
  function scheduleBatch(delayMs = 2000) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; runBriefs().catch(() => {}); }, delayMs);
    timer.unref?.();
  }

  // ---------- assembly ----------
  async function context(id: string, opts: { wait?: boolean; retry?: boolean } = {}): Promise<ProposalContext> {
    const p = deps.get(id);
    if (!p) throw new NotFound(`No proposal ${id}.`);
    await sessions()?.ready();
    const pr = await prepare(p);
    const job = p.status === "pending" ? ensureBrief(pr, opts) : null;
    if (job && opts.wait) await job;
    const repo = p.repos[0] ?? null;

    const byKey = new Map(pr.items.map((it, i) => [it.key, i]));
    const sessionsOut: SessionContext[] = p.sessions.map((r) => {
      const key = `${r.source}:${r.id}`;
      const i = byKey.get(key);
      if (i === undefined) {
        return { key, source: r.source, title: "Transcript no longer available", first_prompt: "", last_prompts: [], final_message: "", turns: 0, tokens: 0, started: null, updated: null, branch: null, cwd: "", model: null, live: null, files: 0, commits: 0, missing: true };
      }
      const it = pr.items[i], d = pr.digests[i];
      const first = d.first_prompt ?? it.first_prompt ?? "";
      return {
        key, source: it.source, title: it.title, first_prompt: first, last_prompts: d.last_prompts.filter((t) => t !== first).slice(-3),
        final_message: d.final_message, turns: d.prompt_count || (it.turns ?? 0), tokens: it.tokens ?? 0, started: it.started, updated: it.updated,
        branch: it.branch, cwd: it.cwd, model: it.model, live: pr.live[i], files: Object.keys(d.files).length, commits: d.commits.length, missing: false,
      };
    }).sort((a, b) => (a.started ?? "").localeCompare(b.started ?? ""));

    const files = new Map<string, { edits: number; sessions: number }>();
    const commits: (Commit & { session: string })[] = [];
    pr.items.forEach((it, i) => {
      for (const [f, n] of Object.entries(pr.digests[i].files)) { const e = files.get(f) ?? { edits: 0, sessions: 0 }; e.edits += n; e.sessions++; files.set(f, e); }
      for (const c of pr.digests[i].commits) {
        if (commits.some((x) => (c.sha && x.sha === c.sha) || (!c.sha && x.subject === c.subject))) continue;
        commits.push({ ...c, session: it.key });
      }
    });
    const fileList = [...files.entries()].map(([f, e]) => ({ path: f, display: relPath(f, repo), ...e }))
      .sort((a, b) => b.edits - a.edits || b.sessions - a.sessions || a.display.localeCompare(b.display));

    const artifacts: ProposalContext["artifacts"] = [];
    const arts = optional("artifacts");
    if (arts?.list) {
      for (const it of pr.items) {
        try {
          for (const a of arts.list({ session: it.key }) ?? []) if (admission.admits(a) && !artifacts.some((x) => x.id === a.id)) artifacts.push({ id: a.id, title: a.title, url: a.url ?? null, kind: a.kind, session: a.session ?? null });
        } catch {}
      }
    }

    return {
      id, sessions: sessionsOut, files: fileList.slice(0, 8), files_total: fileList.length, commits: commits.slice(-6).reverse(), commits_total: commits.length, artifacts: artifacts.slice(0, 8),
      running: pr.live.some((l) => l === "working" || l === "blocked"),
      why: whyGrouped(p, pr.items, p.merge_into ? deps.missionTitle(p.merge_into) : null),
      noise: pr.noise.noise, noise_reason: pr.noise.reason,
      ...briefState(pr),
    };
  }

  async function summary(): Promise<ProposalSummary> {
    await sessions()?.ready();
    const items: SummaryItem[] = [];
    for (const p of deps.proposals()) {
      if (p.status !== "pending") continue;
      const pr = await prepare(p, { stale: true });
      const st = briefState(pr);
      items.push({
        id: p.id, noise: pr.noise.noise, noise_reason: pr.noise.reason,
        running: pr.live.some((l) => l === "working" || l === "blocked"),
        files: new Set(pr.digests.flatMap((d) => Object.keys(d.files))).size,
        commits: pr.digests.reduce((n, d) => n + d.commits.length, 0),
        recommended: st.brief ? st.brief.worth_tracking : null,
        ...st,
      });
    }
    return { items, batch: { ...batch }, stats: { ...stats } };
  }

  /** Resolves when no batch or lazy brief is running (tests). */
  async function idle() {
    for (let i = 0; i < 50; i++) {
      const jobs = [...(batchP ? [batchP] : []), ...inflight.values()];
      if (!jobs.length && !timer) return;
      if (timer && !jobs.length) { clearTimeout(timer); timer = null; await runBriefs(); continue; }
      await Promise.allSettled(jobs);
    }
  }

  const dispose = () => { if (timer) clearTimeout(timer); timer = null; };
  return { context, summary, runBriefs, scheduleBatch, idle, dispose, digestOf, stats: () => ({ ...stats }), batch: () => ({ ...batch }) };
}

export type ProposalContextService = ReturnType<typeof createProposalContext>;
