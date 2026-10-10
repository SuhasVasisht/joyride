// The artifacts review list: merging one artifact found several ways, newest
// first ordering, facets and paging (pure), then the daemon route, the
// reviewed mark and its speed on a registry several times today's size.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sandboxDaemon } from "../sandbox.ts";
import {
  claudeArtifactId, groupDuplicates, identityKeys, mergeArtifacts, reviewPage, sourceOf, NO_IDEA, type ReviewInput, type ReviewPage,
} from "../../src/shared/artifact-review.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";

const base = (o: Partial<ReviewInput> & { id: string }): ReviewInput => ({
  title: o.id, kind: "report", url: null, local_source: null, snapshot_blob: null, content_type: null, embeddable: false,
  created: "2026-10-01T00:00:00.000Z", updated: null, summary: "", mission: null, session: null, session_title: null,
  project: null, detected_from: "manual", firstmate: null, ...o,
});

describe("identity and source", () => {
  it("reads one Claude artifact id from every claude.ai link form", () => {
    expect(claudeArtifactId("https://claude.ai/artifact/AbCdEf12")).toBe("abcdef12");
    expect(claudeArtifactId("https://claude.ai/code/artifact/0f0f0f0f-1111-4222-8333-444455556666")).toBe("0f0f0f0f-1111-4222-8333-444455556666");
    expect(claudeArtifactId("https://claude.ai/public/artifacts/abcdef12")).toBe("abcdef12");
    expect(claudeArtifactId("https://github.com/acme/x/pull/1")).toBeNull();
    expect(identityKeys(base({ id: "a", url: "https://claude.ai/code/artifact/abcdef12", local_source: "/tmp/x.html", snapshot_blob: "f".repeat(64) })))
      .toEqual(["claude:abcdef12", "file:/tmp/x.html", `blob:${"f".repeat(64)}`]);
  });
  it("labels Firstmate reports apart from other reports", () => {
    expect(sourceOf({ kind: "report", firstmate: { task: "t", modified: null } })).toBe("firstmate");
    expect(sourceOf({ kind: "report", firstmate: null })).toBe("report");
    expect(sourceOf({ kind: "claude-artifact", firstmate: null })).toBe("claude");
    expect(sourceOf({ kind: "other", firstmate: null })).toBe("link");
  });
});

