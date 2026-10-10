// Real-data screenshot of the proposals page, read-only. Skipped unless
// JOYRIDE_REAL_URL points at a daemon (for example a private copy of the real
// data on another port). Every non-GET API request is aborted, so the page can
// never accept or reject anything there.
//   JOYRIDE_REAL_URL=http://127.0.0.1:4483 scripts/e2e.sh 4482 tests/e2e/proposals-real.spec.ts
import { test, expect } from "@playwright/test";
import { shot } from "./shot";

const REAL = process.env.JOYRIDE_REAL_URL ?? "";
if (/:3000\b/.test(REAL)) throw new Error("Port 3000 is reserved. Point JOYRIDE_REAL_URL elsewhere.");

test.skip(!REAL, "set JOYRIDE_REAL_URL to take the real-data screenshot");

test("real data: the proposals page and one proposal's context, GET only", async ({ page }) => {
  test.setTimeout(180_000);
  const blocked: string[] = [];
  await page.route("**/api/**", (route) => {
    const m = route.request().method();
    if (m === "GET" || m === "HEAD") return route.continue();
    blocked.push(`${m} ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(`${REAL}/#/proposals`);
  await expect(page.getByRole("heading", { level: 2, name: "Suggested ideas" })).toBeVisible();
  await expect(page.locator(".pp-tally")).toContainText("to decide", { timeout: 120_000 });
  const summary = await (await page.request.get(`${REAL}/api/missions/proposals/summary`)).json();
  console.log("real summary:", JSON.stringify({ items: summary.items.length, noise: summary.items.filter((i: any) => i.noise).length, recommended: summary.items.filter((i: any) => i.recommended === true).length, batch: summary.batch, stats: summary.stats }));

  // Open the first recommended proposal that made commits (else the first row).
  const ids: string[] = await page.locator("li.prop").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.proposal!));
  const pick = ids.find((id) => summary.items.find((i: any) => i.id === id && i.recommended && i.commits > 0)) ?? ids[0];
  const row = page.locator(`[data-proposal="${pick}"]`);
  await row.focus();
  await page.keyboard.press("o");
  await expect(row.locator(".pc-sessions > li").first()).toBeVisible({ timeout: 60_000 });
  await expect(row.locator(".pc-wait")).toHaveCount(0, { timeout: 90_000 });
  await page.evaluate((id) => {
    (document.activeElement as HTMLElement | null)?.blur();
    const el = document.querySelector<HTMLElement>(`[data-proposal="${id}"]`);
    el?.scrollIntoView({ block: "start" });
    let sc = el?.parentElement ?? null;
    while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
    (sc ?? document.scrollingElement)?.scrollBy(0, -72);
  }, pick);
  await shot(page, "C11", "proposals-real");
  // The shell's own interaction log may try a POST; it was aborted like any other write.
  if (blocked.length) console.log("aborted writes:", blocked);
  expect(blocked.filter((u) => /\/api\/missions/.test(u))).toEqual([]);
});
