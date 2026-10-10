import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, guardRequest, herdr, raise, seedWorld, W, waitUntil } from "./map-seed";

test.beforeAll(async () => { await seedWorld(); });

test("reply in place: an agent waiting on a question gets the prompt and its item resolves", async ({ page }) => {
  // The codex worker stopped to ask a question (L3, blocked on you); Herdr has it at an input prompt.
  const item = await raise({
    level: "L3", kind: "question", title: "Which key should the sync dedupe on?", worker: W.codex, session: `codex:${FAKE_SESSIONS.codexIdle}`,
    why: "The orders table has both order_id and external_ref. Which one is the idempotency key?",
  });
  await page.goto("/#/map");
  const li = page.locator(`[data-rail="attention"] [data-attention="${item.id}"]`);
  await expect(li).toBeVisible();
  await li.getByRole("textbox").fill("Use external_ref; order_id is reassigned when a batch retries.");
  await shot(page, "C3", "reply-compose");
  await li.getByRole("button", { name: "Send" }).click();
  const prompt = await waitUntil(async () => (await herdr("fake.state")).prompts.find((p: any) => p.target === "w2:p1" && p.text.includes("external_ref")));
  expect(prompt.text).toBe("Use external_ref; order_id is reassigned when a batch retries.");
  await expect(li).toHaveCount(0);
  const it = (await call("GET", `/api/attention/${item.id}`)).body;
  expect(it.resolved).toBeTruthy();
  expect(it.resolution).toBe("human replied");
});

test("worker pane: live status, reply with intent status, recent tools", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(W.codex)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toContainText("Idempotent sync job");
  await expect(sheet.locator(".wp-status")).toContainText("beta");
  await expect(sheet.locator(".mp-crumbs")).toContainText("Make the nightly sync idempotent");
  await sheet.getByLabel(/Reply to Idempotent sync job/).fill("Run the retry tests once more, then summarise.");
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect(sheet.locator("[data-intent-status]")).toHaveAttribute("data-intent-status", /sent|acked/);
  await waitUntil(async () => (await herdr("fake.state")).prompts.some((p: any) => p.text.startsWith("Run the retry tests once more")));
  await expect(sheet.locator("[data-intent-status]")).toContainText(/Delivered|picked up/);
  await shot(page, "C3", "reply");
  // Details: where it runs and the tools it used recently.
  await sheet.getByRole("tab", { name: "Details" }).click();
  await expect(sheet.locator(".mp-facts")).toContainText("beta");
  await expect(sheet.locator(".mp-facts")).toContainText("Make the nightly sync idempotent");
  await expect(sheet.locator(".tool-list li").first()).toBeVisible();
});

test("a Herdr-blocked worker shows its terminal prompt with the options on screen, and its pending approval inline", async ({ page }) => {
  const g = await guardRequest("Push the export branch", "git push origin feature/csv-export");
  await page.goto(`/#/worker/${encodeURIComponent(W.blocked)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toContainText("Flaky export test");
  await expect(sheet.locator(".chip[data-state=blocked]").first()).toBeVisible();
  const pa = sheet.locator(`[data-prompt-answer="${W.blocked}"]`);
  await expect(pa.locator(".pa-screen")).toContainText("npm run test:export -- --runInBand");
  await expect(pa.locator(".pa-screen")).toContainText("Do you want to proceed?");
  await expect(pa.locator(".pa-screen")).not.toContainText("╭"); // the box frame is stripped so it reads at any width
  await expect(pa.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(pa.getByRole("button", { name: "Always allow npm run test:export commands in alpha" })).toBeVisible();
  await expect(pa.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(pa.getByRole("button", { name: "Send keys" })).toBeVisible();
  // No dead end: the reply box says when a reply can reach it.
  await expect(sheet.locator("#wp-reply").locator("..")).toContainText("A reply reaches it once the prompt above is answered.");
  const card = sheet.locator(`[data-guard="${g.id}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator(".ap-cmd")).toHaveText("git push origin feature/csv-export");
  await shot(page, "C3", "worker-blocked");
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await call("GET", `/api/guard/requests/${g.id}`)).body.decision).toBe("allow");
});

