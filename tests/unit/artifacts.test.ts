// Artifact registry: URL handling, transcript detection, registration with
// snapshots and dedupe, the sandboxed preview route, and authored summaries.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";

// Only type imports above: src/shared/paths.ts reads the sandbox env at import time.
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let svc: ArtifactsService;
let S: typeof import("../../src/modules/artifacts/store.ts");
let Det: typeof import("../../src/modules/artifacts/detect.ts");
let paths: typeof import("../../src/shared/paths.ts").paths;
let repo: string;
let report: string;
const SID = "a7a7a7a7-0000-4000-8000-00000000a001";

const line = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, userType: "external", cwd: repo, sessionId: SID, version: "2.1.0", gitBranch: "main", ...o });
function writeTranscript() {
  const dir = path.join(paths.claudeDir, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const ts = (m: number) => new Date(Date.now() - m * 60e3).toISOString();
  const rows = [
    line({ type: "user", timestamp: ts(30), uuid: "u1", origin: { kind: "human" }, message: { role: "user", content: "Write up the parser benchmark and share it. Earlier notes: https://chatgpt.com/share/abc123def456?x=1" } }),
    line({ type: "user", timestamp: ts(30), uuid: "u1m", isMeta: true, message: { role: "user", content: "<system-reminder>read links like claude.ai/artifact/{id} with the Artifact tool</system-reminder>" } }),
    line({ type: "assistant", timestamp: ts(29), uuid: "a1", message: { id: "m1", role: "assistant", model: "claude-opus", content: [{ type: "tool_use", id: "tu_pub", name: "Artifact", input: { file_path: report, description: "Parser benchmark" } }] } }),
    line({ type: "user", timestamp: ts(29), uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_pub", content: `Published ${report} at https://claude.ai/code/artifact/0f0f0f0f-1111-4222-8333-444455556666 (Version 1)` }] },
      toolUseResult: { url: "https://claude.ai/code/artifact/0f0f0f0f-1111-4222-8333-444455556666", path: report, artifact_id: "0f0f0f0f-1111-4222-8333-444455556666", title: "Parser benchmark" } }),
    line({ type: "assistant", timestamp: ts(28), uuid: "a2", message: { id: "m2", role: "assistant", model: "claude-opus", content: [{ type: "tool_use", id: "tu_read", name: "Artifact", input: { action: "read", url: "https://claude.ai/code/artifact/99999999-aaaa-4bbb-8ccc-dddddddddddd" } }] } }),
    line({ type: "user", timestamp: ts(28), uuid: "r2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_read", content: "page content of https://claude.ai/code/artifact/99999999-aaaa-4bbb-8ccc-dddddddddddd" }] }, toolUseResult: { url: "https://claude.ai/code/artifact/99999999-aaaa-4bbb-8ccc-dddddddddddd" } }),
    line({ type: "assistant", timestamp: ts(27), uuid: "a3", message: { id: "m3", role: "assistant", model: "claude-opus", content: [{ type: "text", text: "Published the benchmark. I also opened https://github.com/acme/parser/pull/42/files for the fix." }] } }),
  ];
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), rows.join("\n") + "\n");
}

beforeAll(async () => {
  d = await sandboxDaemon("artifacts", ["sessions", "missions", "live", "attention", "artifacts"]);
  paths = (await import("../../src/shared/paths.ts")).paths;
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  S = await import("../../src/modules/artifacts/store.ts");
  Det = await import("../../src/modules/artifacts/detect.ts");
  svc = d.ctx.service<ArtifactsService>("artifacts");
  repo = path.join(d.sb.dir, "repos", "parser");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/parser.git"], { cwd: repo });
  report = path.join(repo, "bench.html");
  fs.writeFileSync(report, "<!doctype html><title>Parser benchmark</title><h1>Parser benchmark</h1><p>The streaming parser is 3x faster than the DOM parser on large inputs. We keep the streaming parser.</p><script>console.log(1)</script>");
  writeTranscript();
  await d.ctx.service<any>("sessions").reindex();
  await d.modules.find((m) => m.name === "artifacts")!.start!(d.ctx);
});
afterAll(async () => { await d.modules.find((m) => m.name === "artifacts")?.stop?.(); });

