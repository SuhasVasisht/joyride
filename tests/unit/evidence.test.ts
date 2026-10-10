import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import type { EvidenceService } from "../../src/modules/evidence/index.ts";
import type { AttentionService } from "../../src/modules/attention/index.ts";
import type { EvidenceItem } from "../../src/shared/schema.ts";

// Only type imports above: src/shared/paths.ts reads the sandbox env at import time.
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let ev: EvidenceService;
let att: AttentionService;
let P: typeof import("../../src/modules/evidence/parse.ts");
let B: typeof import("../../src/modules/evidence/blobs.ts");
let V: typeof import("../../src/modules/evidence/verdict.ts");
let fakes: typeof import("../../src/core/fakes.ts");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body " + Math.random())]);
const flush = async () => { d.tailer.drain(); await att.settle(); d.tailer.drain(); };
const item = (o: Partial<EvidenceItem> & { name: string }): EvidenceItem => ({
  id: `evd_${Math.random().toString(36).slice(2, 10)}`, mode: "attested", command: "npm test", exit_code: 0, log_tail: "", log_blob: null, screenshots: [],
  assertions: null, claim: "", session: null, mission: null, cwd: "/tmp/ev-repo", branch: "main", sha: null, created: new Date().toISOString(), ...o,
});

beforeAll(async () => {
  d = await sandboxDaemon("evidence", ["attention", "evidence", "guard"]);
  const { paths } = await import("../../src/shared/paths.ts");
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  P = await import("../../src/modules/evidence/parse.ts");
  B = await import("../../src/modules/evidence/blobs.ts");
  V = await import("../../src/modules/evidence/verdict.ts");
  fakes = await import("../../src/core/fakes.ts");
  ev = d.ctx.service<EvidenceService>("evidence");
  att = d.ctx.service<AttentionService>("attention");
});

describe("parsers", () => {
  it("reads common test-runner summaries", () => {
    expect(P.parseTestSummary("\u001b[32m Test Files  3 passed (3)\n      Tests  12 passed | 1 failed | 2 skipped (15)\n")).toEqual({ passed: 12, failed: 1, skipped: 2 });
    expect(P.parseTestSummary("Tests:       1 failed, 1 skipped, 10 passed, 12 total")).toEqual({ passed: 10, failed: 1, skipped: 1 });
    expect(P.parseTestSummary("========= 3 failed, 10 passed, 1 skipped in 0.52s =========")).toEqual({ passed: 10, failed: 3, skipped: 1 });
    expect(P.parseTestSummary("test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured\ntest result: FAILED. 1 passed; 2 failed; 0 ignored")).toEqual({ passed: 6, failed: 2, skipped: 1 });
    expect(P.parseTestSummary("  ✓ a\n\n  4 passed (3.1s)\n  1 flaky\n  2 skipped\n")).toEqual({ passed: 5, failed: 0, skipped: 2 });
    expect(P.parseTestSummary("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\tpkg\t0.2s")).toEqual({ passed: 1, failed: 1, skipped: 0 });
    expect(P.parseTestSummary("hello world")).toBeNull();
  });
  it("reads Playwright JSON stats", () => {
    expect(P.parsePlaywrightJson({ stats: { expected: 4, unexpected: 1, flaky: 1, skipped: 2 } })).toEqual({ passed: 5, failed: 1, skipped: 2 });
    expect(P.parsePlaywrightJson({ foo: 1 })).toBeNull();
  });
  it("detects test commands, including clipped and Codex inputs", () => {
    expect(P.testCommandName("cd x && npm test -- --run")).toBe("npm test");
    expect(P.testCommandName("npx vitest run tests/unit")).toBe("npx vitest");
    expect(P.testCommandName("python -m pytest -q")).toBe("python -m pytest");
    expect(P.testCommandName("joyride-evidence run --name t -- npm test")).toBeNull();
    expect(P.testCommandName("npm install")).toBeNull();
    expect(P.commandOf('{"command":"go test ./...","description":"run te')).toBe("go test ./...");
    expect(P.commandOf(JSON.stringify({ command: ["bash", "-lc", "cargo test"] }))).toBe("cargo test");
  });
  it("derives an outcome from exit code and assertions", () => {
    expect(P.outcomeOf(0, null)).toBe("pass");
    expect(P.outcomeOf(0, { passed: 3, failed: 1, skipped: 0 })).toBe("fail");
    expect(P.outcomeOf(2, null)).toBe("fail");
    expect(P.outcomeOf(null, null)).toBe("unknown");
  });
  it("aggregates criteria: all pass → pass, any fail → fail, else insufficient", () => {
    expect(V.aggregate([{ verdict: "pass" }, { verdict: "pass" }])).toBe("pass");
    expect(V.aggregate([{ verdict: "pass" }, { verdict: "insufficient" }])).toBe("insufficient");
    expect(V.aggregate([{ verdict: "insufficient" }, { verdict: "fail" }])).toBe("fail");
    expect(V.aggregate([])).toBe("insufficient");
  });
});

