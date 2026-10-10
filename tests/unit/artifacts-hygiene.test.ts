import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon, rewriteTimes } from "../sandbox.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";
import type { KnowledgeService } from "../../src/modules/knowledge/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let artifacts: ArtifactsService;
let hygiene: typeof import("../../src/modules/artifacts/hygiene.ts");
let store: typeof import("../../src/modules/artifacts/store.ts");
let blobs: typeof import("../../src/modules/evidence/blobs.ts");
let paths: typeof import("../../src/shared/paths.ts").paths;
const privateSession = "claude:bbbbbbbb-1111-4111-8111-111111111111";
const secret = "hiringonlyquasar";
let cwd: string;
let raw: string;
beforeAll(async () => {
  d = await sandboxDaemon("artifact-hygiene", ["sessions", "missions", "artifacts", "knowledge"]);
  paths = (await import("../../src/shared/paths.ts")).paths;
  expect(paths.runtime.startsWith(d.sb.dir)).toBe(true);
  hygiene = await import("../../src/modules/artifacts/hygiene.ts");
  store = await import("../../src/modules/artifacts/store.ts");
  blobs = await import("../../src/modules/evidence/blobs.ts");
  artifacts = d.ctx.service<ArtifactsService>("artifacts");
  cwd = path.join(d.sb.dir, "hiring_notes", "candidate");
  d.ctx.config.knowledge.private_paths.push(path.dirname(cwd));
  d.ctx.config.knowledge.private_sessions.push(privateSession);
  const fixture = fs.readFileSync(path.resolve("tests/fixtures/knowledge/hiring-session.jsonl"), "utf8").replaceAll("{{PRIVATE_CWD}}", cwd);
  const dir = path.join(paths.claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${privateSession.slice(7)}.jsonl`), rewriteTimes(fixture));
  await d.ctx.service<import("../../src/modules/sessions/types.ts").SessionsService>("sessions").reindex();
  raw = `# Session context: mixed\n\nThese 2 sessions were saved.\n\n## Owned work\n\nSession: \`claude:owned-session\`. Cwd: \`/owned/repo\`.\n\nKeep publicobservatory.\n\n## Candidate review\n\nSession: \`${privateSession}\`. Cwd: \`${cwd}\`.\n\n## Nested transcript heading\n\n${secret} confidential evaluation.\n`;
});
afterAll(async () => { for (const m of [...d.modules].reverse()) await m.stop?.(); });

it("keeps both customer-derived Acme cards private through the configured admission rule", async () => {
  const folder = "/Users/alice/Documents/Code/joyride/.joyride/firstmate/data/acme-planner-research";
  d.ctx.config.knowledge.private_paths.push(folder);
  const policy = (await import("../../src/core/knowledge-policy.ts")).knowledgePolicy(d.ctx);
  const ids = ["rep-acme-planner-research-5ffffe", "rep-acme-planner-research-full-briefing-8c976f"];
  for (const [i, id] of ids.entries()) {
    const blob = blobs.putBlobBuffer(`# Customer briefing ${i}\n\nConfidential customer finding.\n`);
    store.writeArtifact(paths.artifacts, store.StoredArtifact.parse({ id, title: `Acme customer briefing ${i}`, kind: "report", url: null,
      local_source: `${folder}/${i ? "briefing.html" : "report.md"}`, private: false, snapshot_blob: blob,
      content_type: "text/markdown", embeddable: true, summary: "Customer research.", created: new Date().toISOString() }));
    const card = artifacts.get(id)!;
    expect(card.private).toBe(true);
    expect(policy.admits(card)).toBe(false);
    expect(policy.note({ provenance: { type: "artifact", ref: id } })).toBe(false);
    expect((await d.req("GET", `/api/artifacts/${id}/text`)).body.text).toContain("Confidential customer finding.");
  }
  const knowledge = d.ctx.service<KnowledgeService>("knowledge");
  knowledge.prepare();
  expect(knowledge.search({ q: "Acme customer" }).items.map(i => i.ref.id).sort()).toEqual(ids.sort());
  const catalog = hygiene.artifactFilter(d.ctx).text(JSON.stringify(ids.map(id => artifacts.get(id))), "application/json");
  expect(catalog).not.toContain("Acme customer briefing");
});

it("removes private sections before new registrations, keeps private reports and survives source teardown", async () => {
  const reportFile = path.join(d.sb.dir, ".treehouse", "slot", "dossier.md");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, raw);
  const report = artifacts.register({ title: "Session context: mixed", local_source: reportFile });
  expect(report.local_source).toBeNull();
  expect(report.source_key).toMatch(/^[a-f0-9]{64}$/);
  expect(blobs.blobPath(report.snapshot_blob!)).toContain(paths.runtime);
  expect(fs.readFileSync(blobs.blobPath(report.snapshot_blob!), "utf8")).toContain("publicobservatory");
  expect(fs.readFileSync(blobs.blobPath(report.snapshot_blob!), "utf8")).not.toContain(secret);
  expect(artifacts.register({ title: "Session context: mixed", local_source: reportFile }).id).toBe(report.id);
  fs.rmSync(path.dirname(reportFile), { recursive: true });
  expect((await d.req("GET", `/api/artifacts/${report.id}/text`)).status).toBe(200);
  const privateFile = path.join(cwd, "review.md");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(privateFile, `# Private review\n\n${secret}`);
  const review = artifacts.register({ local_source: privateFile, session: privateSession });
  expect(review.private).toBe(true);
  expect(fs.readFileSync(blobs.blobPath(review.snapshot_blob!), "utf8")).toContain(secret);
  expect((await d.app.request(`/api/artifacts/${review.id}/distill`, { method: "POST" })).status).toBe(404);
  const knowledge = d.ctx.service<KnowledgeService>("knowledge");
  knowledge.prepare();
  expect(knowledge.search({ q: secret }).items.map(i => i.ref.id)).toEqual([review.id]);
  expect(knowledge.search({ q: "publicobservatory" }).items.map(i => i.ref.id)).toContain(report.id);
});

