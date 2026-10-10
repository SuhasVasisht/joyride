// New, the one box at the top of the rail: helpers for the specs that type into it.
import { expect, type Locator, type Page } from "@playwright/test";

export const newSection = (page: Page) => page.locator('[data-rail="new"]');
export const newInput = (page: Page) => newSection(page).getByRole("textbox", { name: "New", exact: true });
export const newResult = (page: Page) => newSection(page).locator("[data-new-result]");

/** Open New the way a link or "+ Add to this idea" does, on an idea or the whole map. */
export async function openNew(page: Page, idea?: string) {
  await page.goto(idea ? `/#/compose?idea=${encodeURIComponent(idea)}` : "/#/compose");
  await expect(newInput(page)).toBeFocused();
  if (idea) await expect(newSection(page).locator(".nb-scope")).toBeVisible();
}

/** Fill freeform words; routing starts only on Send. */
export async function planNew(page: Page, text: string): Promise<Locator> {
  await newInput(page).fill(text);
  await expect(newSection(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  return newSection(page);
}

export async function applyNew(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await newInput(page).press("Enter");
  const result = await (await response).json();
  expect(result.state, result.message).not.toBe("failed");
  await expect(newResult(page)).toBeVisible();
}

/** A direct Firstmate submission tracks receipts after it has already been sent. */
export async function composeTask(page: Page, text: string): Promise<Locator> {
  await planNew(page, text);
  await applyNew(page);
  const ghost = page.getByRole("group", { name: "New task request" }).filter({ hasText: text });
  await expect(ghost).toBeVisible();
  return ghost;
}
