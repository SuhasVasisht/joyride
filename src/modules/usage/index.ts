// Usage: subscription limits for each configured account (`usage.accounts`: Claude Code, Codex
// logins, Cursor), served from a cache refreshed in the background. Page requests never wait for
// quota-axi. Default logins share one run; an account with its own credential folder gets a
// `--profile-only` run with CODEX_HOME or CLAUDE_CONFIG_DIR set to it.
// Joyride never reads provider credentials itself; quota-axi does, and reports only usage.
//   routes: GET /api/usage[?fresh=1], GET /api/usage/accounts, POST /api/usage/test-fake (JOYRIDE_TEST only)
//   service: usage { report(fresh?), snapshot(), accounts() }
//   bus entity: usage (after each read)
import path from "node:path";
import { spawn } from "node:child_process";
import { defineModule, type Ctx } from "../../core/context.ts";
import type { UsageAccountInfo, UsageReport, UsageSnapshot } from "../../shared/usage.ts";
import type { UsageAccount } from "../../shared/schema.ts";
import { readAccounts, resolveAccounts, type Account, type AccountProvider } from "../../core/accounts.ts";
import { findTool } from "../system/tools.ts";
import { buildReport, type Runs, type SourceResult } from "./quota.ts";

export const MAX_AGE_S = 60;
const FRESH_MIN_GAP_MS = 5000; // a refresh button can't make quota-axi run more than once per 5s
const TIMEOUT_S = 20;
const MAX_OUTPUT = 4 << 20;

/** One quota-axi run: the default logins of `providers`, or one account's credential folder. */
export type QuotaRequest = { fresh: boolean; providers: AccountProvider[]; profile: { account: string; envVar: string; home: string } | null };

/** quota-axi's flags for a request. `--max-age` shares a reading with other quota-axi callers (Firstmate)
 *  instead of asking the vendor again; `--profile-only` reads just the folder's credential file. */
export function quotaArgs(r: QuotaRequest): string[] {
  const provider = ["--provider", r.providers.join(",")];
  if (r.profile) return [...provider, "--profile-only", "--full", "--json"];
  return r.fresh ? [...provider, "--json"] : [...provider, "--json", "--max-age", `${MAX_AGE_S}s`];
}

/** Runs quota-axi once. `bin` null means it is not installed. Never throws. */
export function runQuotaAxi(bin: string | null, args: string[], opts: { timeoutS?: number; env?: Record<string, string> } = {}): Promise<SourceResult> {
  const timeoutS = opts.timeoutS ?? TIMEOUT_S;
  if (!bin) return Promise.resolve({ kind: "missing" });
  // quota-axi is a node script; the daemon's own node keeps it runnable when PATH lacks one.
  const PATH = [path.dirname(process.execPath), process.env.PATH ?? ""].join(":");
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: SourceResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let out = "", err = "";
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a timeout also kills any vendor CLI it started for a credential refresh.
      child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH, NO_COLOR: "1", ...opts.env } });
    } catch (e: any) {
      return resolve(e?.code === "ENOENT" ? { kind: "missing" } : { kind: "failed", code: null, output: String(e?.message ?? e) });
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      finish({ kind: "timeout", seconds: timeoutS });
    }, timeoutS * 1000);
    child.stdout!.on("data", (b) => { if (out.length < MAX_OUTPUT) out += b; });
    child.stderr!.on("data", (b) => { if (err.length < MAX_OUTPUT) err += b; });
    child.on("error", (e: any) => finish(e?.code === "ENOENT" ? { kind: "missing" } : { kind: "failed", code: null, output: String(e?.message ?? e) }));
    child.on("close", (code) => {
      if (code === 0 || out.trim().startsWith("{")) return finish({ kind: "ok", stdout: out });
      finish({ kind: "failed", code, output: `${out}${err}` });
    });
  });
}

/** The runs a set of accounts needs: one for every default login, one per credential folder. */
export function quotaRequests(accounts: Account[], fresh: boolean): QuotaRequest[] {
  const shared = [...new Set(accounts.filter((a) => !a.home).map((a) => a.provider))];
  return [
    ...(shared.length ? [{ fresh, providers: shared, profile: null }] : []),
    ...accounts.filter((a) => a.home && a.envVar).map((a) => ({ fresh, providers: [a.provider], profile: { account: a.id, envVar: a.envVar!, home: a.home! } })),
  ];
}

export type QuotaSource = (req: QuotaRequest) => Promise<SourceResult>;
const isTest = () => process.env.JOYRIDE_TEST === "1";
/** Under JOYRIDE_TEST nothing external runs: POST /api/usage/test-fake sets what each run returns
 *  (`result` for the shared run, `profiles[accountId]` for a folder's run) and, optionally, the accounts. */
type TestFake = { result: SourceResult; profiles: Record<string, SourceResult>; accounts: UsageAccount[] | null; delayMs: number };
let testFake: TestFake = { result: { kind: "missing" }, profiles: {}, accounts: null, delayMs: 0 };
const realSource: QuotaSource = (req) =>
  runQuotaAxi(findTool("quota-axi")?.path ?? null, quotaArgs(req), { env: req.profile ? { [req.profile.envVar]: req.profile.home } : undefined });