it("repairs current and previous aggregate snapshots on startup, commits and repeats without changes", async () => {
  const old = blobs.putBlobBuffer(raw);
  const report = store.StoredArtifact.parse({ id: "rep-legacy-mixed", url: null, kind: "report", title: "Session context: mixed legacy", created: new Date().toISOString(),
    snapshot_blob: old, content_type: "text/markdown", local_source: "/missing/.treehouse/slot/report.md",
    summary: "Preserved context for 2 historical sessions", notes: "Preserved context for 2 historical sessions" });
  store.writeArtifact(paths.artifacts, report);
  const privateReport = artifacts.list().find(a => a.private)!;
  const before = fs.readFileSync(path.join(paths.artifacts, `${privateReport.id}.md`), "utf8");
  await d.modules.find(m => m.name === "artifacts")!.start!(d.ctx);
  const repaired = artifacts.get(report.id)!;
  expect(repaired.local_source).toBeNull();
  expect(repaired.snapshot_blob).not.toBe(old);
  expect(repaired.summary).toBe("Preserved context for 1 historical sessions");
  for (const sha of [repaired.snapshot_blob]) expect(fs.readFileSync(blobs.blobPath(sha!), "utf8")).not.toContain(secret);
  expect(fs.existsSync(blobs.blobPath(old))).toBe(false);
  expect(fs.readFileSync(path.join(paths.artifacts, `${privateReport.id}.md`), "utf8")).toBe(before);
  expect(execFileSync("git", ["show", `HEAD:artifacts/${report.id}.md`], { cwd: paths.root, encoding: "utf8" })).toContain(repaired.snapshot_blob);
  expect(hygiene.repairArtifactSnapshots(d.ctx)).toMatchObject({ redacted: 0, repointed: 0, commit: null });
  d.ctx.service<KnowledgeService>("knowledge").prepare();
  expect(d.ctx.service<KnowledgeService>("knowledge").search({ q: secret }).items.some(i => i.ref.id === report.id)).toBe(false);
});

it("filters JSON recovery inventories, decision sections, and table rows using private source identities", async () => {
  const filter = hygiene.artifactFilter(d.ctx);
  const json = [{ id: "unknown-private", private: true, summary: secret }, { id: "mp-private", sessions: [{ source: "claude", id: "bbbbbbbb-1111-4111-8111-111111111111" }], summary: secret }, { id: "mp-own", sessions: [{ source: "claude", id: "owned-session" }], summary: "own finding" }];
  const raw = `# Sorting digest\n\n## Recovery\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n\n## Decisions\n\n### mp-private\n\n${secret}\n\n### mp-own\n\nKeep owned decision.\n\n## Rows\n\n| Session | Finding |\n| --- | --- |\n| ${privateSession} | ${secret} |\n| claude:owned-session | publicobservatory |\n`;
  const clean = filter.text(raw);
  expect(clean).not.toContain(secret);
  expect(clean).not.toContain("mp-private");
  expect(clean).toContain("mp-own");
  expect(clean).toContain("Keep owned decision.");
  expect(clean).toContain("publicobservatory");
  expect(clean).toContain("| Session | Finding |\n| --- | --- |\n| claude:owned-session | publicobservatory |");
});