describe("merge and dedupe", () => {
  const published = base({ id: "cla-bench", kind: "claude-artifact", title: "Claude artifact from “parser work”", url: "https://claude.ai/code/artifact/abcdef12", local_source: "/w/bench.html", snapshot_blob: "a".repeat(64), embeddable: true, detected_from: "artifact-tool", created: "2026-10-03T10:00:00.000Z", session: "claude:s1", session_title: "Parser work" });
  const linked = base({ id: "cla-bench-link", kind: "claude-artifact", title: "Claude artifact from “parser work”", url: "https://claude.ai/artifact/ABCDEF12", detected_from: "transcript", created: "2026-10-03T09:00:00.000Z" });
  const registered = base({ id: "rep-bench", title: "Parser benchmark", local_source: "/w/bench.html", detected_from: "manual", created: "2026-10-02T00:00:00.000Z", mission: "parser-speed" });
  const copy = base({ id: "rep-copy", title: "Parser benchmark copy", local_source: "/elsewhere/bench.html", snapshot_blob: "a".repeat(64), created: "2026-10-01T00:00:00.000Z" });
  const other = base({ id: "rep-other", title: "Other report", local_source: "/w/other.md", snapshot_blob: "b".repeat(64), created: "2026-10-04T00:00:00.000Z" });
  const pr = base({ id: "pr-1", kind: "pr", title: "acme/x pull request #1", url: "https://github.com/acme/x/pull/1", detected_from: "transcript", created: "2026-09-30T00:00:00.000Z" });
  const saved = base({ id: "ses-1", kind: "session", title: "Saved session", local_source: "/w/s.json", created: "2026-10-05T00:00:00.000Z" });

  it("joins rows that share a Claude id, a file or a snapshot, transitively", () => {
    const groups = groupDuplicates([published, linked, registered, copy, other, pr]);
    expect(groups.map((g) => g.map((a) => a.id).sort())).toEqual([["cla-bench", "cla-bench-link", "rep-bench", "rep-copy"], ["rep-other"], ["pr-1"]]);
  });

  it("merges a group into one row led by the best-found member", () => {
    const [row] = mergeArtifacts([registered, linked, copy, published]);
    expect(row.id).toBe("cla-bench");
    expect(row.ids.sort()).toEqual(["cla-bench", "cla-bench-link", "rep-bench", "rep-copy"]);
    expect(row.source).toBe("claude");
    expect(row.sources.sort()).toEqual(["claude", "report"]);
    expect(row.title).toBe("Parser benchmark"); // a real title beats the generated "Claude artifact from …"
    expect(row.url).toBe("https://claude.ai/code/artifact/abcdef12");
    expect(row.local && row.embeddable).toBe(true);
    expect(row.mission).toBe("parser-speed"); // filled from a member when the lead has none
    expect(row.session_title).toBe("Parser work");
    expect(row.at).toBe("2026-10-03T10:00:00.000Z");
    expect(row.created).toBe("2026-10-01T00:00:00.000Z");
  });

  it("sorts newest first, uses a Firstmate report's own date and drops saved sessions", () => {
    const fm = base({ id: "rep-fm", title: "Firstmate findings", local_source: "/fm/data/t/report.md", detected_from: "firstmate", created: "2026-09-01T00:00:00.000Z", firstmate: { task: "t", modified: "2026-10-04T12:00:00.000Z" } });
    const rows = mergeArtifacts([pr, other, published, fm, saved]);
    expect(rows.map((r) => r.id)).toEqual(["rep-fm", "rep-other", "cla-bench", "pr-1"]);
    expect(rows[0].source).toBe("firstmate");
    expect(rows[0].firstmate_task).toBe("t");
  });

  it("keeps distinct artifacts apart even with the same generated title", () => {
    const a = base({ id: "cla-a", kind: "claude-artifact", title: "Claude artifact from “x”", url: "https://claude.ai/artifact/aaaaaa11" });
    const b = base({ id: "cla-b", kind: "claude-artifact", title: "Claude artifact from “x”", url: "https://claude.ai/artifact/bbbbbb22" });
    expect(mergeArtifacts([a, b])).toHaveLength(2);
  });
});

describe("filters, facets and paging", () => {
  const titles: Record<string, string> = { "parser-speed": "Parser speed", "kb": "Knowledge base" };
  const list: ReviewInput[] = Array.from({ length: 120 }, (_, i) => base({
    id: `a-${String(i).padStart(3, "0")}`, title: `Artifact ${i}${i % 10 === 0 ? " benchmark" : ""}`,
    kind: i % 3 === 0 ? "claude-artifact" : "report", url: i % 3 === 0 ? `https://claude.ai/artifact/id${String(i).padStart(6, "0")}` : null,
    local_source: i % 3 === 0 ? null : `/r/${i}.md`, created: new Date(Date.UTC(2026, 8, 1) + i * 3600e3).toISOString(),
    mission: i % 2 === 0 ? "parser-speed" : i % 5 === 0 ? "kb" : null,
  }));
  const rows = mergeArtifacts(list, (id) => titles[id] ?? null);

  it("pages newest first", () => {
    const p1 = reviewPage(rows, { limit: 50 });
    const p3 = reviewPage(rows, { offset: 100, limit: 50 });
    expect(p1.total).toBe(120);
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0].id).toBe("a-119");
    expect(p3.items.map((i) => i.id)).toEqual(Array.from({ length: 20 }, (_, i) => `a-${String(19 - i).padStart(3, "0")}`));
    expect(reviewPage(rows, { limit: 100000 }).limit).toBe(500);
  });

  it("filters by source, idea and words, with honest facet counts", () => {
    const p = reviewPage(rows, { source: "claude", idea: "parser-speed", q: "benchmark" });
    expect(p.items.every((i) => i.source === "claude" && i.mission === "parser-speed" && /benchmark/.test(i.title))).toBe(true);
    expect(p.items.map((i) => i.id)).toEqual(["a-090", "a-060", "a-030", "a-000"]);
    // Source counts ignore the source filter; idea counts ignore the idea filter.
    const s = reviewPage(rows, { source: "claude" });
    expect(s.sources.find((f) => f.id === "report")?.n).toBe(80);
    expect(s.sources.find((f) => f.id === "claude")?.n).toBe(40);
    expect(s.any_source).toBe(120);
    expect(s.ideas.find((f) => f.id === "parser-speed")).toEqual({ id: "parser-speed", title: "Parser speed", n: 20 });
    expect(s.ideas[s.ideas.length - 1].id).toBe(NO_IDEA);
    expect(reviewPage(rows, { idea: NO_IDEA }).items.every((i) => !i.mission)).toBe(true);
    expect(reviewPage(rows, { q: "kNowledge BASE" }).items.every((i) => i.mission === "kb")).toBe(true);
  });
});

