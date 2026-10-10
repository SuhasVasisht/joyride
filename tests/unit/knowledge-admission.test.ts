import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import type { KnowledgePolicy } from "../../src/shared/knowledge-admission.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";
import type { KnowledgeService } from "../../src/modules/knowledge/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let gate: typeof import("../../src/shared/knowledge-admission.ts");
let artifacts: ArtifactsService;
let paths: typeof import("../../src/shared/paths.ts").paths;
let privateCwd: string;
const own = "https://github.com/captain/work/pull/7";
const foreign = "https://github.com/stranger/submission/pull/8";
const dead = "https://github.com/captain/work/pull/9";
const SID = "abababab-1111-4111-8111-111111111111";
const PRIVATE_SID = "abababab-2222-4222-8222-222222222222";
const reportUrl = "https://claude.ai/artifact/abcdef-hiring-review";
const policy: KnowledgePolicy = {
  owned_repos: ["github.com/captain/work"], owned_orgs: [], private_paths: [], private_sessions: [],
  tombstones: [{ source: dead, reason: "Removed reference" }],
};
beforeAll(async () => {
  d = await sandboxDaemon("knowledge-admission", ["sessions", "missions", "artifacts", "knowledge"]);
  paths = (await import("../../src/shared/paths.ts")).paths;
  expect(paths.runtime.startsWith(d.sb.dir)).toBe(true);
  gate = await import("../../src/shared/knowledge-admission.ts");
  privateCwd = path.join(d.sb.dir, "hiring_notes", "candidate");
  policy.private_paths = [path.dirname(privateCwd)];
  Object.assign(d.ctx.config.knowledge, structuredClone(policy));
  artifacts = d.ctx.service<ArtifactsService>("artifacts");
  const repo = path.join(d.sb.dir, "owned-checkout");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:captain/work.git"], { cwd: repo });
  const report = path.join(privateCwd, "review.html");
  fs.mkdirSync(privateCwd, { recursive: true });
  fs.writeFileSync(report, "<h1>Hiring review</h1><p>Private candidate assessment.</p>");
  for (const [id, cwd] of [[SID, repo], [PRIVATE_SID, privateCwd]]) {
    const dir = path.join(paths.claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    const base = { sessionId: id, cwd, timestamp: new Date().toISOString(), isSidechain: false, userType: "external" };
    const records = [
      { ...base, type: "user", origin: { kind: "human" }, uuid: `${id}-prompt`, message: { role: "user", content: `Review these links: ${own} ${foreign} ${dead}` } },
      ...(id === PRIVATE_SID ? [
        { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "publish", name: "Artifact", input: { action: "publish", title: "Hiring review", file_path: report } }] } },
        { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "publish", content: `Published ${report} at ${reportUrl}` }] }, toolUseResult: { url: reportUrl, path: report, title: "Hiring review" } },
      ] : []),
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  }
  await d.ctx.service<{ reindex(): Promise<unknown> }>("sessions").reindex();
});
afterAll(async () => { for (const m of [...d.modules].reverse()) await m.stop?.(); });