describe("evidence records", () => {
  it("ingests evidence.added events from the log as attested evidence", async () => {
    const it = item({ name: "unit tests", session: "claude:ingest-1", assertions: { passed: 4, failed: 0, skipped: 0 } });
    d.ctx.emit({ source: "evidence", type: "evidence.added", session: "ingest-1", agent: "claude", data: { item: it } });
    await flush();
    const r = await d.req("GET", "/api/evidence?session=claude:ingest-1");
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: it.id, mode: "attested", exit_code: 0, assertions: { passed: 4 } });
    d.ctx.emit({ source: "evidence", type: "evidence.added", data: { item: { nonsense: true } } });
    await flush(); // malformed events are ignored, not fatal
  });

  it("adds evidence over HTTP and rejects records without a name", async () => {
    const r = await d.req("POST", "/api/evidence", { name: "manual check", claim: "looked right", session: "claude:http-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: "attested", name: "manual check", exit_code: null });
    expect((await d.req("GET", `/api/evidence/${r.body.id}`)).body.claim).toBe("looked right");
    expect((await d.req("POST", "/api/evidence", { claim: "x" })).status).toBe(400);
  });

  it("infers test runs from hook events and fills exit codes from the transcript", async () => {
    const transcript = path.join(d.sb.dir, "transcript-inf.jsonl");
    const toolId = "toolu_inf_1";
    d.ctx.emit({ source: "hook.claude", type: "tool.pre", session: "inf-1", agent: "claude", cwd: "/tmp/ev-repo",
      data: { tool: "Bash", input: JSON.stringify({ command: "npm test -- --run" }), tool_use_id: toolId, transcript } });
    d.ctx.emit({ source: "hook.codex", type: "tool.pre", session: "inf-2", agent: "codex", cwd: "/tmp/ev-repo",
      data: { tool: "shell", input: JSON.stringify({ command: ["bash", "-lc", "pytest -q"] }) } });
    d.ctx.emit({ source: "hook.claude", type: "tool.pre", session: "inf-1", agent: "claude", cwd: "/tmp/ev-repo", data: { tool: "Bash", input: JSON.stringify({ command: "ls -la" }) } });
    await flush();
    const [a] = ev.list({ session: "claude:inf-1" });
    expect(a).toMatchObject({ mode: "inferred", name: "npm test", command: "npm test -- --run", exit_code: null });
    expect(ev.list({ session: "codex:inf-2" })[0]).toMatchObject({ mode: "inferred", name: "pytest" });
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "npm test -- --run" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, is_error: true, content: "Exit code 1\n Tests  3 passed | 2 failed (5)\n" }] }, toolUseResult: { stdout: "", stderr: "" } }),
    ].join("\n") + "\n");
    d.ctx.emit({ source: "hook.claude", type: "turn.stop", session: "inf-1", agent: "claude", cwd: "/tmp/ev-repo", data: { last: "Tests are failing." } });
    await flush();
    expect(ev.get(a.id)).toMatchObject({ exit_code: 1, assertions: { passed: 3, failed: 2, skipped: 0 } });
  });

  it("serves blobs with the right content type", async () => {
    const png = B.putBlobBuffer(PNG);
    const log = B.putBlobBuffer("line one\nline two\n");
    const r1 = await d.app.request(`/api/evidence/blob/${png}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r1.arrayBuffer()).equals(PNG)).toBe(true);
    const r2 = await d.app.request(`/api/evidence/blob/${log}`);
    expect(r2.headers.get("content-type")).toContain("text/plain");
    expect(await r2.text()).toBe("line one\nline two\n");
    expect((await d.app.request("/api/evidence/blob/not-a-sha")).status).toBe(400);
    expect((await d.app.request(`/api/evidence/blob/${"0".repeat(64)}`)).status).toBe(404);
  });
});

describe("verdicts", () => {
  const verdict = (mission: string, done_when: unknown[], evidence: string[]) => d.req("POST", `/api/evidence/verdict/${mission}`, { done_when, evidence });
  const addAll = (...items: EvidenceItem[]) => items.map((x) => ev.add(x).id);

  it("passes when every criterion passes and raises an L2 ready-to-close item", async () => {
    const ids = addAll(item({ name: "unit", exit_code: 0, assertions: { passed: 3, failed: 0, skipped: 0 }, log_tail: " Tests  3 passed (3)" }));
    const r = await verdict("m-pass", [{ id: "c1", text: "Unit tests cover the parser", kind: "test" }], ids);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mission: "m-pass", verdict: "pass", downgraded_by_caption: false, evidence: ids });
    expect(r.body.per_criterion[0]).toMatchObject({ criterion: "Unit tests cover the parser", verdict: "pass" });
    const items = att.list({ open: true, mission: "m-pass" });
    expect(items.map((x) => [x.level, x.kind, x.title])).toEqual([["L2", "review", "Ready to close: m-pass"]]);
    expect((await d.req("GET", "/api/evidence/verdict/m-pass")).body.id).toBe(r.body.id);
  });

  it("fails when a relevant check fails and raises an L3 item", async () => {
    const ids = addAll(item({ name: "unit", exit_code: 1, assertions: { passed: 2, failed: 1, skipped: 0 }, log_tail: "1 failed" }));
    const r = await verdict("m-fail", [{ id: "c1", text: "Unit tests cover the parser", kind: "test" }], ids);
    expect(r.body.verdict).toBe("fail");
    expect(att.list({ open: true, mission: "m-fail" }).map((x) => [x.level, x.kind])).toEqual([["L3", "review"]]);
    // a later passing verdict updates the same item down to L2
    const ok = addAll(item({ name: "unit", exit_code: 0, assertions: { passed: 3, failed: 0, skipped: 0 } }));
    expect((await verdict("m-fail", [{ id: "c1", text: "Unit tests cover the parser", kind: "test" }], ok)).body.verdict).toBe("pass");
    expect(att.list({ open: true, mission: "m-fail" }).map((x) => x.level)).toEqual(["L2"]);
  });

  it("is insufficient without evidence, or when no successful run backs a test criterion", async () => {
    const none = await verdict("m-none", ["Docs explain setup"], []);
    expect(none.body.verdict).toBe("insufficient");
    expect(none.body.per_criterion[0].reason).toContain("no evidence");
    const ids = addAll(item({ name: "claimed", exit_code: null, command: "", claim: "I ran the tests and they pass" }));
    const r = await verdict("m-claim", [{ id: "c1", text: "Unit tests cover the parser", kind: "test" }], ids);
    expect(r.body.verdict).toBe("insufficient");
    expect(r.body.per_criterion[0].reason).toContain("no successful test run");
    expect(att.list({ open: true, mission: "m-claim" })).toHaveLength(0);
  });

  it("lets a screenshot caption downgrade a pass to insufficient, and only downgrade", async () => {
    const blob = B.putBlobBuffer(PNG);
    const criteria = [{ id: "c1", text: "The login page renders", kind: "screenshot" }];
    const okIds = addAll(item({ name: "e2e", exit_code: 0, screenshots: [{ blob, name: "login.png", caption: null }] }));
    const ok = await verdict("m-shot-ok", criteria, okIds);
    expect(ok.body.verdict).toBe("pass");
    expect(ok.body.per_criterion[0].captions[0]).toContain("rendered normally");
    expect(ev.get(okIds[0])!.screenshots[0].caption).toContain("rendered normally"); // captions are cached on the record

    fakes.registerLlmFake("screenshot_caption", () => "An error banner covers the login form; the page failed to load.");
    const badIds = addAll(item({ name: "e2e", exit_code: 0, screenshots: [{ blob, name: "login.png", caption: null }] }));
    const bad = await verdict("m-shot-bad", criteria, badIds);
    expect(bad.body).toMatchObject({ verdict: "insufficient", downgraded_by_caption: true });
    expect(bad.body.per_criterion[0].reason).toContain("caption contradicts");
    expect(bad.body.per_criterion[0].caption_p).toBeGreaterThan(0.5);

    const failIds = addAll(item({ name: "e2e", exit_code: 1, screenshots: [{ blob, name: "login.png", caption: null }] }));
    const fail = await verdict("m-shot-fail", criteria, failIds);
    expect(fail.body).toMatchObject({ verdict: "fail", downgraded_by_caption: false }); // captions never turn a fail into anything else
  });

  it("persists verdicts, emits evidence.verdict, and 404s for unknown missions without criteria", async () => {
    d.tailer.drain();
    const rows = d.ctx.db.prepare("SELECT json FROM events WHERE type = 'evidence.verdict'").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect((await d.req("GET", "/api/evidence/verdicts?mission=m-fail")).body).toHaveLength(2);
    expect((await d.req("POST", "/api/evidence/verdict/nope", {})).status).toBe(404);
    expect((await d.req("GET", "/api/evidence/verdict/nope")).body).toBeNull();
  });
});

describe("relevantFor", () => {
  it("judges each criterion on records labelled for it, then by word overlap", async () => {
    const V = await import("../../src/modules/evidence/verdict.ts");
    const mk = (name: string, created: string, claim = "") => ({ id: name, mode: "attested", name, command: "", exit_code: 0, log_tail: "", log_blob: null, screenshots: [], assertions: null, claim, session: null, mission: "m", cwd: "/", branch: null, sha: null, created } as any);
    const ev = [mk("C0 unit tests", "2026-01-01"), mk("C3 e2e worker", "2026-01-02"), mk("C9 unit tests", "2026-01-03"), mk("map rendering e2e", "2026-01-04")];
    const c3 = V.relevantFor({ id: "c3", text: "C3: replying in place unblocks agents", kind: "e2e" }, ev);
    expect(c3.map((e) => e.name)).toEqual(["C3 e2e worker"]);
    const c0 = V.relevantFor({ id: "c0", text: "C0: the guard fires", kind: "test" }, ev);
    expect(c0[0].name).toBe("C0 unit tests");
    const free = V.relevantFor({ id: "x", text: "The map shows rendering of missions", kind: "e2e" }, ev);
    expect(free[0].name).toBe("map rendering e2e");
  });
});
