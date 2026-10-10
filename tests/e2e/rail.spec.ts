import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, guardRequest, raise, seedWorld, W } from "./map-seed";

test.beforeAll(async () => { await seedWorld(); });

test("approvals tray: allow, deny, allow for this session, deny all", async ({ page }) => {
  const a = await guardRequest("Push to origin", "git push origin main");
  const b = await guardRequest("Apply staging manifests", "kubectl apply -f k8s/staging.yaml", { rule: "cloud-infra" });
  const c = await guardRequest("Publish the package", "npm publish --access public", { rule: "package-publish" });
  await page.goto("/#/map");
  const tray = page.locator('[data-rail="approvals"]');
  for (const r of [a, b, c]) await expect(tray.locator(`[data-guard="${r.id}"]`)).toBeVisible();
  await expect(tray.locator(`[data-guard="${a.id}"] .ap-cmd`)).toHaveText("git push origin main");
  await expect(tray.locator(`[data-guard="${a.id}"] .ap-clock`)).toContainText(/\d:\d\d left/);
  // Guard items are not duplicated under Needs you.
  await expect(page.locator('[data-rail="attention"] [data-attention]', { hasText: "Push to origin" })).toHaveCount(0);
  // Every waiting count follows the same actionable ask list, including approvals.
  await expect.poll(async () => {
    const n = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
    return n >= 4 && (await page.locator('[data-metric="open-l3l4"] b').textContent()) === String(n);
  }).toBe(true);
  await shot(page, "C3", "approvals-tray");

  await tray.locator(`[data-guard="${a.id}"]`).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(tray.locator(`[data-guard="${a.id}"]`)).toHaveCount(0);
  expect((await call("GET", `/api/guard/requests/${a.id}`)).body.decision).toBe("allow");

  await tray.locator(`[data-guard="${b.id}"]`).getByRole("button", { name: "Deny", exact: true }).click();
  await expect(tray.locator(`[data-guard="${b.id}"]`)).toHaveCount(0);
  expect((await call("GET", `/api/guard/requests/${b.id}`)).body.decision).toBe("deny");

  await tray.locator(`[data-guard="${c.id}"]`).getByRole("button", { name: "Allow for this session" }).click();
  await expect(tray.locator(`[data-guard="${c.id}"]`)).toHaveCount(0);
  expect((await call("GET", `/api/guard/requests/${c.id}`)).body.decision).toBe("allow");
  const rules = (await call<any[]>("GET", "/api/guard/rules")).body;
  // The guard stores sessions as keys (claude:<id>); older records used the raw id.
  expect(rules.some((r) => r.rule === "package-publish" && r.scope_type === "session" && [FAKE_SESSIONS.claudeBlocked, `claude:${FAKE_SESSIONS.claudeBlocked}`].includes(r.scope_value))).toBe(true);

  const d = await guardRequest("Copy logs to the bastion", "scp logs.tgz bastion:/tmp", { rule: "remote-copy" });
  const e = await guardRequest("Delete the build cache bucket", "gsutil rm -r gs://build-cache", { rule: "cloud-delete" });
  await expect(tray.locator(`[data-guard="${e.id}"]`)).toBeVisible();
  await tray.getByRole("button", { name: "Deny all" }).click();
  await expect(tray.locator("[data-guard]")).toHaveCount(0);
  for (const r of [d, e]) expect((await call("GET", `/api/guard/requests/${r.id}`)).body.decision).toBe("deny");
  await expect(tray).toContainText("Nothing held for your call");
});

test("a new L3 item slides into Needs you once; ack, re-level and dismiss update the item without training labels", async ({ page }) => {
  await page.goto("/#/map");
  const needs = page.locator('[data-rail="attention"]');
  await expect(needs.locator("h3")).toBeVisible();
  await page.waitForTimeout(400); // first load primes the list, so only later arrivals animate
  const item = await raise({
    level: "L3", kind: "question", title: "Which date format for the CSV?", worker: W.working, session: `claude:${FAKE_SESSIONS.claudeWorking}`,
    why: "Should dates in the export be ISO 8601, or the locale format the report page already uses?",
  });
  const li = needs.locator(`[data-attention="${item.id}"]`);
  await expect(li).toBeVisible();
  await expect(li).toHaveClass(/arrive/);
  await expect(li.locator(".att-why")).toContainText("ISO 8601");
  await expect(li.getByRole("link", { name: "CSV export with totals" })).toBeVisible();
  await page.waitForTimeout(600);
  await expect(li).not.toHaveClass(/arrive/); // one motion moment, then still
  await shot(page, "C2", "rail-attention");

  const countBefore = Number(await page.locator('[data-metric="open-l3l4"] b').textContent());
  let releaseAck: () => void = () => {};
  const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
  await page.route(`**/api/attention/${item.id}/label`, async (route) => { await ackGate; await route.continue(); });
  await li.getByRole("button", { name: "Got it" }).click();
  await expect(li).toHaveCount(0);
  if (countBefore > 1) await expect(page.locator('[data-metric="open-l3l4"] b')).toHaveText(String(countBefore - 1));
  else await expect(page.locator('[data-metric="open-l3l4"]')).toHaveCount(0);
  const savedAck = page.waitForResponse((r) => r.url().endsWith(`/api/attention/${item.id}/label`) && r.request().method() === "POST");
  await expect(page.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(countBefore - 1));
  releaseAck();
  await savedAck;
  await page.unroute(`**/api/attention/${item.id}/label`);
  const seen = needs.locator('[data-rail="seen"]');
  await seen.locator("summary").click();
  const seenItem = seen.locator(`[data-seen="${item.id}"]`);
  await expect(seenItem).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1200 });
  await shot(page, "C2", "rail-ack-cleared-seen");
  await seenItem.getByRole("button", { name: "Undo" }).click();
  await expect(li).toBeVisible();
  await shot(page, "C2", "rail-ack-undone");
  await li.getByLabel(/Change the level/).selectOption("L2");
  const inReview = page.locator(`[data-rail="review"] [data-attention="${item.id}"]`);
  await expect(inReview).toBeVisible();
  await inReview.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(`[data-attention="${item.id}"]`)).toHaveCount(0);
  expect((await call("GET", "/api/attention/labels")).status).toBe(404);
  expect((await call("GET", "/api/events?type=attention.label")).body).toEqual([]);
});

test("snooze hides an item; the digest starts collapsed", async ({ page }) => {
  const crash = await raise({ level: "L3", kind: "error", title: "Export worker crashed", why: "TypeError: Cannot read properties of undefined (reading 'totals')", worker: W.working, session: `claude:${FAKE_SESSIONS.claudeWorking}`, dedupe: "e2e-crash" });
  const note = await raise({ level: "L1", kind: "progress", title: "Sync job: retry tests added", why: "Two retry tests now cover partial batch failures.", session: `codex:${FAKE_SESSIONS.codexIdle}`, dedupe: "e2e-progress" });
  await page.goto("/#/map");
  const li = page.locator(`[data-rail="attention"] [data-attention="${crash.id}"]`);
  await li.getByRole("button", { name: "Snooze 1h" }).click();
  await expect(li).toHaveCount(0);
  expect((await call("GET", `/api/attention/${crash.id}`)).body.snoozed_until).toBeTruthy();

  const digest = page.locator('[data-rail="digest"] details');
  await expect(digest).not.toHaveAttribute("open", "");
  await expect(digest.locator(`[data-attention="${note.id}"]`)).toBeHidden();
  await digest.locator("summary").click();
  await expect(digest.locator(`[data-attention="${note.id}"]`)).toBeVisible();
});
