import { test, expect } from "@playwright/test";
import { shot } from "./shot";

test("shell renders with live connection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Joyride home" })).toBeVisible();
  await expect(page.locator(".conn.on")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shot(page, "C0", "shell-palette");
});
