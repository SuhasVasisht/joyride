import { test, expect } from "@playwright/test";
import { shot } from "./shot";

test("guide: the rail card opens the how-to page with live counts", async ({ page }) => {
  await page.goto("/");
  const card = page.getByRole("region", { name: "Getting started" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Open the guide" }).click();
  await expect(page.getByRole("heading", { name: "How to use Joyride", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep your agents in Herdr" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Review \d+ suggested ideas/ })).toBeVisible();
  await shot(page, "C10", "guide", { fullPage: true });
  await page.goto("/");
  await page.getByRole("region", { name: "Getting started" }).getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("region", { name: "Getting started" })).toHaveCount(0);
});

test("start a session in Herdr from a mission and land on its worker", async ({ page, request }) => {
  const m = await (await request.post("/api/missions", { data: { title: "Tidy the export page", goal: "Make CSV export use UTF-8.", repos: ["/tmp/joyride-fixture-repos/alpha"], done_when: [{ id: "t", text: "Export tests pass", kind: "test" }] } })).json();
  await page.goto(`/#/mission/${m.id}`);
  await page.getByRole("link", { name: "Session options" }).click();
  await expect(page.getByRole("heading", { name: "Start a session", level: 1 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Folder", exact: true })).toHaveValue("/tmp/joyride-fixture-repos/alpha");
  await expect(page.getByLabel(/First message/)).toHaveValue(/Idea: Tidy the export page/);
  await shot(page, "C10", "start-session");
  await page.getByRole("button", { name: "Start in Herdr" }).click();
  await expect(page).toHaveURL(/#\/worker\//, { timeout: 15000 });
  await expect(page.getByRole("button", { name: "Open in Herdr" })).toBeVisible();
  await shot(page, "C10", "started-worker");
});
