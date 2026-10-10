import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import type { KnowledgeService } from "../../src/modules/knowledge/index.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";
import type { NotesService } from "../../src/modules/notes/index.ts";
import type { MissionsService } from "../../src/modules/missions/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let service: KnowledgeService;
let artifacts: ArtifactsService;
let notes: NotesService;
let report: string;
let note: string;
const IDEA = "source-search", TASK = "source-task", TERM = "spectrograph";
const tasks = () => [{ id: TASK, title: `${TERM} task`, status: "working", last_event: "Inspect the exported file", updated: "2026-10-05T00:00:00Z", worktree: null, repo: null }];
beforeAll(async () => {
  d = await sandboxDaemon("knowledge", ["sessions", "missions", "notes", "artifacts", "knowledge"]);
  service = d.ctx.service<KnowledgeService>("knowledge");
  artifacts = d.ctx.service<ArtifactsService>("artifacts");
  notes = d.ctx.service<NotesService>("notes");
  d.ctx.services.set("firstmate", { tasks });
  d.ctx.service<MissionsService>("missions").create({ id: IDEA, title: `${TERM} idea`, goal: "Find the source", crews: [TASK], repos: ["/repos/source-search"] });
  note = notes.create({ task: TASK, bullets: [`${TERM} note: save first`] }).id;
  const { paths } = await import("../../src/shared/paths.ts");
  const file = path.join(paths.root, "source-report.md");
  fs.writeFileSync(file, `# A quiet report\n\n## ${TERM} heading-only finding\n\nRead the source.\n`);
  report = artifacts.register({ local_source: file, title: "A quiet report", kind: "report", mission: IDEA }).id;
  await d.ctx.service<{ reindex(): Promise<unknown> }>("sessions").reindex();
});
beforeEach(() => service.prepare());
afterAll(async () => { vi.useRealTimers(); await d.stop(); });

describe("search over authored and projected sources", () => {
  it("finds ideas, tasks, authored notes and report text without a memory module", async () => {
    const result = service.search({ q: TERM });
    expect(result.items.map(i => i.key)).toEqual(expect.arrayContaining([`idea:${IDEA}`, `task:${TASK}`, `note:${note}`, `artifact:${report}`]));
    const { KnowledgeItem } = await import("../../src/shared/knowledge.ts");
    for (const item of result.items) expect(KnowledgeItem.safeParse(item).success).toBe(true);
    expect(result.items.some(i => String(i.ref.entity) === "memory")).toBe(false);
    expect(result.items.every(i => i.review.length === 0)).toBe(true);
    expect(result.notices.join(" ")).not.toContain("memory");
  });
  it("finds heading-only matches in the artifact snapshot", () => {
    expect(service.search({ q: "heading-only", types: ["reports"] }).items.map(i => i.ref.id)).toEqual([report]);
  });
  it("joins a task note through its idea and project and opens the Board", () => {
    const result = service.search({ types: ["notes"], idea: IDEA, task: TASK, project: "source-search" });
    expect(result.items.map(i => i.ref.id)).toContain(note);
    expect(result.items.find(i => i.ref.id === note)?.href).toBe(`#/board?item=${note}`);
  });
  it("excludes private ideas, tasks and notes from aggregate search", () => {
    const missions = d.ctx.service<MissionsService>("missions");
    missions.create({ id: "private-idea", title: "Hidden source", private: true, crews: ["private-task"] });
    notes.create({ idea: "private-idea", bullets: ["Hidden source note"] });
    d.ctx.services.set("firstmate", { tasks: () => [...tasks(), { ...tasks()[0], id: "private-task", title: "Hidden source task" }] });
    service.prepare();
    expect(service.search({ q: "Hidden source" }).items.map(i => i.ref.id)).not.toContain("private-idea");
    expect(service.search({ q: "Hidden source" }).items.map(i => i.ref.id)).not.toContain("private-task");
    d.ctx.services.set("firstmate", { tasks });
  });
  it("searches projected session titles and cached goals without invoking a model", () => {
    const session = d.ctx.service<{ list(): { key: string; title: string }[] }>("sessions").list()[0];
    d.ctx.services.set("intentions", { get: (key: string) => key === session.key ? { goal: "polarimeter goal" } : null });
    service.prepare();
    expect(service.search({ q: "polarimeter", types: ["sessions"] }).items.map(i => i.ref.id)).toContain(session.key);
    d.ctx.services.delete("intentions");
  });
  it("serves partial results when a source is missing or unreadable", () => {
    const original = artifacts.list;
    artifacts.list = () => { throw new Error("Unreadable registry"); };
    try { service.prepare(); expect(service.search({ q: TERM }).notices.join(" ")).toContain("Unreadable registry"); }
    finally { artifacts.list = original; }
    d.ctx.services.delete("artifacts");
    try { service.prepare(); expect(service.search({ q: TERM }).items.map(i => i.ref.id)).toContain(note); }
    finally { d.ctx.services.set("artifacts", artifacts); }
  });
  it("keeps facets and pagination across the full snapshot", () => {
    const all = service.search({ limit: 500 });
    const first = service.search({ limit: 3 }), second = service.search({ limit: 3, offset: 3 });
    expect([...first.items, ...second.items].map(i => i.key)).toEqual(all.items.slice(0, 6).map(i => i.key));
    expect(first.facets).toEqual(all.facets);
    expect(first.total).toBe(all.total);
  });
  it("links authored captain answers to the source report", async () => {
    const { paths } = await import("../../src/shared/paths.ts");
    const answer = notes.create({ task: TASK, provenance: { type: "human", ref: "answer_ask:request" }, body: `## Answer\n\nKeep it\n\nReport: [Finding](${path.join(paths.root, "source-report.md")})` });
    service.prepare();
    expect(service.relations({ entity: "note", id: answer.id })?.relations).toContainEqual({ kind: "answered-by", from: { entity: "artifact", id: report }, to: { entity: "note", id: answer.id } });
  });
  it("never commits authored data while answering a query", () => {
    const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: d.sb.env.JOYRIDE_HOME, encoding: "utf8" });
    const before = head(); service.search({ q: TERM }); service.relations({ entity: "artifact", id: report }); expect(head()).toBe(before);
  });
  it("validates search and relations boundaries and returns no-data results", async () => {
    expect(service.search({ q: "absentterm" }).items).toEqual([]);
    for (const query of ["types=rules", "mode=agents", "state=candidate", "limit=0", "anchor=bad"]) expect((await d.req("GET", `/api/knowledge/search?${query}`)).status).toBe(400);
    expect((await d.req("GET", "/api/knowledge/relations?entity=memory&id=old")).status).toBe(400);
    expect((await d.req("GET", "/api/knowledge/relations?entity=idea&id=missing")).status).toBe(404);
    expect((await d.req("GET", "/api/memory")).status).toBe(404);
  });
  it("fuses independent ranks deterministically without duplicate hits", async () => {
    const { reciprocalRankFusion } = await import("../../src/modules/knowledge/rank.ts");
    expect([...reciprocalRankFusion([["a", "a", "b"], ["b"]])]).toEqual([["a", 1 / 61], ["b", 1 / 62 + 1 / 61]]);
  });
});
