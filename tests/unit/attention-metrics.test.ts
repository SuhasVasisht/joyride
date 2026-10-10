import { describe, it, expect, beforeAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { AttentionService } from "../../src/modules/attention/index.ts";

// Only type imports above: src/shared/paths.ts reads the sandbox env at import time.
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let att: AttentionService;
let quantile: (sorted: number[], p: number) => number | null;
const base = Date.now();
const at = (min: number) => new Date(base - min * 60_000).toISOString();
const MIN = 60_000;
const flush = async () => { d.tailer.drain(); await att.settle(); d.tailer.drain(); };
const hook = (session: string, type: string, data: Record<string, unknown>, ts?: string) =>
  d.ctx.emit({ source: "hook.claude", type, session, agent: "claude", cwd: "/tmp/metrics-repo", data, ...(ts ? { ts } : {}) });
const one = (s: string) => att.list({ session: `claude:${s}` })[0];

beforeAll(async () => {
  d = await sandboxDaemon("attention-metrics", ["attention", "guard"]);
  const { paths } = await import("../../src/shared/paths.ts");
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  ({ quantile } = await import("../../src/modules/attention/classify.ts"));
  att = d.ctx.service<AttentionService>("attention");

  // Blocked → unblocked: a question answered after 10 min, a permission resumed after 5 min.
  hook("q1", "turn.stop", { last: "Which database should I use?" }, at(60));
  hook("q1", "prompt.submit", { prompt: "postgres" }, at(50));
  hook("p2", "permission.request", { tool: "Bash", input: JSON.stringify({ command: "make deploy" }) }, at(30));
  hook("p2", "tool.pre", { tool: "Bash", input: "{}" }, at(25));
  // Still open: an L3 question and an L4 guard request.
  hook("q3", "turn.stop", { last: "Should I delete the old table?" }, at(20));
  d.ctx.emit({ source: "guard", type: "guard.request", session: "g4", agent: "claude", cwd: "/tmp/metrics-repo", ts: at(9), data: { request: "gr_m4", rule: "git-push", title: "git push to a remote", summary: "git push", deadline: at(-5) } });
  // Fresh turns classified by (fake) Jev, labelled below.
  hook("j7", "turn.stop", { last: "Progress update: finished a step and moved the helpers; keeps going with the next step." });
  hook("j8", "turn.stop", { last: "Implemented the parser and all tests pass. The work is finished and ready to look over." });
  hook("j9", "turn.stop", { last: "Progress update: finished a step and moved the helpers; keeps going with the next step." });
  // Herdr focus switches: only the one at T-45m happens while nothing at L3/L4 is open.
  for (const m of [55, 45, 27, 5]) d.ctx.emit({ source: "herdr", type: "pane.focused", pane: "w1:p1", ts: at(m), data: {} });
  await flush();

  // Older history: resolved 2 days ago after 60 min; a dismissed item never counts as unblocked.
  const old = att.raise({ level: "L3", kind: "error", title: "Crashed", session: "claude:m5", opened: at(50 * 60) })!;
  att.resolve(old.id, "human replied", at(49 * 60));
  const dis = att.raise({ level: "L3", kind: "question", title: "Asked", session: "claude:m6", opened: at(48 * 60) })!;
  att.resolve(dis.id, "dismissed", at(47.5 * 60));

  att.label(one("j7").id, "ack");
  att.label(one("j8").id, "ack");
  att.label(one("j9").id, "override", { level: "L2" });
});

describe("attention metrics", () => {
  it("interpolates quantiles like numpy", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("records resolution times from the resolving event", () => {
    expect(one("q1")).toMatchObject({ level: "L3", resolution: "human replied", opened: at(60), resolved: at(50) });
    expect(one("p2")).toMatchObject({ kind: "approval", resolution: "agent resumed", opened: at(30), resolved: at(25) });
  });

  it("computes blocked→unblocked latency over 1d and 7d", async () => {
    const m = (await d.req("GET", "/api/metrics")).body;
    expect(m.blocked_to_unblocked["1d"]).toMatchObject({ count: 2, p50_ms: 7.5 * MIN, p90_ms: 9.5 * MIN });
    expect(m.blocked_to_unblocked["7d"]).toMatchObject({ count: 3, p50_ms: 10 * MIN, p90_ms: 50 * MIN });
    expect(m.blocked_to_unblocked["7d"].mean_ms).toBeCloseTo(25 * MIN);
  });

  it("counts open items without collecting labels or agreement metrics", async () => {
    const m = (await d.req("GET", "/api/metrics")).body;
    expect(m.open).toEqual({ L0: 0, L1: 0, L2: 1, L3: 1, L4: 1 });
    expect(m).not.toHaveProperty("labels");
    expect(m).not.toHaveProperty("jev_agreement");
  });

  it("counts focus switches while nothing was pending as checking", async () => {
    const m = (await d.req("GET", "/api/metrics")).body;
    expect(m.checking.focus_switches).toBe(4);
    expect(m.checking.while_nothing_pending).toBe(1);
    expect(m.checking.per_hour).toHaveLength(24);
    expect(m.checking.per_hour.reduce((a: number, h: any) => a + h.focus, 0)).toBe(4);
    expect(m.checking.per_hour.reduce((a: number, h: any) => a + h.checking, 0)).toBe(1);
  });

  it("includes Jev and LLM call stats", async () => {
    const m = (await d.req("GET", "/api/metrics")).body;
    expect(m.jev.calls).toBeGreaterThanOrEqual(3);
    expect(m.llm).toHaveProperty("calls");
  });
});
