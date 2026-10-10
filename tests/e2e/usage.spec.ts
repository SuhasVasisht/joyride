import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { shot } from "./shot";
import { allLiveStdout, codexProfileMissingStdout, codexProfileStdout, keychainStdout, liveStdout } from "../fixtures/quota";

// Usage limits through the daemon's test source (JOYRIDE_TEST): quota-axi never runs; each test sets
// what the source returns, which also clears the daemon's minute cache.
async function fake(request: APIRequestContext, result: unknown, more: { profiles?: Record<string, unknown>; accounts?: unknown[] } = {}) {
  const r = await request.post("/api/usage/test-fake", { data: { result, ...more } });
  expect(r.ok()).toBeTruthy();
}
const card = (page: Page, scope: string, provider: string) => page.locator(`${scope} [data-provider="${provider}"]`);
const account = (page: Page, scope: string, id: string) => page.locator(`${scope} [data-account="${id}"]`);
/** The captain's four accounts: Claude, Codex on ~/.codex, a second Codex folder, Cursor. */
const SECOND = `/tmp/joyride-e2e-${process.env.E2E_PORT ?? 4399}/codex-2`;
const FOUR = [{ provider: "claude" }, { provider: "codex", home: "~/.codex" }, { provider: "codex", label: "Codex 2", home: SECOND }, { provider: "cursor" }];
// Later specs see the sandbox's own accounts again.
test.afterAll(async ({ request }) => { await fake(request, { kind: "ok", stdout: liveStdout(Date.now()) }); });

test("usage: both subscriptions live, in the rail and on the usage page", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: liveStdout(Date.now()) });
  await page.goto("/#/map");
  const rail = page.locator('[data-rail="usage"]');
  await expect(rail.getByRole("heading", { name: /Usage limits/ })).toBeVisible();
  const claude = card(page, '[data-rail="usage"]', "claude");
  await expect(claude).toHaveAttribute("data-state", "live");
  await expect(claude.locator('[data-window="five_hour"]')).toContainText("92% used");
  // The rail keeps each window to one line: the relative reset, with the local time on hover.
  await expect(claude.locator('[data-window="five_hour"] .us-rel')).toHaveText(/^in 4[67]m$/);
  await expect(claude.locator('[data-window="five_hour"] .us-rel')).toHaveAttribute("title", /^Resets (today|tomorrow) .* · in 4[67]m$/);
  await expect(claude.locator('[data-window="weekly"]')).toContainText("57% used");
  await expect(claude.locator('[data-window="weekly"]')).toContainText(/in 2d 4h|in 2d 3h/);
  const codex = card(page, '[data-rail="usage"]', "codex");
  await expect(codex.locator('[data-window="five_hour"]')).toContainText("23% used");
  await expect(rail.getByText("Limiting")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await rail.scrollIntoViewIfNeeded();
  await shot(page, "C11", "usage-rail-live");

  await rail.getByRole("button", { name: "Details" }).click();
  const pageEl = page.getByTestId("usage-page");
  await expect(pageEl.getByRole("heading", { name: "Usage limits", level: 1 })).toBeVisible();
  const full = card(page, '[data-testid="usage-page"]', "claude");
  await expect(full.locator('[data-window="five_hour"]')).toContainText(/Resets (today|tomorrow) .* · in 4[67]m/);
  await expect(full.locator('[data-window="five_hour"]')).toContainText("8% left");
  await expect(full.locator('[data-window="five_hour"]')).toContainText("Using faster than the clock");
  await expect(card(page, '[data-testid="usage-page"]', "codex")).toContainText("Self serve business prolite");
  await expect(pageEl.getByRole("button", { name: "Refresh now" })).toBeEnabled();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-page-live");
});

