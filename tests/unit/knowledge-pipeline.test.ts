import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { sandboxDaemon } from "../sandbox.ts";
import { buildReportsHome } from "../e2e/reports-fixture.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let artifacts: ArtifactsService;
let root: string;
const modules = ["sessions", "missions", "artifacts", "attention", "nudges"];
const forbidden = ["memory.candidate", "artifact.distilled", "workspace.proposal"];
const log = () => execFileSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" });

beforeAll(async () => {
  root = process.env.JOYRIDE_HOME!;
  const configFile = path.join(root, "joyride.config.yaml");
  const config = YAML.parse(fs.readFileSync(configFile, "utf8"));
  config.knowledge.pipeline = "off";
  fs.writeFileSync(configFile, YAML.stringify(config));
  buildReportsHome(path.join(process.env.JOYRIDE_RUNTIME!, "firstmate"));
  const dir = path.join(process.env.JOYRIDE_CLAUDE_DIR!, "projects", "freeze-fixture");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project-fact.md"), "# A native fact\n\nKeep the original source.\n");
  d = await sandboxDaemon("knowledge-pipeline", modules);
  expect(d.ctx.config.knowledge.pipeline).toBe("off");
  artifacts = d.ctx.service<ArtifactsService>("artifacts");
  await d.start();
});
afterAll(async () => { await d?.stop(); });

describe("knowledge pipeline freeze", () => {
  it("validates on/off and preserves on as the omitted-key default", async () => {
    const { Config } = await import("../../src/shared/schema.ts");
    expect(Config.parse({}).knowledge.pipeline).toBe("on");
    expect(Config.parse({ knowledge: { pipeline: "off" } }).knowledge.pipeline).toBe("off");
    expect(Config.safeParse({ knowledge: { pipeline: "maybe" } }).success).toBe(false);
  });

  it("registers final Firstmate reports without queueing distillation or importing native memory", async () => {
    const sync = await artifacts.syncFirstmate();
    expect(sync.reports).toBe(3);
    expect(artifacts.list().filter(a => a.firstmate)).toHaveLength(3);
    expect(artifacts.list().every(a => !("distilled" in a))).toBe(true);
    const fmFile = path.join(process.env.FM_HOME!, "data", "captain.md");
    fs.writeFileSync(fmFile, "# Captain\n\n- Keep native files canonical.\n");
    const before = fs.readFileSync(fmFile, "utf8");
    await artifacts.syncFirstmate();
    expect(fs.readFileSync(fmFile, "utf8")).toBe(before);
    expect(log()).not.toMatch(/joyride: memory:|joyride: artifacts: distill/);
  });

  it("guards callable distillers, learning extraction, hill-climb and the workspace proposer", async () => {
    const artifact = artifacts.list().find(a => a.firstmate)!;
    expect((await d.app.request(`/api/artifacts/${artifact.id}/distill`, { method: "POST" })).status).toBe(404);
    expect((await d.app.request(`/api/artifacts/${artifact.id}/distilled`, { method: "POST" })).status).toBe(404);
    expect((await d.req("POST", "/api/learnings/extract", { mission: "test" })).status).toBe(404);
    for (const route of ["/api/learnings/nudges/refresh", "/api/hillclimb/run", "/api/workspace/proposer/run"]) expect((await d.req("POST", route, {})).status).toBe(404);
    d.tailer.drain();
    for (const type of forbidden) expect((await d.req("GET", `/api/events?type=${type}`)).body).toEqual([]);
    expect(log()).not.toMatch(/joyride: memory:|joyride: artifacts: distill/);
  });

  it("restarts cleanly with off, preserves cards and history, and resumes with on", async () => {
    const ids = artifacts.list().map(a => a.id).sort();
    await d.stop();
    d.ctx.db.close();
    d = await sandboxDaemon("knowledge-pipeline-restart", modules);
    await d.start();
    artifacts = d.ctx.service<ArtifactsService>("artifacts");
    expect((await d.req("GET", "/api/health")).body.ok).toBe(true);
    expect(artifacts.list().map(a => a.id).sort()).toEqual(ids);
    d.tailer.drain();
    for (const type of forbidden) expect((await d.req("GET", `/api/events?type=${type}`)).body).toEqual([]);
    expect(log()).not.toMatch(/joyride: memory:|joyride: artifacts: distill/);
    await d.stop();
    d.ctx.db.close();
    const file = path.join(root, "joyride.config.yaml");
    const config = YAML.parse(fs.readFileSync(file, "utf8"));
    config.knowledge.pipeline = "on";
    fs.writeFileSync(file, YAML.stringify(config));
    d = await sandboxDaemon("knowledge-pipeline-resume", modules);
    artifacts = d.ctx.service<ArtifactsService>("artifacts");
    expect(d.ctx.config.knowledge.pipeline).toBe("on");
    const sync = await artifacts.syncFirstmate();
    expect(artifacts.list().some(a => "distilled" in a)).toBe(false);
    d.ctx.config.knowledge.pipeline = "off";
  });
});