test("answer a terminal prompt from the worker pane: Allow types that option's key and the agent moves on", async ({ page }) => {
  await herdr("fake.set_menu", { pane_id: "w1:p2", status: "blocked" });
  await page.goto(`/#/worker/${encodeURIComponent(W.blocked)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const pa = sheet.locator(`[data-prompt-answer="${W.blocked}"]`);
  await expect(pa.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await pa.getByLabel(/Then tell/).fill("Then run only the export tests.");
  await pa.locator(".pa-screen").scrollIntoViewIfNeeded();
  await shot(page, "C3", "answer-prompt");
  const before = (await herdr("fake.state")).keys.length;
  await pa.getByRole("button", { name: "Allow", exact: true }).click();
  const sent = await waitUntil(async () => (await herdr("fake.state")).keys.slice(before).find((k: any) => k.target === "w1:p2"));
  expect(sent.keys).toEqual(["1"]);
  await expect(pa.locator("[data-answer-status]")).toContainText("Sent “Yes”");
  await waitUntil(async () => (await herdr("fake.state")).prompts.some((p: any) => p.target === "w1:p2" && p.text === "Then run only the export tests."));
  await expect(sheet.locator(".wp-status .chip")).not.toHaveAttribute("data-state", "blocked");
  await expect(sheet.getByRole("heading", { name: "Prompt answered" })).toBeVisible();
  await expect(pa.locator(".pa-screen")).toContainText("Running…");
  const intents = (await call<any[]>("GET", `/api/intents?kind=answer_prompt&target=${encodeURIComponent(W.blocked)}`)).body;
  expect(intents[0]).toMatchObject({ status: "sent", result: { keys: ["1"], picked: "Yes" } });
  await shot(page, "C3", "answer-prompt-sent");
  await herdr("fake.set_menu", { pane_id: "w1:p2", status: "blocked" });
});

test("Needs you: deny a blocked agent's prompt from the rail, then send raw keys to a screen without a menu", async ({ page }) => {
  await herdr("fake.set_menu", { pane_id: "w1:p2", status: "blocked" });
  const item = await raise({
    level: "L3", kind: "approval", title: "Needs permission: Bash in alpha", worker: W.blocked, session: `claude:${FAKE_SESSIONS.claudeBlocked}`,
    why: "npm run test:export -- --runInBand",
  });
  await page.goto("/#/map");
  const li = page.locator(`[data-rail="attention"] [data-attention="${item.id}"]`);
  await expect(li.locator(".pa-screen")).toContainText("Do you want to proceed?");
  await expect(li.getByRole("textbox", { name: /Reply to/ })).toHaveCount(0); // a reply can't reach it until the prompt is answered
  await shot(page, "C3", "answer-prompt-rail");
  const before = (await herdr("fake.state")).keys.length;
  await li.getByRole("button", { name: "Deny", exact: true }).click();
  const sent = await waitUntil(async () => (await herdr("fake.state")).keys.slice(before).find((k: any) => k.target === "w1:p2"));
  expect(sent.keys).toEqual(["3"]);
  await expect(li).toHaveCount(0); // answering resolves the item
  expect((await call("GET", `/api/attention/${item.id}`)).body.resolved).toBeTruthy();

  // A prompt Joyride doesn't recognise: the screen and "Send keys" are still there.
  await herdr("fake.set_menu", { pane_id: "w1:p2", status: "blocked", menu: ["Press esc to interrupt, or wait for the build"] });
  await page.goto(`/#/worker/${encodeURIComponent(W.blocked)}`);
  const pa = page.getByRole("dialog", { name: /Worker/ }).locator(`[data-prompt-answer="${W.blocked}"]`);
  await expect(pa.locator(".pa-screen")).toContainText("Press esc to interrupt");
  await expect(pa.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0);
  await expect(pa).toContainText("doesn't recognise a menu");
  await pa.getByRole("button", { name: "Send keys" }).click();
  await pa.getByLabel(/Keys to send/).fill("esc");
  const before2 = (await herdr("fake.state")).keys.length;
  await pa.getByRole("button", { name: "Send keys" }).click();
  const raw = await waitUntil(async () => (await herdr("fake.state")).keys.slice(before2).find((k: any) => k.target === "w1:p2"));
  expect(raw.keys).toEqual(["esc"]);
  await expect(pa.locator("[data-answer-status]")).toContainText("Sent keys esc");
  await herdr("fake.set_menu", { pane_id: "w1:p2", status: "blocked" }); // leave the pane as the scenario started
});

test("palette lists workers and opens one", async ({ page }) => {
  await page.goto("/#/map");
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill("Flaky export test");
  await palette.getByRole("option", { name: /Flaky export test.*blocked worker/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(W.blocked)}`));
});
