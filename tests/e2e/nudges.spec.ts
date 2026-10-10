// CP6 nudges on the real surface, starting from the home page: the rail's nudge tray asks how a done
// Firstmate task landed and a 👎 with words saves a feedback note; housekeeping's
// commit pops a "Tidied" toast whose Undo restores the files; idea_brief writes the idea's headline.
// Runs against the sandbox daemon with a fixture FM_HOME and fake models.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, PORT, waitUntil } from "./map-seed";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const CP = "CP6";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const fm = path.join(env.JOYRIDE_RUNTIME, "firstmate");
  buildFirstmateHome(fm, "csv-export");
  // The done task finished three hours ago, past the 2 h "how did it land?" threshold.
  const old = new Date(Date.now() - 3 * 36e5);
  for (const f of fs.readdirSync(path.join(fm, "state"))) if (f.startsWith(`${T.done}.`)) fs.utimesSync(path.join(fm, "state", f), old, old);
  const brief = path.join(fm, "data", T.done, "brief.md");
  if (fs.existsSync(brief)) fs.utimesSync(brief, old, old);
  if ((await call("GET", "/api/missions/csv-export")).status !== 200) {
    expect((await call("POST", "/api/missions", { id: "csv-export", title: "CSV export with totals", goal: "Users export the report as CSV with a totals row." })).status).toBe(201);
  }
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
});

test("the nudge tray asks how a done task landed; a 👎 with words becomes a feedback note while generation is frozen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  const tray = page.locator('[data-rail="nudges"]');
  await expect(tray).toBeVisible();
  const card = tray.locator(`[data-nudge="task_done:${T.done}"]`);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card).toContainText("Done: how did it land?");
  await expect(card).toContainText("Make the sync job idempotent");
  await shot(page, CP, "nudge-tray");
  await tray.screenshot({ path: path.resolve("docs/checkpoints", CP, "nudge-tray-close.png") });

  await card.getByRole("button", { name: /Didn't land/ }).click();
  await card.getByPlaceholder(/What didn't land/).fill("Retries still double-write rows");
  await shot(page, CP, "nudge-feedback-words");
  await card.getByRole("button", { name: "Send 👎" }).click();
  await expect(tray.locator(".nd-flash")).toContainText(/Saved/);
  await expect(card).toHaveCount(0);

  const notes = (await call("GET", `/api/notes?task=${T.done}`)).body as any[];
  const fb = notes.find((n) => n.tags?.includes("feedback"));
  expect(fb).toBeTruthy();
  expect(fb.bullets).toEqual(["Feedback: didn't land well", "Retries still double-write rows"]);
  expect((await call("GET", "/api/memory")).status).toBe(404);
  await shot(page, CP, "nudge-feedback-saved");
});

test("housekeeping's commit pops a Tidied toast, and Undo restores the files", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/#/`);
  await expect(page.locator('[data-rail="nudges"]')).toBeVisible();
  await page.waitForTimeout(800); // the tray's first load marks what was already there as not news
  const run = (await call("POST", "/api/ideas/place", {})).body;
  expect(run.commit, JSON.stringify(run)).toBeTruthy();

  const toast = page.locator(`[data-toast="tidied:${run.id}"]`);
  await expect(toast).toBeVisible({ timeout: 10000 });
  await expect(toast).toContainText("Tidied:");
  await shot(page, CP, "tidied-toast");
  await expect(page.locator(`[data-nudge="tidied:${run.id}"]`)).toHaveCount(0);
  const ns = (await call("GET", "/api/nudges")).body;
  expect([...ns.nudges, ...ns.overflow].some((n: { rule: string }) => n.rule === "tidied")).toBe(false);

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toContainText("Undone");
  const log = (await call("GET", "/api/ideas/log")).body as any[];
  expect(log.find((r) => r.id === run.id)?.undone).toBeTruthy();
  await expect(page.locator(`[data-nudge="tidied:${run.id}"]`)).toHaveCount(0);
  await shot(page, CP, "tidied-undone");
});

test("idea_brief writes the idea's headline, now and next from its tasks", async () => {
  await waitUntil(async () => (await call("GET", "/api/nudges/briefs/csv-export")).body.status === "ok");
  const b = (await call("GET", "/api/nudges/briefs/csv-export")).body;
  expect(b.headline).toMatch(/in flight/);
  expect(b.next).toBe("Document the CSV export");
  expect((await call("GET", "/api/nudges")).body.counts).toBeTruthy();
});