describe("knowledge admission", () => {
  it("admits plain source identities without constructing rejected URLs", () => {
    const NativeURL = URL;
    let rejected = 0;
    class MeasuredURL extends NativeURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        try { super(...args); } catch (error) { rejected++; throw error; }
      }
    }
    const rules: KnowledgePolicy = { ...policy, tombstones: [
      { source: "note-removed", reason: "Removed note" },
      { source: "/tmp/removed.html", reason: "Removed report" },
      { source: dead, reason: "Removed URL" },
    ] };
    vi.stubGlobal("URL", MeasuredURL);
    try {
      expect(gate.admitKnowledge({ id: "note-kept" }, rules)).toBe(true);
      expect(gate.admitKnowledge({ id: "note-removed" }, rules)).toBe(false);
      expect(gate.admitKnowledge({ local_source: "/tmp/removed.html" }, rules)).toBe(false);
      expect(gate.admitKnowledge({ url: `${dead}/files?diff=1#comment` }, rules)).toBe(false);
      console.log(JSON.stringify({ operation: "normal source admission", rejectedURLConstructions: rejected }));
      expect(rejected).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("admits owned PR/repository/issue links and rejects third-party links", () => {
    for (const suffix of ["pull/7", "issues/4", ""]) expect(gate.admitKnowledge({ url: `https://github.com/captain/work/${suffix}` }, policy)).toBe(true);
    expect(gate.admitKnowledge({ url: foreign }, policy)).toBe(false);
    expect(gate.admitKnowledge({ url: "https://github.com/captain/work-fork/pull/7" }, policy)).toBe(false);
    expect(gate.forgeRepo("git@bitbucket.org:Owner/Repo.git")).toBe("bitbucket.org/owner/repo");
  });
  it("rejects hiring paths, encoded Claude paths and private session identities", () => {
    expect(gate.admitKnowledge({ url: own, cwd: privateCwd }, policy)).toBe(false);
    expect(gate.admitKnowledge({ cwd: `${privateCwd.replace(/[^A-Za-z0-9]/g, "-")}/scratchpad` }, policy)).toBe(false);
    expect(gate.admitKnowledge({ session: "codex:private" }, { ...policy, private_sessions: ["codex:private"] })).toBe(false);
    expect(gate.admitKnowledge({ cwd: `${path.dirname(privateCwd)}-public` }, policy)).toBe(true);
    expect(gate.admitKnowledge({ provenance: { type: "imported", ref: `${privateCwd}/memory/resume.md` } }, policy)).toBe(false);
  });
  it("rejects tombstones across URL variants and index rebuilds", async () => {
    expect(gate.admitKnowledge({ url: `${dead}/files?diff=1#comment` }, policy)).toBe(false);
    await artifacts.scan();
    const ours = artifacts.list().filter(a => a.session === `claude:${SID}`);
    expect(ours.map(a => a.url)).toEqual([own]);
    expect(artifacts.list().some(a => a.url === dead || a.url === foreign)).toBe(false);
    d.ctx.db.prepare("DELETE FROM artifact_scan").run();
    await artifacts.scan();
    expect(artifacts.list().some(a => a.url === dead || a.url === foreign)).toBe(false);
    expect((await d.req("POST", "/api/artifacts", { url: `${dead}/files` })).status).toBe(409);
  });
  it("keeps authored hiring reports privately while refusing both distillation paths", async () => {
    const report = artifacts.list().find(a => a.url === reportUrl);
    expect(report).toMatchObject({ private: true, title: "Hiring review", session: `claude:${PRIVATE_SID}` });
    expect(report).toBeDefined();
    if (!report) throw new Error("Missing retained report");
    expect((await d.app.request(`/api/artifacts/${report.id}/distill`, { method: "POST" })).status).toBe(404);
    expect((await d.app.request(`/api/artifacts/${report.id}/distilled`, { method: "POST" })).status).toBe(404);
    const knowledge = d.ctx.service<KnowledgeService>("knowledge");
    knowledge.prepare();
    expect(knowledge.search({ q: "Hiring review" }).items.some(a => a.ref.id === report.id)).toBe(true);
    expect(knowledge.search({ types: ["sessions"] }).items.some(a => a.ref.id === `claude:${PRIVATE_SID}`)).toBe(false);
  });
  it("skips hiring trace extraction and auto-memory imports", async () => {
    expect((await d.req("POST", "/api/learnings/extract", { session: `claude:${PRIVATE_SID}` })).status).toBe(404);
    const dir = path.join(paths.claudeDir, "projects", privateCwd.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "candidate.md"), "# Candidate résumé\n\nPrivate details\n");
    expect((await d.req("GET", "/api/artifacts/admission")).body.owned_repos).toContain("github.com/captain/work");
  });
});