test("usage: Claude needs the one-time Keychain approval while Codex is live", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: keychainStdout(Date.now()) });
  await page.goto("/#/usage");
  const claude = card(page, '[data-testid="usage-page"]', "claude");
  await expect(claude).toHaveAttribute("data-state", "keychain");
  await expect(claude.locator(".chip")).toHaveText("Needs Keychain approval");
  await expect(claude).toContainText("one-time Keychain approval");
  await expect(claude.locator(".us-cmd code")).toHaveText("quota-axi --allow-keychain-prompt");
  await expect(claude.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect(claude.locator("[data-window]")).toHaveCount(0);
  await expect(card(page, '[data-testid="usage-page"]', "codex")).toHaveAttribute("data-state", "live");
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-page-keychain");
  await page.goto("/#/map");
  await expect(card(page, '[data-rail="usage"]', "claude")).toHaveAttribute("data-state", "keychain");
  await page.locator('[data-rail="usage"]').scrollIntoViewIfNeeded();
  await shot(page, "C11", "usage-rail-keychain");
});

test("usage: a missing CLI, unreadable output and a timeout each show their own state", async ({ page, request }) => {
  const cases: [unknown, string, RegExp][] = [
    [{ kind: "missing" }, "quota-axi missing", /not installed/],
    [{ kind: "ok", stdout: "Segmentation fault" }, "Unreadable output", /cannot read/],
    [{ kind: "timeout", seconds: 20 }, "Timed out", /did not answer within 20 seconds/],
  ];
  for (const [result, chip, msg] of cases) {
    await fake(request, result);
    await page.goto("/#/usage");
    for (const p of ["claude", "codex"]) {
      const c = card(page, '[data-testid="usage-page"]', p);
      await expect(c.locator(".chip")).toHaveText(chip);
      await expect(c.locator(".us-msg")).toContainText(msg);
    }
    // The daemon keeps serving everything else.
    expect((await request.get("/api/health")).ok()).toBeTruthy();
  }
  await expect(card(page, '[data-testid="usage-page"]', "codex").locator(".us-msg")).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-page-timeout");
});

test("usage: reachable from the home page through a primary top-bar tab and a rail card in view", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: liveStdout(Date.now()) });
  // A returning user: the first-run setup card is dismissed, as on a set-up dashboard.
  await page.addInitScript(() => localStorage.setItem("joyride.guide.dismissed", "1"));
  await page.goto("/");
  const needs = page.locator('[data-rail="attention"]');
  await expect(needs.getByText("Waiting on you in alpha")).toBeVisible();
  await expect(page.locator('[data-rail="approvals"]').getByRole("heading", { name: "Approvals" })).toBeInViewport();
  await expect(needs.getByRole("heading", { name: /Needs you/ })).toBeInViewport();
  await expect(page.locator('[data-rail="usage"]').getByRole("heading", { name: /Usage limits/ })).toBeInViewport();
  const tab = page.getByRole("banner").getByRole("link", { name: "Usage", exact: true });
  await expect(tab).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-home-tab");
  await tab.click();
  await expect(page).toHaveURL(/#\/usage$/);
  await expect(page.getByTestId("usage-page").getByRole("heading", { name: "Usage limits", level: 1 })).toBeVisible();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-home-tab-opened");
});

