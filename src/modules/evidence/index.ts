// Evidence (DESIGN §8): attested records from `joyride-evidence` (via the
// event log), inferred test runs mined from hook events and transcripts, a
// content-addressed blob store, and Jev verdicts against a mission's
// done_when. Screenshot captions may only downgrade a pass.
import fs from "node:fs";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { DoneCriterion, EvidenceItem, type EventRecord, type Verdict } from "../../shared/schema.ts";
import { jev, jevAvailable, pick, probs, yes } from "../../core/jev.ts";
import { llm } from "../../core/llm.ts";
import { fakeModels, registerLlmFake } from "../../core/fakes.ts";
import { paths } from "../../shared/paths.ts";
import { ensureDir, now, rid, truncate } from "../../core/util.ts";
import { blobPath, extFor, isSha, sniffType } from "./blobs.ts";
import { commandOf, parseTestSummary, tailOf, testCommandName } from "./parse.ts";
import { sessionKeyOf } from "../attention/classify.ts";
import * as V from "./verdict.ts";

const SHELL_TOOLS = /^(Bash|shell|exec_command|local_shell|unified_exec|container\.exec)$/;
const MAX_CAPTIONS = 6;

export type VerdictRecord = Omit<Verdict, "per_criterion"> & { per_criterion: V.CriterionResult[]; reason?: string };
export type EvidenceFilter = { mission?: string; session?: string; limit?: number };
export type EvidenceService = {
  list(f?: EvidenceFilter): EvidenceItem[];
  get(id: string): EvidenceItem | null;
  add(item: Partial<EvidenceItem> & { name: string }): EvidenceItem;
  verdict(missionId: string, opts?: { done_when?: unknown[]; evidence?: string[] }): Promise<VerdictRecord>;
  latestVerdict(missionId: string): VerdictRecord | null;
  verdicts(missionId?: string, limit?: number): VerdictRecord[];
};

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export default defineModule({
  name: "evidence",
  order: 60,
  migrations: {
    "001": `CREATE TABLE evidence (id TEXT PRIMARY KEY, mode TEXT NOT NULL, name TEXT NOT NULL, session TEXT, mission TEXT, created TEXT NOT NULL,
              exit_code INTEGER, transcript TEXT, tool_use_id TEXT, json TEXT NOT NULL);
            CREATE INDEX evidence_mission ON evidence(mission, created);
            CREATE INDEX evidence_session ON evidence(session, created);
            CREATE TABLE verdicts (id TEXT PRIMARY KEY, mission TEXT NOT NULL, created TEXT NOT NULL, verdict TEXT NOT NULL, json TEXT NOT NULL);
            CREATE INDEX verdicts_mission ON verdicts(mission, created);`,
  },
  register(ctx: Ctx) {
    const { db, app } = ctx;
    if (fakeModels()) {
      // Neutral default; tests override it to exercise caption downgrades.
      registerLlmFake("screenshot_caption", (prompt) => `The screenshot ${prompt.match(/\(([^)]+)\)/)?.[1] ?? ""} shows the page rendered normally.`);
    }

    const parse = (row: any): EvidenceItem => JSON.parse(row.json);
    const get = (id: string): EvidenceItem | null => { const r = db.prepare("SELECT json FROM evidence WHERE id = ?").get(id); return r ? parse(r) : null; };
    function upsert(ev: EvidenceItem, extra: { transcript?: string | null; tool_use_id?: string | null } = {}) {
      db.prepare(`INSERT INTO evidence(id, mode, name, session, mission, created, exit_code, transcript, tool_use_id, json)
                  VALUES (@id, @mode, @name, @session, @mission, @created, @exit_code, @transcript, @tool_use_id, @json)
                  ON CONFLICT(id) DO UPDATE SET mode=excluded.mode, name=excluded.name, session=excluded.session, mission=excluded.mission,
                    exit_code=excluded.exit_code, json=excluded.json, transcript=coalesce(excluded.transcript, evidence.transcript),
                    tool_use_id=coalesce(excluded.tool_use_id, evidence.tool_use_id)`)
        .run({ id: ev.id, mode: ev.mode, name: ev.name, session: ev.session, mission: ev.mission, created: ev.created, exit_code: ev.exit_code,
          transcript: extra.transcript ?? null, tool_use_id: extra.tool_use_id ?? null, json: JSON.stringify(ev) });
    }
    const changed = (entity: string, id?: string) => ctx.bus.change({ entity, id });

    const missionOf = (session: string | null): string | null => {
      if (!session) return null;
      try { return ctx.service<any>("missions").missionOfSession(session) ?? null; } catch { return null; }
    };
    async function missionGet(id: string): Promise<any | null> {
      try { return (await ctx.service<any>("missions").get(id)) ?? null; } catch { return null; }
    }
    const sessionKeys = (m: any): string[] => (Array.isArray(m?.sessions) ? m.sessions.map((s: any) => (typeof s === "string" ? s : `${s.source}:${s.id}`)) : []);

    function list(f: EvidenceFilter = {}, keys: string[] = []): EvidenceItem[] {
      const limit = Math.min(f.limit ?? 200, 2000);
      const where: string[] = [], args: any[] = [];
      if (f.mission) {
        if (!keys.length) {
          try { const m = ctx.service<any>("missions").get(f.mission); if (m && typeof m.then !== "function") keys = sessionKeys(m); } catch { /* missions absent */ }
        }
        where.push(`(mission = ?${keys.length ? ` OR session IN (${keys.map(() => "?").join(",")})` : ""})`);
        args.push(f.mission, ...keys);
      }
      if (f.session) { where.push("session = ?"); args.push(f.session); }
      return (db.prepare(`SELECT json FROM evidence ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC LIMIT ?`).all(...args, limit) as any[]).map(parse);
    }

    function normalize(partial: Partial<EvidenceItem> & { name: string }, mode: "attested" | "inferred" = "attested"): EvidenceItem {
      const session = partial.session ?? null;
      return EvidenceItem.parse({
        command: "", log_tail: "", log_blob: null, screenshots: [], assertions: null, claim: "", cwd: "", branch: null, sha: null, exit_code: null,
        ...partial,
        id: partial.id ?? rid("evd_"), mode: partial.mode ?? mode, session, mission: partial.mission ?? missionOf(session), created: partial.created ?? now(),
      });
    }

    function add(partial: Partial<EvidenceItem> & { name: string }): EvidenceItem {
      if (!partial?.name) throw new HttpError(400, "Evidence needs a name, for example \"unit tests\".");
      const item = normalize(partial);
      upsert(item);
      try { ctx.emit({ source: "evidence", type: "evidence.added", session: item.session?.replace(/^(claude|codex):/, ""), agent: item.session?.startsWith("codex:") ? "codex" : item.session ? "claude" : undefined, cwd: item.cwd || undefined, data: { item } }); }
      catch (e: any) { ctx.log(`evidence emit failed: ${e.message}`); }
      changed("evidence", item.id);
      return item;
    }

    // ---------- inferred evidence ----------
    /** Fill exit code, log tail and assertions from the transcript's tool result. */
    function enrich(id: string): EvidenceItem | null {
      const row = db.prepare("SELECT json, transcript, tool_use_id FROM evidence WHERE id = ?").get(id) as any;
      if (!row) return null;
      const ev = parse(row);
      if (ev.exit_code != null || !row.transcript || !row.tool_use_id) return ev;
      try {
        if (!fs.existsSync(row.transcript) || fs.statSync(row.transcript).size > 80 * 1024 * 1024) return ev;
        const text = fs.readFileSync(row.transcript, "utf8");
        const found = toolResult(text, row.tool_use_id);
        if (!found) return ev;
        const next = { ...ev, exit_code: found.exit, log_tail: tailOf(found.output, 4096), assertions: parseTestSummary(found.output) ?? ev.assertions };
        upsert(next);
        changed("evidence", id);
        return next;
      } catch (e: any) { ctx.log(`evidence: could not read transcript for ${id}: ${e.message}`); return ev; }
    }

    function enrichSession(key: string | null) {
      if (!key) return;
      for (const r of db.prepare("SELECT id FROM evidence WHERE session = ? AND mode = 'inferred' AND exit_code IS NULL AND transcript IS NOT NULL").all(key) as any[]) enrich(r.id);
    }

    function onToolPre(e: EventRecord) {
      const d = e.data ?? {};
      if (!SHELL_TOOLS.test(String(d.tool ?? ""))) return;
      const cmd = commandOf(d.input);
      const name = testCommandName(cmd);
      if (!name) return;
      const key = sessionKeyOf(e);
      const id = `inf_${e.id}`;
      if (get(id)) return;
      const item = normalize({ id, name, command: cmd, session: key, cwd: e.cwd ?? "", created: e.ts, claim: "", mode: "inferred" }, "inferred");
      upsert(item, { transcript: typeof d.transcript === "string" ? d.transcript : null, tool_use_id: typeof d.tool_use_id === "string" ? d.tool_use_id : null });
      changed("evidence", id);
    }

    ctx.bus.onEvent((e) => {
      try {
        if (e.type === "evidence.added") {
          const parsed = EvidenceItem.safeParse(e.data?.item);
          if (!parsed.success) { ctx.log(`evidence: ignored a malformed evidence.added event ${e.id}`); return; }
          const item = parsed.data;
          if (!item.mission) item.mission = missionOf(item.session);
          upsert(item);
          changed("evidence", item.id);
        } else if (e.source?.startsWith("hook.")) {
          if (e.type === "tool.pre") onToolPre(e);
          else if (e.type === "turn.stop") enrichSession(sessionKeyOf(e));
        }
      } catch (err: any) { ctx.log(`evidence: ${e.type} handler failed: ${err.message}`); }
    });

    // ---------- captions ----------
    async function captionsFor(evidence: EvidenceItem[]): Promise<{ name: string; caption: string }[]> {
      const out: { name: string; caption: string }[] = [];
      for (const ev of evidence) {
        let dirty = false;
        for (const s of ev.screenshots) {
          if (out.length >= MAX_CAPTIONS) break;
          if (!s.caption) {
            try {
              const file = blobPath(s.blob);
              if (!fs.existsSync(file)) continue;
              const type = sniffType(fs.readFileSync(file).subarray(0, 64));
              if (!type.startsWith("image/")) continue;
              const shots = ensureDir(path.join(paths.llmCwd, "shots"));
              const img = path.join(shots, `${s.blob}${extFor(type)}`);
              if (!fs.existsSync(img)) fs.copyFileSync(file, img);
              const text = await llm<string>(
                `Describe this screenshot (${s.name}), taken by the check "${ev.name}", in one or two plain sentences: which screen it shows, and whether anything looks broken, empty or shows an error. Describe only what is visible.`,
                { task: "screenshot_caption", images: [img], timeoutMs: 120000 },
              );
              s.caption = truncate(String(text ?? "").trim(), 400) || null;
              dirty = true;
            } catch (e: any) { ctx.log(`evidence: caption failed for ${s.name}: ${e.message}`); continue; }
          }
          if (s.caption) out.push({ name: s.name, caption: s.caption });
        }
        if (dirty) { upsert(ev); changed("evidence", ev.id); }
      }
      return out;
    }

    // ---------- verdicts ----------
    const toCriteria = (raw: unknown[]): V.Criterion[] => raw.map((c, i) => {
      if (typeof c === "string") return { id: `c${i + 1}`, text: c, kind: "other" as const };
      const p = DoneCriterion.safeParse({ id: `c${i + 1}`, ...(c as object) });
      return p.success ? p.data : { id: `c${i + 1}`, text: String((c as any)?.text ?? JSON.stringify(c)), kind: "other" as const };
    });

    async function judge(c: V.Criterion, evidence: EvidenceItem[]): Promise<V.CriterionResult & { downgraded?: boolean }> {
      const base = { id: c.id, criterion: c.text, kind: c.kind };
      if (!evidence.length) return { ...base, verdict: "insufficient", reason: "no evidence was recorded for this mission" };
      if (!jevAvailable()) return { ...base, verdict: "insufficient", reason: "Jev is unavailable; set JEV_API_KEY in .env to judge evidence" };
      try {
        const r = await jev({ criterion: c.text, kind: c.kind, evidence: evidence.map(V.summarize) }, V.verdictQuestion(), { timeoutMs: 20000, retries: 2 });
        const choice = pick(r, "verdict");
        const p = probs(r, "verdict");
        let verdict: V.V = choice === "pass" || choice === "fail" || choice === "insufficient" ? choice : "insufficient";
        let reason = `Jev judged ${verdict}`;
        if (verdict === "pass") { const g = V.guardPass(c, evidence); if (g) { verdict = "insufficient"; reason = `Jev judged pass, but ${g}`; } }
        const res: V.CriterionResult & { downgraded?: boolean } = { ...base, verdict, p: p[verdict] ?? r.answers.verdict?.confidence, probabilities: p, reason };
        if (verdict === "pass" && (c.kind === "screenshot" || c.kind === "e2e")) {
          const caps = await captionsFor(evidence);
          res.captions = caps.map((x) => `${x.name}: ${x.caption}`);
          if (caps.length) {
            const cr = await jev({ criterion: c.text, captions: res.captions }, V.captionQuestion(), { timeoutMs: 15000, retries: 2 });
            const cp = yes(cr, "contradicts");
            res.caption_p = cp;
            if (cp != null && cp > 0.5) { res.verdict = "insufficient"; res.reason = "a screenshot caption contradicts the criterion"; res.downgraded = true; }
          }
        }
        return res;
      } catch (e: any) {
        return { ...base, verdict: "insufficient", reason: `Jev could not judge this criterion: ${truncate(e.message, 200)}` };
      }
    }

    function raiseAttention(vd: VerdictRecord, title: string) {
      let att: any;
      try { att = ctx.service<any>("attention"); } catch { return; }
      try {
        const dedupe = `verdict:${vd.mission}`;
        const firstBad = vd.per_criterion.find((r) => r.verdict === "fail");
        if (vd.verdict === "pass") {
          att.raise({ level: "L2", kind: "review", title: `Ready to close: ${title}`, why: `All ${vd.per_criterion.length} done-when criteria pass with evidence.`, mission: vd.mission, session: null, dedupe, ref: { verdict: vd.id, mission: vd.mission } });
        } else if (vd.verdict === "fail") {
          att.raise({ level: "L3", kind: "review", title: `Checks fail: ${title}`, why: truncate(`${firstBad?.criterion ?? "A criterion"}: ${firstBad?.reason ?? "failed"}`, 240), mission: vd.mission, session: null, dedupe, ref: { verdict: vd.id, mission: vd.mission } });
        } else {
          for (const it of att.list({ open: true, include_snoozed: true, kind: "review" })) if (it.ref?.verdict && it.ref?.mission === vd.mission) att.resolve(it.id, "superseded by an insufficient verdict");
        }
      } catch (e: any) { ctx.log(`evidence: could not raise attention: ${e.message}`); }
    }

    async function verdict(missionId: string, opts: { done_when?: unknown[]; evidence?: string[] } = {}): Promise<VerdictRecord> {
      const mission = await missionGet(missionId);
      const rawCriteria = opts.done_when ?? mission?.done_when;
      if (!mission && !rawCriteria) throw new HttpError(404, `No mission "${missionId}". Create it first, or pass done_when in the request body.`);
      const criteria = toCriteria(rawCriteria ?? []);
      let evidence = opts.evidence?.length
        ? opts.evidence.map((id) => get(id)).filter((x): x is EvidenceItem => Boolean(x))
        : list({ mission: missionId, limit: 500 }, sessionKeys(mission));
      evidence = evidence.map((ev) => (ev.mode === "inferred" && ev.exit_code == null ? enrich(ev.id) ?? ev : ev));
      evidence = V.latestPerName(evidence, 400);
      const results: (V.CriterionResult & { downgraded?: boolean })[] = [];
      const used = new Set<string>();
      for (const c of criteria) {
        const rel = V.relevantFor(c, evidence);
        rel.forEach((e) => used.add(e.id));
        results.push(await judge(c, rel));
      }
      const overall = V.aggregate(results);
      const classes: V.V[] = ["pass", "fail", "insufficient"];
      const withP = results.filter((r) => r.probabilities && Object.keys(r.probabilities).length);
      const probabilities = withP.length ? Object.fromEntries(classes.map((k) => [k, withP.reduce((a, r) => a + (r.probabilities![k] ?? 0), 0) / withP.length])) : {};
      const ps = results.map((r) => r.p).filter((x): x is number => typeof x === "number");
      const vd: VerdictRecord = {
        id: rid("vd_"), mission: missionId, verdict: overall, probabilities, confidence: ps.length ? Math.min(...ps) : null,
        per_criterion: results.map(({ downgraded, ...r }) => r), downgraded_by_caption: results.some((r) => r.downgraded),
        evidence: evidence.filter((e) => used.has(e.id)).map((e) => e.id), created: now(),
        reason: criteria.length ? undefined : "the mission has no done_when criteria",
      };
      db.prepare("INSERT INTO verdicts(id, mission, created, verdict, json) VALUES (?,?,?,?,?)").run(vd.id, vd.mission, vd.created, vd.verdict, JSON.stringify(vd));
      try { ctx.emit({ source: "evidence", type: "evidence.verdict", data: { verdict: vd } }); } catch (e: any) { ctx.log(`evidence emit failed: ${e.message}`); }
      changed("verdicts", vd.id);
      raiseAttention(vd, mission?.title ?? missionId);
      return vd;
    }
    const verdicts = (missionId?: string, limit = 50): VerdictRecord[] =>
      (db.prepare(`SELECT json FROM verdicts ${missionId ? "WHERE mission = ?" : ""} ORDER BY created DESC LIMIT ?`).all(...(missionId ? [missionId, limit] : [limit])) as any[]).map((r) => JSON.parse(r.json));
    const latestVerdict = (missionId: string) => verdicts(missionId, 1)[0] ?? null;

    const service: EvidenceService = { list: (f) => list(f), get, add, verdict, latestVerdict, verdicts };
    ctx.services.set("evidence", service);

    // ---------- routes ----------
    const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => {
      try { return await fn(c); } catch (e: any) { return c.json({ error: e.message }, e instanceof HttpError ? e.status : 500); }
    };
    app.get("/api/evidence", (c) => c.json(list({ mission: c.req.query("mission") || undefined, session: c.req.query("session") || undefined, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined })));
    app.post("/api/evidence", wrap(async (c) => c.json(add(await c.req.json()))));
    app.get("/api/evidence/blob/:sha", (c) => {
      const sha = c.req.param("sha");
      if (!isSha(sha)) return c.json({ error: "A blob id is a 64-character sha256." }, 400);
      const file = blobPath(sha);
      if (!fs.existsSync(file)) return c.json({ error: "No such blob. It may have been recorded on another machine." }, 404);
      const buf = fs.readFileSync(file);
      return new Response(new Uint8Array(buf), { headers: { "content-type": sniffType(buf), "content-length": String(buf.length), "cache-control": "public, max-age=31536000, immutable" } });
    });
    app.get("/api/evidence/verdicts", (c) => c.json(verdicts(c.req.query("mission") || undefined, Number(c.req.query("limit") ?? 50))));
    app.get("/api/evidence/verdict/:mission", (c) => c.json(latestVerdict(c.req.param("mission"))));
    app.post("/api/evidence/verdict/:mission", wrap(async (c) => {
      const b = await c.req.json().catch(() => ({}));
      return c.json(await verdict(c.req.param("mission"), { done_when: Array.isArray(b.done_when) ? b.done_when : undefined, evidence: Array.isArray(b.evidence) ? b.evidence : undefined }));
    }));
    app.get("/api/evidence/:id", (c) => { const ev = get(c.req.param("id")); return ev ? c.json(ev) : c.json({ error: "No such evidence record." }, 404); });
  },

  start(ctx) {
    // Re-verify is an intent; register when the intents service exists.
    try {
      const intents = ctx.service<any>("intents");
      intents.registerHandler("reverify", async (intent: any) => {
        const mission = intent?.payload?.mission ?? intent?.target;
        if (!mission) throw new Error("reverify needs a mission id in payload.mission");
        return ctx.service<EvidenceService>("evidence").verdict(String(mission));
      });
    } catch { ctx.log("evidence: intents service not available; reverify intent not registered"); }
  },
});

