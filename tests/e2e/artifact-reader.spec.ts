import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import type { TranscriptState } from "../../src/modules/sessions/types.ts";
import type { ArtifactView } from "../../src/modules/artifacts/index.ts";

const port = Number(process.env.E2E_PORT ?? 4399);
if ([3000, 4317, 4318].includes(port)) throw new Error("Reader tests require an isolated daemon");
const base = `http://127.0.0.1:${port}`;
const root = `/tmp/joyride-e2e-${port}`;
const files = path.join(root, "reader-files");
const env = z.object({ FM_HOME: z.string(), JOYRIDE_RUNTIME: z.string() }).parse(JSON.parse(fs.readFileSync(path.join(root, "env.json"), "utf8")));
if (!env.FM_HOME.startsWith(root + "/") || !env.JOYRIDE_RUNTIME.startsWith(root + "/")) throw new Error("Reader fixtures must stay in their sandbox");
let dossier: ArtifactView, markdown: ArtifactView, grok: ArtifactView, joyride: ArtifactView, remote: ArtifactView, missing: ArtifactView;
// The local proof report when present (docs/reports is gitignored), else a small committed stand-in.
const FREEFORM_REPORT = ["docs/reports/new-freeform.html", "tests/fixtures/artifact-reader/freeform-report.html"].map((f) => path.resolve(f)).find((f) => fs.existsSync(f))!;
let claudeSession: string, codexSession: string, workerId: string;
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
const reader = (page: Page) => page.getByTestId("artifact-reader");
async function backAndClose(page: Page, artifact: ArtifactView) {
  await reader(page).getByRole("button", { name: "Back to details" }).click();
  await expect(page.getByTestId("artifact-detail").getByRole("heading", { name: artifact.title, exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close and return" }).click();
  await expect(reader(page)).toHaveCount(0);
}

test.beforeAll(async () => {
  fs.mkdirSync(files, { recursive: true });
  const sessions = await call<{ key: string; source: string }[]>("GET", "/api/sessions");
  claudeSession = sessions.find(s => s.source === "claude")!.key;
  const workers = await call<{ id: string; session: string | null; agent: string }[]>("GET", "/api/workers");
  const worker = workers.find(w => w.agent === "codex" && w.session)!;
  workerId = worker.id;
  codexSession = worker.session ?? sessions.find(s => s.source === "codex")!.key;
  if (!(await call<{id: string}[]>("GET", "/api/missions")).some(m => m.id === "reader-examples")) await call("POST", "/api/missions", { id: "reader-examples", title: "Reader examples", goal: "Read the actual report before metadata" });
  const dir = path.join(env.FM_HOME, "data", "jr-reports-startup-guide");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync("tests/fixtures/artifact-reader/startup-guide.md", path.join(dir, "report.md"));
  fs.copyFileSync("tests/fixtures/artifact-reader/startup-guide.html", path.join(dir, "report.html"));
  fs.writeFileSync(path.join(dir, "brief.md"), "joyride-mission: reader-examples\n");
  await call("POST", "/api/artifacts/firstmate/scan");
  dossier = (await call<ArtifactView[]>("GET", "/api/artifacts")).find(a => a.firstmate?.task === "jr-reports-startup-guide")!;
  // A Firstmate task report, linked to a review board in the fixture only.
  dossier = await call("POST", "/api/artifacts", { url: "http://127.0.0.1:4387/session/c6d2f1172133cbcc", local_source: path.join(dir, "report.html"), title: "Bring up the reports workspace", source: "claude", session: claudeSession, mission: "reader-examples" });
  const mdFile = path.join(files, "codex.md");
  fs.writeFileSync(mdFile, '# Codex Markdown fixture\n\n## Findings\n\n| Option | Result |\n| --- | --- |\n| Rendered | Readable |\n\n[Unsafe link](javascript:alert%281%29)\n\n```sh\n' + 'echo "A long command remains selectable and wraps at narrow widths"\n'.repeat(160) + '```\n\n## End of Markdown\n\nComplete original.\n');
  markdown = await call("POST", "/api/artifacts", { local_source: mdFile, title: "Codex Markdown fixture", source: "codex", session: codexSession, mission: "reader-examples" });
  const htmlFile = path.join(files, "grok.html");
  fs.writeFileSync(htmlFile, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grok cached HTML fixture</title><style>body{margin:0;font:18px/1.6 system-ui;background:#f4f8fa}main{max-width:1100px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>Grok cached HTML fixture</h1><p id="isolation">Checking isolation</p><pre>' + 'printf "Long report command remains readable"\n'.repeat(180) + '</pre><h2>End of HTML</h2><button id="last">Last report control</button></main><script>try{parent.document.body.dataset.artifactAttack="yes"}catch(e){document.querySelector("#isolation").textContent="Parent access blocked"}try{localStorage.setItem("artifactAttack","yes")}catch(e){document.body.dataset.storage="blocked"}</script>');
  grok = await call("POST", "/api/artifacts", { local_source: htmlFile, url: "https://grok.com/share/reader-fixture", title: "Grok cached HTML fixture", source: "grok" });
  joyride = await call("POST", "/api/artifacts", { local_source: FREEFORM_REPORT, title: "Freeform New real report", source: "joyride" });
  remote = await call("POST", "/api/artifacts", { url: "https://claude.ai/artifact/expired-reader-example", title: "Remote-only report fixture", summary: "Saved summary of a remote original", source: "claude" });
  const missingFile = path.join(files, "missing.html"); fs.writeFileSync(missingFile, "<h1>Missing source fixture</h1>");
  missing = await call("POST", "/api/artifacts", { local_source: missingFile, title: "Missing snapshot fixture" });
  fs.unlinkSync(path.join(env.JOYRIDE_RUNTIME, "blobs", missing.snapshot_blob!));
});

test("home, artifact list and Firstmate report reader: wide, narrow, details and Lavish", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Artifacts", exact: true }).click();
  const row = page.locator(`[data-testid="artifact-row"][data-id="${dossier.id}"]`).getByRole("button");
  await row.click();
  await expect(reader(page)).toBeVisible();
  const frame = page.frameLocator('[data-testid="artifact-reader-frame"]');
  await expect(frame.getByRole("heading", { name: "Bring up the reports workspace" })).toBeVisible();
  const box = await reader(page).boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
  await expect(frame.getByLabel("Terminal B · Frontend review host commands")).toBeVisible();
  expect(await frame.getByLabel("Terminal B · Frontend review host commands").evaluate((el) => el.scrollHeight <= el.clientHeight + 2)).toBe(true);
  await shot(page, "C6/artifact-reader", "dossier-wide");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => frame.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await frame.getByRole("heading", { name: "What was verified" }).scrollIntoViewIfNeeded();
  await shot(page, "C6/artifact-reader", "dossier-narrow-end");
  await reader(page).getByRole("button", { name: "Back to details" }).click();
  await expect(page.getByTestId("artifact-detail").getByRole("link", { name: "Review in Lavish" })).toHaveAttribute("href", "http://127.0.0.1:4387/session/c6d2f1172133cbcc");
  await expect(page.getByTestId("artifact-detail")).toContainText("chat collects annotations and change requests");
  await shot(page, "C6/artifact-reader", "matching-details");
  await page.getByRole("button", { name: "Read report" }).click();
  await expect(reader(page)).toBeVisible();
  await reader(page).getByRole("button", { name: "Close and return" }).click();
  await expect(row).toBeFocused();
  await expect(page).toHaveURL(/#\/knowledge\/artifacts$/);
});

test("canvas click preserves the canvas and keyboard focus", async ({ page }) => {
  await page.goto("/#/map");
  await page.locator('[data-mission="reader-examples"] .mn-title').focus();
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  const link = page.locator(`.art-chip[data-artifact="${markdown.id}"]`).first();
  await expect(link).toBeVisible();
  await link.focus();
  const before = await page.locator(".map-layer").getAttribute("style");
  await page.keyboard.press("Enter");
  await expect(reader(page).getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(reader(page).getByRole("link", { name: "Unsafe link" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("artifact-detail")).toContainText(markdown.title);
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  expect(await page.locator(".map-layer").getAttribute("style")).toBe(before);
  await expect(page).toHaveURL(/#\/map$/);
});

test("session output opens the shared Markdown reader and returns to the same conversation", async ({ page }) => {
  await page.goto(`/#/session/${encodeURIComponent(codexSession)}`);
  const session = page.locator(`[data-session-pane="${codexSession}"]`);
  const link = page.getByRole("navigation", { name: "Session artifacts" }).getByRole("link", { name: markdown.title });
  await link.click();
  await expect(reader(page)).toContainText("Codex Markdown fixture");
  await page.setViewportSize({ width: 390, height: 844 });
  await reader(page).getByRole("heading", { name: "End of Markdown" }).scrollIntoViewIfNeeded();
  expect(await reader(page).locator("pre").evaluate(el => el.scrollHeight <= el.clientHeight + 2 && el.scrollWidth <= el.clientWidth + 2)).toBe(true);
  await shot(page, "C6/artifact-reader", "markdown-narrow-end");
  await backAndClose(page, markdown);
  await expect(session).toBeVisible();
  await expect(link).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#/session/${encodeURIComponent(codexSession)}$`));
});

test("cached Grok fixture is isolated, tall and keyboard accessible", async ({ page, request }) => {
  await page.goto(`/#/artifacts/${grok.id}`);
  const frame = page.frameLocator('[data-testid="artifact-reader-frame"]');
  await expect(frame.getByText("Parent access blocked")).toBeVisible();
  expect(await page.locator("body").getAttribute("data-artifact-attack")).toBeNull();
  await expect(frame.locator("body")).toHaveAttribute("data-storage", "blocked");
  await expect(page.getByTestId("artifact-reader-frame")).not.toHaveAttribute("sandbox", /allow-same-origin/);
  const response = await request.get(`/api/artifacts/${grok.id}/preview?expanded=1`);
  expect(response.headers()["content-security-policy"]).toBe("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
  await frame.getByRole("heading", { name: "End of HTML" }).scrollIntoViewIfNeeded();
  await shot(page, "C6/artifact-reader", "isolated-tall-html");
  await frame.getByRole("button", { name: "Last report control" }).focus();
  await page.keyboard.press("Tab");
  await expect(reader(page).getByRole("button", { name: "Back to details" })).toBeFocused();
  await reader(page).getByRole("button", { name: "Close and return" }).focus();
  await page.keyboard.press("Tab");
  await expect(frame.getByRole("button", { name: "Last report control" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("artifact-detail")).toContainText(grok.title);
});

test("real Joyride HTML and truthful remote-only or missing content states", async ({ page }) => {
  await page.goto(`/#/artifacts/${joyride.id}`);
  await expect(reader(page)).toBeVisible();
  await expect(page.frameLocator('[data-testid="artifact-reader-frame"]').getByRole("heading", { name: /Type what you want/ }).first()).toBeVisible();
  await shot(page, "C6/artifact-reader", "real-freeform-report");
  await page.goto("/#/knowledge/artifacts");
  for (const a of [remote, missing]) {
    await page.getByTestId("artifact-row").filter({ hasText: a.title }).getByRole("button").click();
    await expect(page.getByTestId("artifact-reading-state")).toBeVisible();
    await expect(reader(page).locator("iframe")).toHaveCount(0);
    if (a === remote) {
      await expect(reader(page)).toContainText("Saved summary");
      await expect(reader(page)).toContainText("no saved copy of the original report");
      await expect(reader(page).getByRole("link", { name: "Open original" })).toHaveAttribute("href", remote.url!);
    } else await expect(reader(page)).toContainText("saved report is missing");
    await shot(page, "C6/artifact-reader", a === remote ? "remote-only-fallback" : "missing-snapshot-fallback");
    await backAndClose(page, a);
  }
});


test("browser Back opens matching details; registered provider links in a transcript read directly", async ({ page }) => {
  await page.route(`**/api/sessions/${encodeURIComponent(claudeSession)}/transcript?*`, async route => {
    const response = await route.fetch();
    const data: TranscriptState = await response.json();
    data.turns.push({ role: "assistant", ts: null, tools: [], text: `[Cached report fixture](${grok.url})` });
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/#/session/${encodeURIComponent(claudeSession)}`);
  const link = page.locator(".chat").getByRole("link", { name: "Cached report fixture" });
  await link.click();
  await expect(reader(page)).toContainText(grok.title);
  await expect(page.frameLocator('[data-testid="artifact-reader-frame"]').getByText("Parent access blocked")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("artifact-detail")).toContainText(grok.title);
  await expect(reader(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Read report" }).click();
  await expect(reader(page)).toBeVisible();
  await reader(page).getByRole("button", { name: "Close and return" }).click();
  await expect(link).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#/session/${encodeURIComponent(claudeSession)}$`));
});


test("agent output reading preserves the unsent reply and conversation position", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(workerId)}`);
  const draft = page.getByRole("textbox", { name: /^Reply to/ });
  await draft.fill("Unsent reading check");
  const link = page.getByRole("navigation", { name: "Session artifacts" }).getByRole("link", { name: markdown.title });
  const scroll = await page.locator(".chat-log").evaluate(el => el.scrollTop);
  await link.click();
  await expect(reader(page)).toContainText(markdown.title);
  await backAndClose(page, markdown);
  await expect(draft).toHaveValue("Unsent reading check");
  expect(await page.locator(".chat-log").evaluate(el => el.scrollTop)).toBe(scroll);
  await expect(link).toBeFocused();
  await shot(page, "C6/artifact-reader", "agent-return-with-draft");
});