test("usage: four accounts, each with its own windows, resets and plan, and no limiting badge", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: allLiveStdout(Date.now()) }, { accounts: FOUR, profiles: { "codex-2": { kind: "ok", stdout: codexProfileStdout(Date.now(), { fiveUsed: 64, weekUsed: 12 }) } } });
  await page.goto("/#/usage");
  const pageEl = page.getByTestId("usage-page");
  await expect(pageEl.locator(".us-card")).toHaveCount(4);
  await expect(pageEl.locator(".us-card h4")).toHaveText(["Claude Code", "Codex", "Codex 2", "Cursor"]);
  for (const id of ["claude-code", "codex", "codex-2", "cursor"]) await expect(account(page, '[data-testid="usage-page"]', id)).toHaveAttribute("data-state", "live");
  const codex = account(page, '[data-testid="usage-page"]', "codex"), codex2 = account(page, '[data-testid="usage-page"]', "codex-2");
  await expect(codex.locator('[data-window="five_hour"]')).toContainText("23% used");
  await expect(codex2.locator('[data-window="five_hour"]')).toContainText("64% used");
  await expect(codex2.locator('[data-window="weekly"]')).toContainText("12% used");
  await expect(codex2).toContainText(`Login folder ${SECOND}`);
  await expect(codex2).toContainText("Self serve business prolite");
  // Cursor matches its Plan & Usage screen: two buckets, the plan, and one reset. Grok Bot stays as its own week.
  const cursor = account(page, '[data-testid="usage-page"]', "cursor");
  await expect(cursor.locator(".us-span")).toHaveText(["Cursor Models", "Other Models", "Grok Bot"]);
  await expect(cursor.locator('[data-window="cursor_models"]')).toContainText("12% used");
  await expect(cursor.locator('[data-window="cursor_models"]')).toContainText("Includes Cursor Grok and Composer");
  await expect(cursor.locator('[data-window="cursor_models"]')).toContainText("Additional usage beyond limits consumes Other Models quota or on-demand spend.");
  await expect(cursor.locator('[data-window="other_models"]')).toContainText("0% used");
  await expect(cursor.locator('[data-window="other_models"]')).toContainText("Additional usage beyond limits consumes on-demand spend.");
  await expect(cursor.locator('[data-window="grok_bot"]')).toContainText("0% used");
  await expect(cursor.locator('[data-window="included_usage"], [data-window="five_hour"], [data-window="weekly"]')).toHaveCount(0);
  await expect(cursor).toContainText("Team");
  await expect(cursor.locator(".us-cycle")).toContainText(/Usage limits reset on .+ \(\d+ days left\)/);
  await expect(account(page, '[data-testid="usage-page"]', "claude-code").locator('[data-window="model:opus"]')).toContainText("12% used");
  await expect(pageEl.getByText("Limiting")).toHaveCount(0);
  await cursor.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-page-four-accounts", { fullPage: true });

  await page.goto("/#/map");
  const rail = page.locator('[data-rail="usage"]');
  await expect(rail.locator(".us-card")).toHaveCount(4);
  await expect(rail.locator(".us-card h4")).toHaveText(["Claude Code", "Codex", "Codex 2", "Cursor"]);
  await expect(account(page, '[data-rail="usage"]', "codex-2").locator('[data-window="five_hour"]')).toContainText("64% used");
  await expect(account(page, '[data-rail="usage"]', "cursor").locator(".us-span")).toHaveText(["Cursor Models", "Other Models", "Grok Bot"]);
  await expect(account(page, '[data-rail="usage"]', "cursor").locator(".us-cycle")).toContainText("Usage limits reset on");
  await expect(rail.getByText("Limiting")).toHaveCount(0);
  await rail.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-rail-four-accounts");
});

test("usage: a configured Codex folder with no login yet says so, with the exact login command", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: allLiveStdout(Date.now()) }, { accounts: [...FOUR.slice(0, 2), { provider: "codex", label: "Codex 2", home: "~/.codex-2" }, FOUR[3]], profiles: { "codex-2": { kind: "ok", stdout: codexProfileMissingStdout(Date.now()) } } });
  await page.goto("/#/usage");
  const c = account(page, '[data-testid="usage-page"]', "codex-2");
  await expect(c).toHaveAttribute("data-state", "not_signed_in");
  await expect(c.locator(".chip")).toHaveText("Not signed in");
  await expect(c.locator(".us-msg")).toHaveText("No Codex login in ~/.codex-2 yet. Sign in with the command below, then refresh.");
  await expect(c.locator(".us-cmd code")).toHaveText("mkdir -p ~/.codex-2 && CODEX_HOME=~/.codex-2 codex login");
  await expect(c.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect(account(page, '[data-testid="usage-page"]', "codex")).toHaveAttribute("data-state", "live");
  await page.mouse.move(0, 0);
  await shot(page, "C11", "usage-page-not-signed-in", { fullPage: true });
});

