// Firstmate reports in the knowledge home: reports in a fixture FM_HOME
// register on their own, get snapshotted, and show as rows with project, date and
// status. From the home page: open Search, filter to reports, open one as a
// rendered document under its summary. Runs only against the sandbox daemon (E2E_PORT).
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { buildReportsHome, REPORT_MISSION, REPORT_TASKS as T } from "./reports-fixture";

const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("artifacts e2e refuses to run against the real daemon port");
const BASE = `http://127.0.0.1:${PORT}`;
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const HOME = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const REPORT_TITLES = /Alpha API cache backend|Beta sync client retries|Gamma service logging audit/;
if (!HOME.startsWith(`/tmp/joyride-e2e-${PORT}/`)) throw new Error(`refusing to write a Firstmate home outside the sandbox: ${HOME}`);

async function call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${p} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : (null as T);
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => { await call("PUT", `/api/missions/${REPORT_MISSION}`, { archive: true }); });

test.beforeAll(async () => {
  const ms = await call<any[]>("GET", "/api/missions");
  if (!ms.some((m) => m.id === REPORT_MISSION)) await call("POST", "/api/missions", { id: REPORT_MISSION, title: "Alpha cache", repos: ["/tmp/joyride-fixture-repos/alpha"], goal: "Pick and ship a cache for the alpha API." });
  buildReportsHome(HOME);
  // No scan call: the artifacts module notices the reports on its own and snapshots each one.
  await expect.poll(async () => (await call<any[]>("GET", "/api/artifacts")).filter((a) => Object.values(T).includes(a.firstmate?.task)).length, { timeout: 30000 }).toBe(3);
});

test("a Firstmate report, from the home page to the rendered document", async ({ page }) => {
  const rows = () => page.getByTestId("knowledge-row");
  await test.step("open Search from the home page", async () => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Search/ }).click();
    await expect(page).toHaveURL(/#\/knowledge$/);
    await expect(page.getByTestId("knowledge-page")).toBeVisible();
  });

  await test.step("the reports filter shows rows with summary, project, date and status", async () => {
    await page.getByTestId("type-filter").getByRole("button", { name: /^Reports/ }).click();
    await expect(rows().filter({ hasText: REPORT_TITLES })).toHaveCount(3);
    const card = rows().filter({ hasText: "Alpha API cache backend" });
    await expect(card).toContainText("Firstmate report");
    await expect(card).toContainText("alpha");
    await expect(card).toContainText("Alpha API cache backend: Redis or in-process LRU");
    await expect(card.getByTestId("artifact-status")).toHaveText("Decision open");
    await expect(rows().filter({ hasText: "Beta sync client retries" }).getByTestId("artifact-status")).toHaveText("Being applied");
    await expect(rows().filter({ hasText: "Gamma service logging audit" }).getByTestId("artifact-status")).toHaveText("Reported");
    await page.waitForTimeout(200);
    await shot(page, "artifacts-curate", "reports-shelf");
  });

  await test.step("filter to one project", async () => {
    await page.getByRole("combobox", { name: "Filter by project" }).selectOption("beta");
    await expect(rows().filter({ hasText: REPORT_TITLES })).toHaveCount(1);
    await expect(rows().filter({ hasText: "Beta sync client retries" })).toHaveCount(1);
    await page.getByRole("combobox", { name: "Filter by project" }).selectOption("");
    await expect(rows().filter({ hasText: REPORT_TITLES })).toHaveCount(3);
  });

  await test.step("open the rendered report first, then return to its details", async () => {
    await rows().filter({ hasText: "Alpha API cache backend" }).getByRole("button").first().click();
    await expect(page.getByTestId("artifact-reader").getByRole("heading", { name: "Findings" })).toBeVisible();
    await shot(page, "C6/artifact-reader", "firstmate-markdown");
    await page.getByRole("button", { name: "Back to details" }).click();
    const detail = page.getByTestId("artifact-detail");
    await expect(detail.getByRole("heading", { name: "Alpha API cache backend: Redis or in-process LRU", level: 2 }).first()).toBeVisible();
    await expect(detail.getByTestId("artifact-notes")).toContainText("Alpha API cache backend: Redis or in-process LRU");
    await expect(detail.getByTestId("artifact-decisions")).toContainText("Waiting on you");
    const report = detail.getByTestId("artifact-report");
    await expect(report.getByRole("heading", { name: "Findings" })).toBeVisible();
    await expect(report.locator("table.k-table")).toContainText("In-process LRU");
    // Summary sits above the document.
    const sumBox = await detail.getByTestId("artifact-notes").boundingBox();
    const repBox = await report.boundingBox();
    expect(sumBox!.y).toBeLessThan(repBox!.y);
    await expect(detail.getByLabel("Linked idea")).toHaveValue(REPORT_MISSION);
    await page.waitForTimeout(200);
    await shot(page, "artifacts-curate", "report-open");
    await report.getByRole("heading", { name: "Findings" }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await shot(page, "artifacts-curate", "report-document");
  });

  await test.step("read from the matching task and return to its report tab", async () => {
    await page.goto(`/#/task/${T.cache}?tab=report`);
    await page.getByRole("tab", { name: /^Report/ }).click();
    await page.getByRole("button", { name: "Read report", exact: true }).click();
    await expect(page.getByTestId("artifact-reader").getByRole("heading", { name: "Findings" })).toBeVisible();
    await page.getByRole("button", { name: "Back to details" }).click();
    await expect(page.getByTestId("artifact-detail")).toContainText("Alpha API cache backend: Redis or in-process LRU");
    await page.getByRole("button", { name: "Close and return" }).click();
    await expect(page.locator(`[data-task-sheet="${T.cache}"]`)).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Report/ })).toHaveAttribute("aria-selected", "true");
  });

  await test.step("an updated report updates its card, not a second one", async () => {
    const before = (await call<any[]>("GET", "/api/artifacts")).filter((a) => Object.values(T).includes(a.firstmate?.task));
    fs.writeFileSync(path.join(HOME, "data", T.logs, "report.md"), "# Gamma service logging audit, revised\n\nThe gamma service now logs body sizes only, after the 2.4 fix.\n");
    await expect.poll(async () => (await call<any[]>("GET", "/api/artifacts")).find((a) => a.firstmate?.task === T.logs)?.title, { timeout: 20000 }).toBe("Gamma service logging audit, revised");
    const after = (await call<any[]>("GET", "/api/artifacts")).filter((a) => Object.values(T).includes(a.firstmate?.task));
    expect(after.map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
    await page.goto("/#/artifacts?shelf=reports");
    await expect(page).toHaveURL(/#\/knowledge\?types=reports$/);
    await expect(rows().filter({ hasText: "Gamma service logging audit, revised" })).toHaveCount(1);
    await expect(rows().filter({ hasText: REPORT_TITLES })).toHaveCount(3);
  });
});
