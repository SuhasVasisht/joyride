// Evidence against the real missions and intents services: verdicts load the
// mission's done_when and linked sessions, and `reverify` is an intent.
import { describe, it, expect, beforeAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { EvidenceService } from "../../src/modules/evidence/index.ts";
import type { AttentionService } from "../../src/modules/attention/index.ts";

// Only type imports above: src/shared/paths.ts reads the sandbox env at import time.
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let ev: EvidenceService;
let att: AttentionService;
let missions: any;
let intents: any;

beforeAll(async () => {
  d = await sandboxDaemon("evidence-intents", ["sessions", "missions", "live", "attention", "evidence"]);
  const { paths } = await import("../../src/shared/paths.ts");
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  ev = d.ctx.service<EvidenceService>("evidence");
  att = d.ctx.service<AttentionService>("attention");
  missions = d.ctx.service("missions");
  intents = d.ctx.service("intents");
  // Only the evidence module's start(): it registers the reverify handler.
  await d.modules.find((m) => m.name === "evidence")!.start!(d.ctx);
});

describe("evidence with missions and intents", () => {
  it("judges a mission's done_when using evidence from its linked sessions", async () => {
    missions.create({ id: "parser-rewrite", title: "Parser rewrite", done_when: [{ id: "tests", text: "Unit tests cover the parser", kind: "test" }], sessions: [{ source: "claude", id: "sess-parser" }] });
    ev.add({ name: "unit", session: "claude:sess-parser", exit_code: 0, command: "npm test", assertions: { passed: 7, failed: 0, skipped: 0 }, cwd: "/tmp/p" });
    expect(ev.list({ mission: "parser-rewrite" }).map((x) => x.name)).toEqual(["unit"]);
    const v = await ev.verdict("parser-rewrite");
    expect(v.verdict).toBe("pass");
    expect(att.list({ open: true, mission: "parser-rewrite" }).map((x) => x.title)).toEqual(["Ready to close: Parser rewrite"]);
  });

  it("re-runs the verdict through a reverify intent", async () => {
    ev.add({ name: "unit", session: "claude:sess-parser", exit_code: 1, command: "npm test", assertions: { passed: 6, failed: 1, skipped: 0 }, cwd: "/tmp/p" });
    const it = await intents.create("reverify", "parser-rewrite", { mission: "parser-rewrite" });
    expect(it.status).toBe("sent");
    expect(it.result.verdict).toBe("fail");
    expect(ev.latestVerdict("parser-rewrite")?.id).toBe(it.result.id);
    expect(att.list({ open: true, mission: "parser-rewrite" }).map((x) => x.level)).toEqual(["L3"]);
  });

  it("fails the intent with a clear message for an unknown mission", async () => {
    const it = await intents.create("reverify", "no-such-mission", {});
    expect(it.status).toBe("failed");
    expect(it.error).toContain('No mission "no-such-mission"');
  });
});