test("usage: recovers a refresh completed before the stream opens while the cold response is pending", async ({ page, request }) => {
  await fake(request, { kind: "ok", stdout: liveStdout(Date.now()) });
  let openStream = () => {};
  const stream = new Promise<void>((resolve) => { openStream = resolve; });
  let secondRead = () => {};
  const revalidated = new Promise<void>((resolve) => { secondRead = resolve; });
  let heldCold = false;
  await page.route("**/api/stream", async (route) => { await stream; await route.continue(); });
  await page.route("**/api/usage", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    if (!heldCold) {
      heldCold = true;
      await expect.poll(async () => (await (await request.get("/api/usage")).json()).fetchedAt).not.toBeNull();
      openStream();
      // Keep the old response pending until the stream's revalidation makes another GET.
      await revalidated;
      // Other dashboard consumers can warm the cache before this request. The
      // network still delivers the captured cold response after revalidation.
      await route.fulfill({ response, json: { ...snapshot, fetchedAt: null, generatedAt: null, providers: [], ageSeconds: null, refreshing: true } });
      return;
    } else secondRead();
    await route.fulfill({ response });
  });
  try {
    await page.goto("/#/usage");
    await expect(card(page, '[data-testid="usage-page"]', "claude")).toHaveAttribute("data-state", "live");
    expect(heldCold).toBe(true);
    await shot(page, "C12", "perf-usage-stream-race");
  } finally { openStream(); secondRead(); }
});

test("usage: slow provider reads leave the map and rail usable and show the reading age", async ({ page, request }) => {
  await request.post("/api/usage/test-fake", { data: { result: { kind: "ok", stdout: liveStdout(Date.now()) }, delayMs: 8000 } });
  const started = Date.now();
  const cold = await (await request.get("/api/usage")).json();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(cold).toMatchObject({ fetchedAt: null, refreshing: true });
  await page.addInitScript(() => localStorage.setItem("joyride.guide.dismissed", "1"));
  await page.goto("/#/map");
  await expect(page.locator(".map-root")).toBeVisible();
  await expect(page.locator('[data-rail="approvals"] h3')).toBeVisible();
  await expect(page.locator('[data-rail="usage"]')).toContainText("Reading usage limits…");
  await shot(page, "C12", "perf-map-during-quota-read");
  await expect(card(page, '[data-rail="usage"]', "codex")).toHaveAttribute("data-state", "live", { timeout: 10000 });
  await expect(page.locator('[data-rail="usage"]').getByTestId("usage-age")).toContainText("Read");
  await shot(page, "C12", "perf-usage-age");
});

test("start a session: pick the second Codex account, and the launch carries it", async ({ page, request }) => {
  fs.mkdirSync(SECOND, { recursive: true });
  await fake(request, { kind: "ok", stdout: allLiveStdout(Date.now()) }, { accounts: FOUR, profiles: { "codex-2": { kind: "ok", stdout: codexProfileStdout(Date.now()) } } });
  await page.goto("/#/start-session?cwd=/tmp/joyride-fixture-repos/alpha");
  await expect(page.getByRole("heading", { name: "Start a session", level: 1 })).toBeVisible();
  // Claude has only its default login, so there is nothing to pick.
  await expect(page.getByLabel("Account")).toHaveCount(0);
  await page.getByLabel("Codex", { exact: true }).check();
  const picker = page.getByLabel("Account");
  await expect(picker).toHaveValue("");
  await expect(picker.locator("option")).toHaveText(["Codex (default login)", `Codex 2 (${SECOND})`]);
  await picker.selectOption("codex-2");
  await page.mouse.move(0, 0);
  await shot(page, "C11", "start-session-account");
  await page.getByRole("button", { name: "Start in Herdr" }).click();
  await expect(page).toHaveURL(/#\/worker\//, { timeout: 15000 });
  const launches: any[] = await (await request.get("/api/intents?kind=launch_session")).json();
  expect(launches[0]).toMatchObject({ status: "sent", payload: { agent: "codex", account: "codex-2" }, result: { account: "codex-2" } });
});