const testSource: QuotaSource = (req) => new Promise((r) => setTimeout(() => r((req.profile ? testFake.profiles[req.profile.account] : null) ?? testFake.result), testFake.delayMs));
let sourceOverride: QuotaSource | null = null;
/** Unit tests swap the source. */
export function setQuotaSource(fn: QuotaSource | null) { sourceOverride = fn; }

const accounts = () => (isTest() && testFake.accounts ? resolveAccounts(testFake.accounts) : readAccounts());
let refreshTimer: NodeJS.Timeout | null = null;
let stopReads: (() => void) | null = null;

export default defineModule({
  name: "usage",
  order: 95,
  register(ctx: Ctx) {
    const { app } = ctx;
    let cache: { at: number; value: UsageReport } | null = null;
    let inflight: Promise<UsageReport> | null = null;
    let generation = 0;
    let stopped = false;
    stopReads = () => { stopped = true; generation++; };

    async function read(fresh: boolean): Promise<UsageReport> {
      const version = generation;
      const source = sourceOverride ?? (isTest() ? testSource : realSource);
      const list = accounts();
      const runs: Runs = { shared: null, profiles: {} };
      await Promise.all(quotaRequests(list, fresh).map(async (req) => {
        let result: SourceResult;
        try { result = await source(req); } catch (e: any) { result = { kind: "failed", code: null, output: String(e?.message ?? e) }; }
        if (req.profile) runs.profiles[req.profile.account] = result; else runs.shared = result;
      }));
      const value = buildReport(list, runs, new Date(), MAX_AGE_S);
      // Keep a usable reading when a provider temporarily fails. Its original timestamp stays visible.
      const transient = new Set(["timeout", "unreadable", "failed", "error", "rate_limited"]);
      let kept = false;
      value.providers = value.providers.map((p) => {
        const old = cache?.value.providers.find((o) => o.account === p.account);
        if (!old?.windows.some((w) => w.reported) || !transient.has(p.state)) return p;
        kept = true;
        return { ...old, state: "stale", message: `Showing the previous reading. ${p.message ?? "The refresh failed. Try again shortly."}` };
      });
      if (kept && cache) { value.fetchedAt = cache.value.fetchedAt; value.generatedAt = cache.value.generatedAt; }
      if (stopped || version !== generation) return value;
      cache = { at: Date.now(), value };
      ctx.bus.change({ entity: "usage" });
      return value;
    }
    function refresh(fresh = false): Promise<UsageReport> {
      if (inflight) return inflight;
      const age = cache ? Date.now() - cache.at : Infinity;
      if (cache && age < (fresh ? FRESH_MIN_GAP_MS : MAX_AGE_S * 1000)) return Promise.resolve(cache.value);
      // Defer even synchronous source setup until after the HTTP snapshot has been returned.
      if (!inflight) {
        const job = Promise.resolve().then(() => read(fresh));
        inflight = job;
        void job.finally(() => { if (inflight === job) inflight = null; }).catch(() => {});
      }
      return inflight;
    }
    function report(fresh = false): UsageSnapshot {
      void refresh(fresh).catch((e: unknown) => ctx.log("usage: background refresh failed", String(e)));
      return snapshot();
    }
    function snapshot(): UsageSnapshot {
      const value = cache?.value;
      return {
        ...(value ?? { fetchedAt: null, generatedAt: null, maxAgeSeconds: MAX_AGE_S, providers: [] }),
        ageSeconds: value ? Math.max(0, Math.floor((Date.now() - Date.parse(value.fetchedAt)) / 1000)) : null,
        refreshing: inflight !== null,
      };
    }
    ctx.services.set("usage", { report, snapshot, refresh, accounts });

    app.get("/api/usage", (c) => c.json(report(c.req.query("fresh") === "1")));
    app.get("/api/usage/accounts", (c) =>
      c.json(accounts().map((a): UsageAccountInfo => ({ id: a.id, provider: a.provider, label: a.label, home: a.homeLabel }))));

    app.post("/api/usage/test-fake", async (c) => {
      if (!isTest()) return c.json({ error: "Test fakes only exist when JOYRIDE_TEST=1." }, 404);
      const b: Partial<TestFake> = await c.req.json().catch(() => ({}));
      testFake = { result: b.result ?? { kind: "missing" }, profiles: b.profiles ?? {}, accounts: b.accounts ?? null, delayMs: Number(b.delayMs ?? 0) };
      cache = null;
      generation++;
      inflight = null;
      ctx.bus.change({ entity: "usage" });
      return c.json({ ok: true });
    });
  },
  start(ctx) {
    const usage = ctx.service<{ refresh(): Promise<UsageReport> }>("usage");
    const refresh = () => { void usage.refresh().catch((e: unknown) => ctx.log("usage: background refresh failed", String(e))); };
    refresh();
    refreshTimer = setInterval(refresh, MAX_AGE_S * 1000);
    refreshTimer.unref();
  },
  stop() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; stopReads?.(); stopReads = null; },
});
