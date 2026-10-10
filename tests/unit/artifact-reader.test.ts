import fs from "node:fs";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { ArtifactsService } from "../../src/modules/artifacts/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let svc: ArtifactsService;
let paths: typeof import("../../src/shared/paths.ts").paths;
let store: typeof import("../../src/modules/artifacts/store.ts");
beforeAll(async () => {
  d = await sandboxDaemon("artifact-reader", ["artifacts"]);
  svc = d.ctx.service<ArtifactsService>("artifacts");
  paths = (await import("../../src/shared/paths.ts")).paths;
  store = await import("../../src/modules/artifacts/store.ts");
});
afterAll(async () => { await d.modules.find(m => m.name === "artifacts")?.stop?.(); });

it("reads actual cached HTML across sources and preserves the isolation policy", async () => {
  const file = path.join(d.sb.dir, "report.html");
  const html = '<!doctype html><h1>Actual report</h1><script>window.ownReport = true</script>';
  fs.writeFileSync(file, html);
  for (const source of ["claude", "codex", "grok", "joyride"]) {
    const a = svc.register({ local_source: file, url: `https://example.org/${source}`, source });
    expect((await d.req("GET", `/api/artifacts/${a.id}/reading`)).body).toEqual({ kind: "html" });
    const response = await d.app.request(`/api/artifacts/${a.id}/preview?expanded=1`);
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
    expect(await response.text()).toContain(html.slice(15));
    const download = await d.app.request(`/api/artifacts/${a.id}/download`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toBe(html);
  }
});
it("returns complete Markdown, rather than a summary or truncated original", async () => {
  const file = path.join(d.sb.dir, "long.md");
  const text = '# Original\n\n' + 'Full report sentence.\n'.repeat(100001);
  fs.writeFileSync(file, text);
  const a = svc.register({ local_source: file, summary: "Only the saved summary" });
  expect((await d.req("GET", `/api/artifacts/${a.id}/reading`)).body).toEqual({ kind: "markdown", text });
});
it("distinguishes remote-only, missing blobs and unsupported files without reading arbitrary sources", async () => {
  const remote = svc.register({ url: "https://grok.com/share/remote-report", summary: "Saved summary only" });
  expect((await d.req("GET", `/api/artifacts/${remote.id}/reading`)).body).toEqual({ kind: "unavailable", reason: "remote" });
  const missing = { ...remote, id: "missing-report", snapshot_blob: "a".repeat(64), content_type: "text/html", local_source: "/etc/passwd" };
  store.writeArtifact(paths.artifacts, missing);
  expect((await d.req("GET", "/api/artifacts/missing-report/reading")).body).toEqual({ kind: "unavailable", reason: "missing" });
  expect((await d.app.request("/api/artifacts/missing-report/download")).status).toBe(404);
  const file = path.join(d.sb.dir, "report.bin");
  fs.writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  const unsupported = svc.register({ local_source: file });
  expect((await d.req("GET", `/api/artifacts/${unsupported.id}/reading`)).body).toEqual({ kind: "unavailable", reason: "unsupported" });
});
it("upgrades an attached Firstmate Markdown source to HTML without replacing its card or review history", async () => {
  const home = paths.firstmateHome;
  const dir = path.join(home, "data", "jr-reports-startup-guide");
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, "report.md"), html = path.join(dir, "report.html");
  fs.copyFileSync("tests/fixtures/artifact-reader/startup-guide.md", md);
  await svc.syncFirstmate();
  const original = svc.list().find(a => a.firstmate?.task === "jr-reports-startup-guide")!;
  const review = "http://127.0.0.1:4387/session/c6d2f1172133cbcc";
  const retained = { title: "My startup guide", url: review, notes: "Keep the original review history.", created: original.created };
  // Existing durable reports keep their source attached; sandbox sources normally detach.
  store.writeArtifact(paths.artifacts, { ...original, ...retained, local_source: md, source_key: null });
  fs.copyFileSync("tests/fixtures/artifact-reader/startup-guide.html", html);
  const before = fs.readFileSync(html);
  await svc.syncFirstmate();
  const upgraded = svc.get(original.id)!;
  expect(upgraded).toMatchObject(retained);
  expect(upgraded.source_key).toBe(store.localSourceKey(md));
  expect(upgraded.content_type).toMatch(/^text\/html/);
  expect((await d.req("GET", `/api/artifacts/${original.id}/reading`)).body).toEqual({ kind: "html" });
  expect(await (await d.app.request(`/api/artifacts/${original.id}/preview`)).text()).toContain("Bring up the reports workspace");
  expect(fs.readFileSync(html)).toEqual(before);
  store.writeArtifact(paths.artifacts, { ...upgraded, local_source: html });
  fs.writeFileSync(html, "");
  await svc.syncFirstmate();
  const fallback = svc.get(original.id)!;
  expect(fallback.content_type).toMatch(/^text\/markdown/);
  expect(fallback).toMatchObject(retained);
  expect(fallback.source_key).toBe(store.localSourceKey(md));
  expect(svc.list().filter(a => a.firstmate?.task === "jr-reports-startup-guide")).toHaveLength(1);
});
it("discovers HTML-only reports and retains the original local review URL", async () => {
  const dir = path.join(paths.firstmateHome, "data", "html-only");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.html"), "<!doctype html><title>HTML only</title><h1>Original</h1>");
  await svc.syncFirstmate();
  expect(svc.list().find(a => a.firstmate?.task === "html-only")?.title).toBe("HTML only");
  expect(store.normalizeUrl("http://127.0.0.1:4387/session/c6d2f1172133cbcc")).toBe("http://127.0.0.1:4387/session/c6d2f1172133cbcc");
});