it("refuses hiring sessions before saved resume context or proposal digest extraction", async () => {
  const preserve = await import("../../src/modules/fleet/preserve.ts");
  const schema = await import("../../src/shared/schema.ts");
  const worker = schema.WorkerView.parse({ id: "private-worker", session: privateSession, cwd, agent: "claude", machine: "local", status: "idle", title: "Hiring", pane: null, pid: null, repo: null, controllable: false, updated: new Date().toISOString() });
  await expect(preserve.preserveSession(d.ctx, worker)).rejects.toThrow(/private session/);
  const { createProposalContext } = await import("../../src/modules/missions/proposal-context.ts");
  const svc = createProposalContext(d.ctx, { proposals: () => [], get: () => null, missionTitle: () => null });
  const item = d.ctx.service<import("../../src/modules/sessions/types.ts").SessionsService>("sessions").get(privateSession);
  expect(item).toBeDefined();
  if (!item) throw new Error("Missing interview fixture session");
  expect(await svc.digestOf(item)).toMatchObject({ first_prompt: null, last_prompts: [], final_message: "", prompt_count: 0 });
  svc.dispose();
});


it("keeps unrelated session blocks byte for byte when transcript excerpts have unclosed fences", () => {
  const filter = hygiene.artifactFilter(d.ctx);
  const owned = `## Owned work\n\nSession: \`claude:own-one\`. Cwd: \`/owned/repo\`.\n\n\`\`\`python\nprint("unclosed historical excerpt")\n\n`;
  const privateBlock = `## Review\n\nSession: \`${privateSession}\`. Cwd: \`${cwd}\`.\n\n${secret}\n\n`;
  const other = `## Another owned session\n\nSession: \`codex:own-two\`. Cwd: \`/owned/repo\`.\n\nKeep this exact excerpt.\n`;
  const clean = filter.text(`# Dossier\n\nThese 3 sessions were saved.\n\n${owned}${privateBlock}${other}`);
  expect(clean).toContain(owned);
  expect(clean).toContain(other);
  expect(clean).not.toContain(secret);
  expect(clean).toContain("These 2 sessions");
});

it("removes hiring records from an HTML JSON catalog without changing its surrounding document", () => {
  const filter = hygiene.artifactFilter(d.ctx);
  const raw = `<html><h1>Storage report</h1><script type="application/json" id="catalog">${JSON.stringify([{ path: cwd, title: secret }, { path: "/owned/data", title: "Retain" }])}</script><script>renderCatalog()</script></html>`;
  const clean = filter.text(raw, "text/html");
  expect(clean).not.toContain(secret);
  expect(clean).toContain('<h1>Storage report</h1>');
  expect(clean).toContain('<script>renderCatalog()</script>');
  expect(clean).toContain('"Retain"');
});


it("uses a hosted URL when a disposable file cannot be snapshotted and rejects an unsaved local-only source", () => {
  const file = path.join(d.sb.dir, ".treehouse", "large.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "large");
  fs.truncateSync(file, 26 * 1024 * 1024);
  expect(() => artifacts.register({ local_source: file })).toThrow(/disposable folder/);
  const hosted = artifacts.register({ local_source: file, url: "https://claude.ai/artifact/stable-large-report" });
  expect(hosted.local_source).toBeNull();
  expect(hosted.url).toBe("https://claude.ai/artifact/stable-large-report");
  expect(hosted.snapshot_blob).toBeNull();
});


it("retains a blob shared with a private report and cleans it after the last reference is removed", () => {
  const old = blobs.putBlobBuffer(raw);
  const publicReport = store.StoredArtifact.parse({ id: "rep-shared-public", url: null, kind: "report", title: "Mixed dossier", created: new Date().toISOString(), snapshot_blob: old, content_type: "text/markdown" });
  const privateReport = store.StoredArtifact.parse({ ...publicReport, id: "rep-shared-private", private: true });
  store.writeArtifact(paths.artifacts, publicReport);
  const privateFile = store.writeArtifact(paths.artifacts, privateReport);
  hygiene.repairArtifactSnapshots(d.ctx);
  expect(fs.existsSync(blobs.blobPath(old))).toBe(true);
  expect(store.readArtifact(paths.artifacts, privateReport.id)?.snapshot_blob).toBe(old);
  fs.rmSync(privateFile);
  hygiene.repairArtifactSnapshots(d.ctx);
  expect(fs.existsSync(blobs.blobPath(old))).toBe(false);
});
