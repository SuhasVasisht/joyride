// Blast-radius guard: the PreToolUse hook files requests here and long-polls;
// the human decides in the approvals tray. Gated actions fail closed.
import fs from "node:fs";
import { defineModule, type Ctx } from "../../core/context.ts";
import { GuardRequest } from "../../shared/schema.ts";
import { paths } from "../../shared/paths.ts";
import { now, rid, truncate } from "../../core/util.ts";
import { writeCompiled } from "./compile.ts";
import { jev, jevAvailable, q, yes } from "../../core/jev.ts";

type AllowRule = { id: string; rule: string; scope_type: "session" | "mission" | "global"; scope_value: string; expires: string | null; created: string };

export type GuardService = {
  pending(): GuardRequest[];
  get(id: string): GuardRequest | null;
  decide(id: string, decision: "allow" | "deny", reason?: string, remember?: { scope: "session" | "mission" | "global"; hours?: number }): GuardRequest;
  rules(): AllowRule[];
  recent(limit?: number): GuardRequest[];
};

export default defineModule({
  name: "guard",
  order: 20,
  migrations: {
    "001": `CREATE TABLE guard_requests (id TEXT PRIMARY KEY, created TEXT NOT NULL, decision TEXT NOT NULL, json TEXT NOT NULL);
            CREATE INDEX guard_requests_decision ON guard_requests(decision, created);
            CREATE TABLE guard_allow_rules (id TEXT PRIMARY KEY, rule TEXT NOT NULL, scope_type TEXT NOT NULL, scope_value TEXT NOT NULL, expires TEXT, created TEXT NOT NULL);`,
  },
  register(ctx: Ctx) {
    const { db, app } = ctx;
    const save = (r: GuardRequest) => db.prepare("INSERT INTO guard_requests(id, created, decision, json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET decision=excluded.decision, json=excluded.json").run(r.id, r.created, r.decision, JSON.stringify(r));
    const get = (id: string): GuardRequest | null => { const row = db.prepare("SELECT json FROM guard_requests WHERE id = ?").get(id) as any; return row ? JSON.parse(row.json) : null; };
    const rules = (): AllowRule[] => (db.prepare("SELECT * FROM guard_allow_rules WHERE expires IS NULL OR expires > ? ORDER BY created DESC").all(now()) as AllowRule[]);
    const missionOf = (session: string | null): string | null => {
      if (!session) return null;
      try { return ctx.service<any>("missions").missionOfSession(session); } catch { return null; }
    };

    function decide(id: string, decision: "allow" | "deny" | "timeout", reason = "", remember?: { scope: "session" | "mission" | "global"; hours?: number }) {
      const r = get(id);
      if (!r) throw new Error(`no guard request ${id}`);
      if (r.decision !== "pending") return r;
      r.decision = decision; r.decided_at = now(); r.reason = reason;
      save(r);
      if (remember && decision === "allow") {
        const scopeValue = remember.scope === "session" ? r.session ?? "" : remember.scope === "mission" ? missionOf(r.session) ?? "" : "*";
        if (scopeValue) {
          const expires = remember.hours ? new Date(Date.now() + remember.hours * 3600e3).toISOString() : null;
          db.prepare("INSERT INTO guard_allow_rules(id, rule, scope_type, scope_value, expires, created) VALUES (?,?,?,?,?,?)").run(rid("gar_"), r.rule, remember.scope, scopeValue, expires, now());
          ctx.emit({ source: "guard", type: "guard.rule_added", session: r.session ?? undefined, data: { rule: r.rule, scope: remember.scope, scopeValue, expires } });
        }
      }
      ctx.emit({ source: "guard", type: "guard.decision", session: r.session ?? undefined, agent: r.agent, cwd: r.cwd, data: { request: r.id, rule: r.rule, decision, reason } });
      ctx.bus.change({ entity: "guard", id: r.id });
      return r;
    }

    const service: GuardService = {
      pending: () => (db.prepare("SELECT json FROM guard_requests WHERE decision = 'pending' ORDER BY created").all() as any[]).map((x) => JSON.parse(x.json)),
      recent: (limit = 50) => (db.prepare("SELECT json FROM guard_requests ORDER BY created DESC LIMIT ?").all(limit) as any[]).map((x) => JSON.parse(x.json)),
      get, rules,
      decide: (id, d, reason, remember) => decide(id, d, reason, remember),
    };
    ctx.services.set("guard", service);

    app.post("/api/guard/requests", async (c) => {
      const b = await c.req.json();
      const policyTimeout = (() => { try { return JSON.parse(fs.readFileSync(paths.guardCompiled, "utf8")).timeout_seconds; } catch { return 300; } })();
      const r = GuardRequest.parse({
        id: rid("gr_"), rule: b.rule, title: b.title, tool: b.tool, summary: truncate(typeof b.input?.command === "string" ? b.input.command : JSON.stringify(b.input), 600),
        input: b.input, session: b.session ? (/^(claude|codex):/.test(b.session) ? b.session : `${b.agent ?? "claude"}:${b.session}`) : null, agent: b.agent ?? "claude", cwd: b.cwd ?? "", created: now(),
        deadline: new Date(Date.now() + policyTimeout * 1000).toISOString(), decision: "pending",
      });
      // Remembered allow rules short-circuit the human.
      const mission = missionOf(r.session);
      const hit = rules().find((ar) => ar.rule === r.rule && (ar.scope_type === "global" || (ar.scope_type === "session" && ar.scope_value === r.session) || (ar.scope_type === "mission" && mission && ar.scope_value === mission)));
      if (hit) { r.decision = "allow"; r.decided_at = now(); r.reason = `remembered ${hit.scope_type} rule`; }
      save(r);
      ctx.emit({ source: "guard", type: hit ? "guard.decision" : "guard.request", session: r.session ?? undefined, agent: r.agent, cwd: r.cwd, pane: b.pane ?? undefined,
        data: hit ? { request: r.id, rule: r.rule, decision: "allow", reason: r.reason } : { request: r.id, rule: r.rule, title: r.title, summary: r.summary, deadline: r.deadline, pane: b.pane ?? null } });
      ctx.bus.change({ entity: "guard", id: r.id });
      return c.json(r);
    });
    app.get("/api/guard/requests/:id", (c) => { const r = get(c.req.param("id")); return r ? c.json(r) : c.json({ error: "not found" }, 404); });
    app.post("/api/guard/requests/:id/decide", async (c) => {
      const b = await c.req.json();
      return c.json(decide(c.req.param("id"), b.decision, b.reason ?? "", b.remember));
    });
    app.post("/api/guard/requests/:id/timeout", (c) => c.json(decide(c.req.param("id"), "timeout", "no human decision before the deadline")));
    app.get("/api/guard/pending", (c) => c.json(service.pending()));
    app.get("/api/guard/recent", (c) => c.json(service.recent(Number(c.req.query("limit") ?? 50))));
    app.get("/api/guard/rules", (c) => c.json(rules()));
    app.delete("/api/guard/rules/:id", (c) => { db.prepare("DELETE FROM guard_allow_rules WHERE id = ?").run(c.req.param("id")); ctx.bus.change({ entity: "guard" }); return c.json({ ok: true }); });
    app.get("/api/guard/policy", (c) => c.json({ yaml: fs.readFileSync(paths.guard, "utf8"), compiled: JSON.parse(fs.readFileSync(paths.guardCompiled, "utf8")) }));

    // Ambiguous commands: Jev may only escalate to gated.
    app.post("/api/guard/classify", async (c) => {
      const b = await c.req.json();
      if (!jevAvailable()) return c.json({ escalate: false, reason: "jev unavailable" });
      try {
        const r = await jev({ tool: b.tool, command: typeof b.input?.command === "string" ? b.input.command : b.input, cwd: b.cwd }, {
          external: q.noul("Running this command will change something outside this local machine: pushing code, deploying, releasing, publishing a package, writing to a remote API, or modifying cloud infrastructure.",
            "It reaches a remote system and changes it", "It only affects the local machine or only reads remote state"),
        }, { timeoutMs: 8000, retries: 1 });
        const p = yes(r, "external") ?? 0;
        return c.json({ escalate: p >= 0.5, p });
      } catch (e: any) { return c.json({ escalate: false, reason: e.message }); }
    });
  },
  start(ctx) {
    const compile = () => { try { writeCompiled(); ctx.log("guard policy compiled"); } catch (e: any) { ctx.log(`guard policy invalid, keeping previous: ${e.message}`); } };
    compile();
    try { fs.watch(paths.guard, () => compile()); } catch {}
    // Sweep expired pending requests (the hook also reports timeouts).
    setInterval(() => {
      const svc = ctx.service<GuardService>("guard");
      for (const r of svc.pending()) if (r.deadline < now()) { try { (svc as any).decide(r.id, "deny", "deadline passed"); } catch {} }
    }, 10000).unref();
  },
});
