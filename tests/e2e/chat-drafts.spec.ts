// Baseline on :4409 lost text in all five cases, including a fully closed sheet.
// Recorded as draft reproduction, evd_62595824e8cc.
import { test, expect, type Page } from "@playwright/test";
import { call, PORT, seedWorld, W, waitUntil } from "./map-seed";
import fs from "node:fs";
import path from "node:path";
import { buildFirstmateHome, FIXTURE_TASKS } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { solidPng } from "../fixtures/images";
import { shot } from "./shot";
import { applyNew, newInput, openNew } from "./new-box";

const url = `/#/worker/${encodeURIComponent(W.codex)}`;
const reply = (page: Page) => page.getByRole("dialog", { name: /Worker/ }).getByLabel(/^Reply to /);
test.beforeAll(async () => {
  await seedWorld();
  const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
  const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
  buildFirstmateHome(home, "csv-export");
  addAskFixtures(home);
  await waitUntil(async () => (await call("GET", `/api/asks/${encodeURIComponent(`hold:${ASK_TASKS.calls}`)}`)).status === 200);
});

test("unsent session draft survives map, session switch, sheet close, reload and tab replacement", async ({ page, context }) => {
  await page.goto(url);
  for (const scenario of ["map", "session", "sheet", "reload", "tab"]) {
    const text = `Unsent draft for ${scenario}`;
    await reply(page).fill(text);
    if (scenario === "map") { await page.goto("/#/map"); await page.goto(url); }
    if (scenario === "session") {
      await page.goto(`/#/worker/${encodeURIComponent(W.working)}`);
      await expect(page.locator("[data-worker-pane]")).toHaveAttribute("data-worker-pane", W.working);
      await expect(reply(page)).toHaveValue("");
      await reply(page).fill("A separate session draft");
      await page.goto(url);
    }
    if (scenario === "sheet") {
      await page.getByRole("dialog", { name: /Worker/ }).getByRole("button", { name: "Close and return", exact: true }).click();
      await expect(page.getByRole("dialog", { name: /Worker/ })).toBeHidden();
      await page.goto(url);
    }
    if (scenario === "reload") await page.reload();
    if (scenario === "tab") { await page.close(); page = await context.newPage(); await page.goto(url); }
    await expect(reply(page)).toHaveValue(text);
    await reply(page).focus();
    expect(await reply(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(text.length);
  }
  await shot(page, "C12", "chat-draft-restored");
  await page.getByRole("dialog", { name: /Worker/ }).getByRole("button", { name: "Send", exact: true }).click();
  await expect(reply(page)).toHaveValue("");
  await page.reload();
  await expect(reply(page)).toHaveValue("");
  await page.goto(`/#/worker/${encodeURIComponent(W.working)}`);
  await expect(reply(page)).toHaveValue("A separate session draft");
});


test("uploaded images restore once and a failed request preserves the draft", async ({ page }) => {
  let uploads = 0;
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/uploads")) uploads++; });
  await page.goto(url);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await reply(page).fill("Please check this screenshot");
  await sheet.locator("[data-attach-input]").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: solidPng() });
  await expect(sheet.locator('[data-attachment="ready"]')).toHaveCount(1);
  await page.reload();
  await expect(reply(page)).toHaveValue("Please check this screenshot");
  await expect(sheet.locator('[data-attachment="ready"]')).toHaveCount(1);
  expect(uploads).toBe(1);
  await expect(sheet.getByRole("img", { name: "draft.png", exact: true })).toBeVisible();
  await shot(page, "C12", "draft-image-restored");
  await page.route("**/api/intents", (route) => route.abort());
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  await expect(sheet.getByRole("alert")).toContainText("The reply was not sent");
  await page.reload();
  await expect(reply(page)).toHaveValue("Please check this screenshot");
  await expect(sheet.locator('[data-attachment="ready"]')).toHaveCount(1);
  await page.unroute("**/api/intents");
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  await expect(reply(page)).toHaveValue("");
  await expect(sheet.locator("[data-attachment]")).toHaveCount(0);
  await page.reload();
  await expect(reply(page)).toHaveValue("");
  await expect(sheet.locator("[data-attachment]")).toHaveCount(0);
});

test("New drafts are separate per idea and clear after applying", async ({ page }) => {
  await page.goto("/#/map");
  await openNew(page);
  const box = newInput(page);
  await box.fill("A general task draft");
  await openNew(page, "csv-export");
  await expect(box).toHaveValue("");
  await box.fill("Task: An export task draft");
  await page.reload();
  await openNew(page, "csv-export");
  await expect(box).toHaveValue("Task: An export task draft");
  // Send the restored draft itself; this scenario verifies persistence and clearing after acceptance.
  await applyNew(page);
  const ghost = page.getByRole("group", { name: "New task request" }).filter({ hasText: "Task: An export task draft" });
  await expect(ghost).toContainText(/Sent/, { timeout: 25000 });
  await openNew(page, "csv-export");
  await expect(box).toHaveValue("");
  await openNew(page);
  await expect(box).toHaveValue("A general task draft");
  await box.fill("");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("joyride:draft:v1:" + JSON.stringify(["composer", "new"])))).toBeNull();
  await page.reload();
  await openNew(page);
  await expect(box).toHaveValue("");
});

test("ask words restore in the task sheet and clear after the answer sends", async ({ page }) => {
  await page.goto(`/#/task/${FIXTURE_TASKS.scout}`);
  const card = page.getByRole("dialog", { name: /Task/ }).locator(`[data-ask="hold:${ASK_TASKS.calls}"]`);
  const box = card.getByRole("textbox");
  await box.fill("Keep the totals at the bottom");
  await page.goto("/#/map");
  await page.goto(`/#/task/${FIXTURE_TASKS.scout}`);
  await expect(box).toHaveValue("Keep the totals at the bottom");
  await page.reload();
  await expect(box).toHaveValue("Keep the totals at the bottom");
  await shot(page, "C12", "ask-draft-restored");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/intents") && r.request().method() === "POST");
  await card.getByRole("button", { name: "Send answer", exact: true }).click();
  expect((await (await sent).json()).status).not.toBe("failed");
  await expect.poll(() => page.evaluate((id) => localStorage.getItem("joyride:draft:v1:" + JSON.stringify(["ask", id])), `hold:${ASK_TASKS.calls}`)).toBeNull();
});


test("an upload finishing after session switching restores to its original draft", async ({ page }) => {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/uploads", async (route) => { await ready; await route.continue(); });
  await page.goto(url);
  await reply(page).fill("An image still uploading");
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await sheet.locator("[data-attach-input]").setInputFiles({ name: "pending.png", mimeType: "image/png", buffer: solidPng() });
  await expect(sheet.locator('[data-attachment="uploading"]')).toHaveCount(1);
  await page.goto(`/#/worker/${encodeURIComponent(W.working)}`);
  await expect(page.locator("[data-worker-pane]")).toHaveAttribute("data-worker-pane", W.working);
  await page.goto(url);
  await expect(page.locator("[data-worker-pane]")).toHaveAttribute("data-worker-pane", W.codex);
  await expect(reply(page)).toHaveValue("An image still uploading");
  release();
  await expect(sheet.locator('[data-attachment="ready"]')).toHaveCount(1);
  await page.reload();
  await expect(reply(page)).toHaveValue("An image still uploading");
  await expect(sheet.locator('[data-attachment="ready"]')).toHaveCount(1);
});