describe("daemon route", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let svc: ArtifactsService;
  let dir: string;
  beforeAll(async () => {
    d = await sandboxDaemon("artifacts-review", ["missions", "artifacts"]);
    svc = d.ctx.service<ArtifactsService>("artifacts");
    dir = path.join(d.sb.dir, "files");
    fs.mkdirSync(dir, { recursive: true });
  });

  it("lists registered artifacts merged across sources without review marks", async () => {
    const file = path.join(dir, "bench.html");
    fs.writeFileSync(file, "<!doctype html><title>Bench</title><p>fast</p>");
    const local = (await d.req("POST", "/api/artifacts", { local_source: file })).body;
    const linked = (await d.req("POST", "/api/artifacts", { url: "https://claude.ai/artifact/abcdef12", title: "Bench page" })).body;
    const again = (await d.req("POST", "/api/artifacts", { url: "https://claude.ai/code/artifact/abcdef12" })).body;
    expect(again.deduped).toBe(false); // the registry keeps both link forms...
    const p: ReviewPage = (await d.req("GET", "/api/artifacts/review?limit=10")).body;
    const row = p.items.find((i) => i.ids.includes(linked.id))!;
    expect(row.ids.sort()).toEqual([again.id, linked.id].sort()); // ...the review list shows them once
    expect(p.items.some((i) => i.id === local.id)).toBe(true);
    expect((p.items[0] as any).notes).toBeUndefined(); // rows stay slim

    expect((await d.app.request("/api/artifacts/reviewed", { method: "POST" })).status).toBe(404);
  });

  it("answers a page quickly on a registry ten times today's size", async () => {
    const S = await import("../../src/modules/artifacts/store.ts");
    const adir = (await import("../../src/shared/paths.ts")).paths.artifacts;
    for (let i = 0; i < 1200; i++) {
      S.writeArtifact(adir, S.StoredArtifact.parse({
        id: `cla-bulk-${i}`, title: `Bulk ${i}`, kind: "claude-artifact", url: `https://claude.ai/artifact/bulk${String(i).padStart(6, "0")}`,
        created: new Date(Date.UTC(2026, 0, 1) + i * 60e3).toISOString(), summary: "x".repeat(400), notes: "## Summary\n\n" + "y".repeat(2000),
      }));
    }
    await d.req("GET", "/api/artifacts/review?limit=1"); // warm the file cache, as the running daemon is
    // Best of three, so a busy machine running the whole suite in parallel does not decide it.
    let ms = Infinity, res: any = null;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      res = await d.req("GET", "/api/artifacts/review?limit=50");
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(res.body.total).toBeGreaterThanOrEqual(1200);
    expect(res.body.items).toHaveLength(50);
    expect(JSON.stringify(res.body).length).toBeLessThan(60_000);
    expect(ms).toBeLessThan(500);
  });
});
