import { test, expect } from "@playwright/test";
import { shot } from "./shot";

for (const width of [1920, 1440, 1024]) {
  test(`command trigger fits inside the top bar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/map");
    const trigger = page.getByRole("button", { name: "Open command palette" });
    await expect(trigger).toBeVisible();
    const bar = await page.locator(".topbar").boundingBox();
    const box = await trigger.boundingBox();
    if (!bar || !box) throw new Error("The top bar and command trigger must have visible boxes");
    expect(box.x).toBeGreaterThanOrEqual(bar.x);
    expect(box.x + box.width).toBeLessThanOrEqual(Math.min(bar.x + bar.width, width));
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
    expect(Math.abs(box.y + box.height / 2 - bar.y - bar.height / 2)).toBeLessThanOrEqual(1);
    await expect(trigger.locator("kbd")).toHaveText("⌘K");
    if (width === 1024) {
      await expect(trigger.locator("svg")).toBeVisible();
      await expect(trigger.locator(".palette-trigger-label")).toBeHidden();
    }
    await shot(page, "C10", `search-trigger-${width}`);
    await trigger.click();
    await expect(page.locator(".palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".palette-input")).toHaveCount(0);
  });
}
