// Agent intent: the condensed prompt, the cache keyed by the transcript
// signature, the per-session debounce, the concurrency cap, idle sessions,
// failure backoff, and the routes over the fixture sessions.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { waitFor } from "../fixtures/fake-herdr.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let M: typeof import("../../src/modules/intentions/index.ts");
let registerLlmFake: typeof import("../../src/core/fakes.ts").registerLlmFake;

beforeAll(async () => {
  d = await sandboxDaemon("intentions", ["sessions", "intentions"]);
  M = await import("../../src/modules/intentions/index.ts");
  ({ registerLlmFake } = await import("../../src/core/fakes.ts"));
  await d.start();
  await d.ctx.service<any>("sessions").ready();
});
afterAll(async () => { await d?.stop(); });

type S = { key: string; source: string; title: string; first_prompt: string; repo: string | null; cwd: string; updated: string; turns: number };
/** An IntentionsService over stub sessions, so time and transcripts are under test control. */
function rig(opts: { debounceMs?: number; maxConcurrent?: number } = {}) {
  const sessions = new Map<string, S>();
  const changes: string[] = [];
  const ctx: any = {
    db: d.ctx.db, log: () => {}, bus: { change: (c: any) => changes.push(c.id) },
    services: new Map<string, any>([["sessions", {
      get: (k: string) => sessions.get(k) ?? null,
      transcript: async (k: string) => [{ role: "user", ts: null, text: sessions.get(k)!.first_prompt, tools: [] }, { role: "assistant", ts: null, text: "On it.", tools: [{ name: "Bash", summary: "npm test" }] }],
    }]]),
  };
  const svc = new M.IntentionsService(ctx, { debounceMs: opts.debounceMs ?? 300, maxConcurrent: opts.maxConcurrent ?? 4, eventDelayMs: 0, failureBackoffMs: 60_000 });
  const add = (id: string, o: Partial<S> = {}) => {
    const s: S = { key: `claude:${id}`, source: "claude", title: id, first_prompt: `Fix the ${id} bug in the parser`, repo: "/r/p", cwd: "/r/p", updated: new Date().toISOString(), turns: 2, ...o };
    sessions.set(s.key, s);
    return s;
  };
  return { svc, sessions, changes, add };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("intentions", () => {
  it("builds a condensed prompt: first request, latest requests, latest message, recent tools", () => {
    const p = M.intentPrompt(
      { key: "claude:x", source: "claude", title: "t", first_prompt: "Add a CSV export", repo: "/r/alpha", cwd: "/r/alpha", updated: "", turns: 4, branch: "main" },
      [
        { role: "user", ts: null, text: "Add a CSV export", tools: [] },
        { role: "assistant", ts: null, text: "Added the button.", tools: [{ name: "Edit", summary: "src/report.tsx" }] },
        { role: "user", ts: null, text: "Now add a totals row", tools: [] },
        { role: "assistant", ts: null, text: "Working on the totals row.", tools: [{ name: "Bash", summary: "npm test" }] },
      ],
      { status: "working", action: "Bash: npm test" },
    );
    expect(p).toContain("Claude Code in /r/alpha on branch main");
    expect(p).toContain("Status: working (Bash: npm test)");
    expect(p).toMatch(/First request from the user:\nAdd a CSV export/);
    expect(p).toMatch(/Latest requests from the user \(oldest first\):\n- Now add a totals row/);
    expect(p).toMatch(/Latest message from the agent:\nWorking on the totals row\./);
    expect(p).toMatch(/- Edit: src\/report.tsx\n- Bash: npm test/);
    expect(p).toMatch(/goal: .*at most 12 words/);
  });

  it("tidies model output to the word limits", () => {
    expect(M.tidy("  \"running the full export test suite one more time to catch the flaky totals row again.\" ", 15)).toBe("Running the full export test suite one more time to catch the flaky totals row");
    expect(M.tidy("one two three four five six seven eight nine ten eleven twelve thirteen", 12).split(" ")).toHaveLength(12);
  });

  it("caches per session until the transcript changes", async () => {
    let calls = 0;
    registerLlmFake("session_intent", (prompt) => { calls++; return M.fakeIntent(prompt); });
    const r = rig();
    const s = r.add("cache");
    const a = await r.svc.run(s.key);
    expect(a).toMatchObject({ key: s.key, goal: "Fix the cache bug in the parser", now: "Running npm test", waiting_on: null, sig: M.sessionSig(s) });
    expect(r.changes).toContain(s.key);
    expect(await r.svc.run(s.key)).toEqual(a); // same signature: served from the cache
    expect(calls).toBe(1);
    expect(r.svc.view(s.key).stale).toBe(false);
    s.turns = 4; s.updated = new Date(Date.now() + 1000).toISOString();
    expect(r.svc.view(s.key)).toMatchObject({ stale: true, intention: { goal: a!.goal } });
    await r.svc.run(s.key);
    expect(calls).toBe(2);
  });

  it("debounces turn.stop / prompt.submit to one run per window per session", async () => {
    let calls = 0;
    registerLlmFake("session_intent", (prompt) => { calls++; return M.fakeIntent(prompt); });
    const r = rig({ debounceMs: 400 });
    const s = r.add("debounce");
    const ev = (type: string) => r.svc.onEvent({ source: "hook.claude", type, session: "debounce", agent: "claude" });
    ev("prompt.submit"); ev("turn.stop"); ev("turn.stop");
    await waitFor(() => calls === 1, 2000, 10);
    s.turns = 6; s.updated = new Date(Date.now() + 1000).toISOString();
    ev("turn.stop"); ev("prompt.submit"); // inside the window: scheduled once for its end
    expect(r.svc.isPending(s.key)).toBe(true);
    await sleep(150);
    expect(calls).toBe(1);
    await waitFor(() => calls === 2, 2000, 10);
    await sleep(500);
    expect(calls).toBe(2);
    r.svc.onEvent({ source: "hook.claude", type: "tool.pre", session: "debounce", agent: "claude" }); // other events don't trigger
    r.svc.onEvent({ source: "herdr", type: "turn.stop", session: "debounce", agent: "claude" });
    expect(r.svc.isPending(s.key)).toBe(false);
  });

  it("runs at most four at a time", async () => {
    let live = 0, peak = 0, calls = 0;
    registerLlmFake("session_intent", async (prompt) => { calls++; live++; peak = Math.max(peak, live); await sleep(60); live--; return M.fakeIntent(prompt); });
    const r = rig();
    for (let i = 0; i < 10; i++) r.svc.request(r.add(`many${i}`).key);
    await waitFor(() => calls === 10 && live === 0, 3000, 10);
    expect(peak).toBe(4);
  });

  it("skips sessions idle for more than 7 days unless someone opens them", async () => {
    let calls = 0;
    registerLlmFake("session_intent", (prompt) => { calls++; return M.fakeIntent(prompt); });
    const r = rig();
    const s = r.add("old", { updated: new Date(Date.now() - 10 * 864e5).toISOString() });
    expect(r.svc.view(s.key, { explicit: false }).pending).toBe(false);
    expect(await r.svc.run(s.key)).toBeNull();
    expect(calls).toBe(0);
    r.svc.view(s.key, { explicit: true });
    await waitFor(() => r.svc.get(s.key), 2000, 10);
    expect(calls).toBe(1);
  });

  it("records a failure and backs off instead of retrying on every event", async () => {
    let calls = 0;
    registerLlmFake("session_intent", () => { calls++; throw new Error("codex exec failed (1): rate limited"); });
    const r = rig({ debounceMs: 0 });
    const s = r.add("fail");
    await r.svc.run(s.key);
    expect(r.svc.view(s.key).error).toMatch(/Couldn't describe this session: codex exec failed/);
    r.svc.request(s.key);
    r.svc.onEvent({ source: "hook.claude", type: "turn.stop", session: "fail", agent: "claude" });
    await sleep(50);
    expect(calls).toBe(1);
  });
});

describe("intentions routes", () => {
  it("describes a fixture session on request and serves it from the cache", async () => {
    registerLlmFake("session_intent", (prompt) => M.fakeIntent(prompt));
    const key = "claude:11111111-1111-4111-8111-111111111111";
    const first = await d.req("GET", `/api/intentions/${encodeURIComponent(key)}`);
    expect(first.status).toBe(200);
    const done = await waitFor(async () => (await d.req("GET", `/api/intentions/${encodeURIComponent(key)}`)).body.intention, 3000);
    expect(done.goal).toBe("Add a CSV export button to the report page");
    const list = (await d.req("GET", `/api/intentions?keys=${encodeURIComponent(key)},claude:nope`)).body;
    expect(list.items[key]).toMatchObject({ goal: "Add a CSV export button to the report page" });
    expect(list.items["claude:nope"]).toBeUndefined();
    expect((await d.req("GET", "/api/intentions/claude:nope")).status).toBe(404);
  });
});