/** Locate a tool result for `id` in a Claude Code or Codex transcript. */
export function toolResult(text: string, id: string): { exit: number; output: string } | null {
  let from = text.length;
  while (from > 0) {
    const at = text.lastIndexOf(id, from);
    if (at < 0) return null;
    const start = text.lastIndexOf("\n", at) + 1;
    const endNl = text.indexOf("\n", at);
    const line = text.slice(start, endNl < 0 ? text.length : endNl);
    from = start - 1;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    // Claude Code: user message with a tool_result block (+ toolUseResult {stdout, stderr}).
    const blocks = Array.isArray(obj?.message?.content) ? obj.message.content : [];
    const tr = blocks.find((b: any) => b?.type === "tool_result" && b.tool_use_id === id);
    if (tr) {
      const content = typeof tr.content === "string" ? tr.content : Array.isArray(tr.content) ? tr.content.map((x: any) => x?.text ?? "").join("\n") : "";
      const tur = obj.toolUseResult && typeof obj.toolUseResult === "object" ? obj.toolUseResult : null;
      const output = tur && (tur.stdout || tur.stderr) ? [tur.stdout, tur.stderr].filter(Boolean).join("\n") : content;
      const m = content.match(/Exit code (\d+)/i);
      const exit = tr.is_error ? (m ? Number(m[1]) : 1) : 0;
      return { exit, output: output || content };
    }
    // Codex rollout: function_call_output with metadata.exit_code.
    const p = obj?.payload ?? obj;
    if ((p?.type === "function_call_output" || p?.type === "custom_tool_call_output") && p.call_id === id) {
      let out: any = p.output;
      try { out = typeof out === "string" ? JSON.parse(out) : out; } catch { /* plain text */ }
      const output = typeof out === "string" ? out : String(out?.output ?? "");
      const exitRaw = out?.metadata?.exit_code ?? output.match(/(?:Exit code|exit_code)[:\s]+(\d+)/i)?.[1];
      return { exit: exitRaw != null ? Number(exitRaw) : 0, output };
    }
  }
  return null;
}