describe("urls and detection", () => {
  it("normalizes and classifies links", () => {
    expect(S.normalizeUrl("https://github.com/acme/parser/pull/42/files?w=1).")).toBe("https://github.com/acme/parser/pull/42");
    expect(S.normalizeUrl("https://bitbucket.org/ws/repo/pull-requests/7/diff#x")).toBe("https://bitbucket.org/ws/repo/pull-requests/7");
    expect(S.normalizeUrl("http://chat.openai.com/c/abcdef123")).toBe("https://chatgpt.com/c/abcdef123");
    expect(S.kindOfUrl("https://claude.ai/artifact/abcdef12")).toBe("claude-artifact");
    expect(S.kindOfUrl("https://chatgpt.com/gpts")).toBe("other");
    expect(S.kindOfUrl("https://chatgpt.com/canvas/abcdef12")).toBe("chatgpt");
    expect(S.titleForUrl("https://github.com/acme/parser/pull/42", "pr")).toBe("acme/parser pull request #42");
  });
  it("finds real links in text and ignores placeholders", () => {
    const links = S.findLinks("see claude.ai/artifact/{id} and https://claude.ai/artifact/0a1b2c3d-x and **https://github.com/o/r/pull/3**, https://bitbucket.org/w/r/pull-requests/9");
    expect(links.map((l) => l.url).sort()).toEqual(["https://bitbucket.org/w/r/pull-requests/9", "https://claude.ai/artifact/0a1b2c3d-x", "https://github.com/o/r/pull/3"]);
  });
  it("turns HTML into readable text", () => {
    expect(S.htmlToText("<style>x{}</style><h1>Hi &amp; bye</h1><p>One</p><script>bad()</script>")).toBe("Hi & bye\nOne");
  });
  it("detects publishes, skips reads and meta records", () => {
    const st = Det.newScanState();
    const text = fs.readFileSync(path.join(paths.claudeDir, "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), `${SID}.jsonl`), "utf8");
    const found = text.split("\n").filter(Boolean).flatMap((l) => Det.detectLine(l, st));
    expect(found.map((f) => [f.kind, f.via, f.url])).toEqual([
      ["chatgpt", "transcript", "https://chatgpt.com/share/abc123def456"],
      ["claude-artifact", "artifact-tool", "https://claude.ai/code/artifact/0f0f0f0f-1111-4222-8333-444455556666"],
      ["pr", "transcript", "https://github.com/acme/parser/pull/42"],
    ]);
    expect(found[1].title).toBe("Parser benchmark");
    expect(found[1].local_source).toBe(report);
  });
});

describe("registry", () => {
  it("registers detected artifacts with session links and a snapshot, once", async () => {
    const r1 = await svc.scan();
    expect(r1.created).toBe(3);
    const pub = svc.list({ kind: "claude-artifact" })[0];
    expect(pub.title).toBe("Parser benchmark");
    expect(pub.session).toBe(`claude:${SID}`);
    expect(pub.detected_from).toBe("artifact-tool");
    expect(pub.snapshot_blob).toMatch(/^[a-f0-9]{64}$/);
    expect(pub.embeddable).toBe(true);
    expect(fs.existsSync(path.join(paths.artifacts, `${pub.id}.md`))).toBe(true);
    const log = execFileSync("git", ["log", "--format=%s", "-n1", "--", "artifacts"], { cwd: paths.root, encoding: "utf8" });
    expect(log).toContain("detected 3 new");
    const r2 = await svc.scan();
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);
    expect(svc.list().length).toBe(3);
  });

  it("dedupes manual registration by url and links a mission", async () => {
    d.ctx.service<any>("missions").create({ id: "parser-speed", title: "Parser speed" });
    const r = await d.req("POST", "/api/artifacts", { url: "https://github.com/acme/parser/pull/42#discussion", mission: "parser-speed" });
    expect(r.status).toBe(200);
    expect(r.body.deduped).toBe(true);
    expect(r.body.mission).toBe("parser-speed");
    expect(svc.list({ mission: "parser-speed" }).map((a) => a.kind)).toEqual(["pr"]);
  });

  it("registers a local file, refuses bad input with a clear error", async () => {
    const md = path.join(repo, "notes.md");
    fs.writeFileSync(md, "# Cache notes\n\nThe cache key must include the <locale>, otherwise users see stale translations.\n");
    const ok = await d.req("POST", "/api/artifacts", { local_source: md });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ kind: "report", title: "Cache notes", embeddable: true, url: null });
    expect((await d.req("POST", "/api/artifacts", { local_source: path.join(repo, "nope.md") })).body.error).toContain("No file at");
    expect((await d.req("POST", "/api/artifacts", { url: "ftp://x" })).status).toBe(400);
    expect((await d.req("POST", "/api/artifacts", {})).body.error).toContain("Give a url");
    expect((await d.req("POST", "/api/artifacts", { url: "https://github.com/a/b/pull/1", mission: "nope" })).body.error).toContain('No mission "nope"');
  });

  it("serves snapshots for a sandboxed iframe", async () => {
    const pub = svc.list({ kind: "claude-artifact" })[0];
    const r = await d.app.request(`/api/artifacts/${pub.id}/preview`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(await r.text()).toContain("streaming parser");
    const md = svc.list({ kind: "report" })[0];
    const r2 = await d.app.request(`/api/artifacts/${md.id}/preview`);
    expect(r2.headers.get("content-type")).toContain("text/html");
    expect(await r2.text()).toContain("&lt;");
    const pr = svc.list({ kind: "pr" })[0];
    expect((await d.app.request(`/api/artifacts/${pr.id}/preview`)).status).toBe(404);
    const expanded = await d.app.request(`/api/artifacts/${pub.id}/preview?expanded=1`);
    expect(expanded.headers.get("content-security-policy")).toContain("sandbox");
    expect(expanded.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    const expandedHtml = await expanded.text();
    expect(expandedHtml).toContain("joyride:preview-escape");
    expect(expandedHtml).toContain("parent.postMessage");
    expect(Number(expanded.headers.get("content-length"))).toBe(Buffer.byteLength(expandedHtml));
  });
});

describe("link cards", () => {
  it("keeps authored summaries and derives the Artifact tool description", () => {
    expect(svc.list({ kind: "claude-artifact" })[0].summary).toBe("Parser benchmark");
    const card = svc.register({ url: "https://example.com/result", title: "Result", summary: "A report of the parser result." });
    expect(card.summary).toBe("A report of the parser result.");
    svc.update(card.id, { summary: "The final parser result." });
    expect(svc.get(card.id)?.summary).toBe("The final parser result.");
    expect(fs.readFileSync(path.join(paths.artifacts, `${card.id}.md`), "utf8")).not.toMatch(/^(distilled\w*|candidates|reviewed_at):/m);
  });
  it("has no distillation or reviewed routes and emits no distilled events", async () => {
    const card = svc.list()[0];
    for (const suffix of ["distill", "distilled"]) expect((await d.app.request(`/api/artifacts/${card.id}/${suffix}`, { method: "POST" })).status).toBe(404);
    expect((await d.app.request("/api/artifacts/reviewed", { method: "POST" })).status).toBe(404);
    d.tailer.drain();
    expect((await d.req("GET", "/api/events?type=artifact.distilled")).body).toEqual([]);
  });
});
