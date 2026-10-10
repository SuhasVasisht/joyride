import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { seedWorld, call, PORT } from "./map-seed";
import { buildFirstmateHome } from "./crew-fixture";
import { newInput, newResult, newSection, openNew, planNew, applyNew } from "./new-box";
import fs from "node:fs";
import { liveStdout } from "../fixtures/quota";
import { panTo } from "./chart-pan";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
test.beforeAll(async () => { await seedWorld(); await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: liveStdout(Date.now()) } }); buildFirstmateHome(env.FM_HOME, "csv-export"); for (const id of ["ambiguous-a", "ambiguous-b"]) await call("POST", "/api/missions", { id, title: "Ambiguous sample", goal: "Prove ambiguous names do not guess." }); });
test("New sits above Approvals on every page and N opens and focuses it", async ({ page }) => {
  await page.goto("/#/map");
  const order = await page.locator(".rail").evaluate((r) => [...r.querySelectorAll(":scope > section[data-rail]")].map((s) => (s as HTMLElement).dataset.rail));
  expect(order.indexOf("new")).toBe(order.indexOf("approvals") - 1);
  await expect(page.locator(".map-strip").getByText("New idea", { exact: true })).toHaveCount(0);
  await page.locator(".map-viewport").focus(); await page.keyboard.press("n");
  await expect(newInput(page)).toBeFocused();
  await expect(newSection(page).locator('select,input[type="radio"],.nb-preview')).toHaveCount(0);
  await shot(page, "new-box", "freeform-rail");
  await page.goto("/#/agents"); await page.getByRole("button", { name: "Rail", exact: true }).click();
  await expect(page.locator(".rail")).toBeHidden(); await page.locator("body").press("n");
  await expect(newInput(page)).toBeFocused();
});
test("ambiguous names start a contextual job without a picker or a guessed move", async ({ page }) => {
  const before = (await call("GET", "/api/missions/report-scaffold")).body.group;
  await openNew(page); await planNew(page, "Move Ambiguous sample to Reporting"); await applyNew(page);
  await expect(newResult(page)).toHaveAttribute("data-route", "agent");
  await expect(newResult(page)).toHaveAttribute("data-state", "running");
  await expect(newSection(page).getByRole("radio")).toHaveCount(0);
  expect((await call("GET", "/api/missions/report-scaffold")).body.group).toBe(before);
  await newResult(page).evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
  await expect(newResult(page)).toHaveCSS("opacity", "1");
  await shot(page, "new-box", "ambiguity-starts-agent");
});
test("draft edits stay local until Enter, and notes never reach Firstmate", async ({ page }) => {
  const before = (await call("GET", "/api/intents?kind=create_task&limit=300")).body.length;
  await openNew(page, "csv-export"); await planNew(page, "Task: implement export totals");
  await newInput(page).fill("Note: totals must match the PDF"); await applyNew(page);
  await expect(newResult(page)).toHaveAttribute("data-route", "deterministic");
  expect((await call("GET", "/api/intents?kind=create_task&limit=300")).body.length).toBe(before);
  expect((await call("GET", "/api/notes?idea=csv-export")).body.some((n: { bullets: string[] }) => n.bullets.includes("totals must match the PDF"))).toBe(true);
});

test("view feedback moves without fading its words and Undo returns to the map", async ({ page }) => {
  await openNew(page);
  const before = page.url();
  await planNew(page, "Open Agents"); await applyNew(page);
  await expect(page).toHaveURL(/#\/agents/);
  await expect(newResult(page)).toHaveAttribute("data-animation", "view");
  await expect(newResult(page)).toHaveCSS("opacity", "1");
  const animated = await newResult(page).evaluate(el => {
    const a = el.getAnimations()[0];
    return a?.effect instanceof KeyframeEffect && a.effect.getKeyframes().some(k => k.transform && k.transform !== "none");
  });
  expect(animated).toBe(true);
  await newResult(page).evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
  await expect(newResult(page)).toHaveCSS("opacity", "1");
  await shot(page, "new-box", "view-feedback-settled");
  await newResult(page).getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page).toHaveURL(before);
});

test("Markdown headings and labelled links stay readable at every map zoom", async ({ page }) => {
  await openNew(page, "report-scaffold");
  await planNew(page, "Note: ## Review result\n[Evidence](https://example.com/new-proof)"); await applyNew(page);
  await expect(newResult(page)).toHaveAttribute("data-route", "deterministic");
  const note = (await call("GET", "/api/notes?mission=report-scaffold")).body.find((n: { bullets: string[] }) => n.bullets.includes("## Review result"));
  expect(note).toBeTruthy();
  await newResult(page).getByRole("button", { name: "Show on map" }).click();
  const card = page.locator(`[data-board-item="${note.id}"]`).first();
  for (const zoom of ["Far", "Mid", "Near"]) {
    await page.getByRole("radio", { name: zoom, exact: true }).click();
    await panTo(card);
    await expect(card).toContainText("Review result");
    await expect(card).not.toContainText("##");
    await expect(card).not.toContainText("[Evidence](");
    if (zoom !== "Far") await expect(card.getByRole("link", { name: /Evidence/ })).toBeVisible();
  }
  await newResult(page).evaluate(async el => { await Promise.all(el.getAnimations().map(a => a.finished)); });
  await shot(page, "new-box", "markdown-note-settled");
  await newResult(page).getByRole("button", { name: "Undo", exact: true }).click();
});
