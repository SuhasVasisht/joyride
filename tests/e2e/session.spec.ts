import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, seedWorld } from "./map-seed";

test.beforeAll(async () => { await seedWorld(); });

test("session pane: the conversation in the chat view, tool calls folded into chips", async ({ page }) => {
  await page.goto("/#/map");
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill("Add CSV export to report page");
  await palette.getByRole("option", { name: /Add CSV export to report page/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`#/session/claude%3A${FAKE_SESSIONS.claudeWorking}`));
  const sheet = page.getByRole("dialog", { name: /Session/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("Add CSV export to report page");
  await expect(sheet.locator(".msg.r-user").first()).toContainText("Add a CSV export button");
  await expect(sheet.locator(".msg.r-assistant").first()).toContainText("Export CSV button");
  const chips = sheet.locator(".msg.r-assistant").first().locator(".tool-chip");
  await expect(chips).toHaveCount(2);
  const bash = chips.first();
  await expect(bash.locator(".tc-name")).toHaveText("Bash");
  await expect(bash.locator(".tc-full")).toHaveCount(0);
  await bash.locator(".tc").click();
  await expect(bash.locator(".tc-full")).toHaveText("npm test");
  // Read only here: nothing to type into, and the newest message is in view.
  await expect(sheet.getByRole("textbox", { name: /Reply to/ })).toHaveCount(0);
  await expect(sheet.locator(".sp-mission")).toContainText("CSV export for the report page");
  await shot(page, "C2", "session-pane");
});

test("session pane links an unlinked session to a mission and unlinks it", async ({ page }) => {
  const key = "codex:019a0000-0000-7000-8000-000000000001";
  await page.goto(`/#/session/${encodeURIComponent(key)}`);
  const sheet = page.getByRole("dialog", { name: /Session/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("Export CSV encoding fix");
  await sheet.getByLabel("Link to an idea").selectOption({ label: "CSV export for the report page" });
  await sheet.getByRole("button", { name: "Link", exact: true }).click();
  await expect(sheet.locator(".sp-mission-link")).toHaveText("CSV export for the report page");
  expect((await call("GET", "/api/missions/csv-export")).body.sessions.some((s: any) => `${s.source}:${s.id}` === key)).toBe(true);
  await sheet.getByRole("button", { name: "Unlink" }).click();
  await expect(sheet.locator(".sp-mission-link")).toHaveCount(0);
  expect((await call("GET", "/api/missions/csv-export")).body.sessions.some((s: any) => `${s.source}:${s.id}` === key)).toBe(false);
});
