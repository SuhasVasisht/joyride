import { test, expect } from "@playwright/test";
import { call, herdr, waitUntil, FAKE_SESSIONS } from "./map-seed";
import { shot } from "./shot";

const CP = "C7/chat-resume";
const session = `codex:${FAKE_SESSIONS.codexIdle}`;
let pane = "";
const worker = () => `local:${pane}`;
const slowMethods = ["pane.list", "agent.list", "events.subscribe"];
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const r = await herdr("fake.add_pane", { label: "firstmate", name: "firstmate", title: "Chat lab supervisor", cwd: "/tmp/joyride-fixture-firstmate", agent: "codex", agent_status: "working", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: FAKE_SESSIONS.codexIdle } });
  pane = r.pane.pane_id;
  await waitUntil(async () => (await call("GET", "/api/firstmate/status")).body.pane?.worker === worker());
});

test.afterAll(async () => {
  await herdr("fake.set_delay", { methods: slowMethods, ms: 0 });
  if (pane) await herdr("fake.close_pane", { pane_id: pane });
});

test("home to Firstmate chat keeps its draft and composer across a transport timeout and reload", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Firstmate", exact: true }).click();
  const box = page.getByLabel("Reply to Chat lab supervisor");
  await expect(box).toBeVisible();
  await box.fill("Keep this draft for the same supervisor");
  await shot(page, CP, "working-before");
  // Disconfirm the hypothesis that a quiet supervision checkpoint ends the conversation.
  for (const status of ["idle", "unknown", "working"]) {
    await herdr("fake.set_status", { pane_id: pane, status });
    await waitUntil(async () => (await call("GET", `/api/workers/${encodeURIComponent(worker())}`)).body.status === status);
    await expect(box).toHaveValue("Keep this draft for the same supervisor");
  }
  await herdr("fake.set_delay", { methods: slowMethods, ms: 5000 });
  await waitUntil(async () => (await call("GET", `/api/workers/${encodeURIComponent(worker())}`)).body.controllable === false, 15000);
  // The initiating read timeout changes transport reachability only. The agent and session remain present.
  const snapshot = (await call("GET", `/api/workers/${encodeURIComponent(worker())}`)).body;
  expect(snapshot).toMatchObject({ pane, session, owner: { tier: "control" } });
  await expect(page.locator(".wp-outside")).toHaveCount(0);
  await expect(box).toHaveValue("Keep this draft for the same supervisor");
  await expect(page.locator(".wp-reply")).toContainText("Reconnecting to Herdr");
  await expect(page.locator(".reply-row button[type=submit]")).toBeDisabled();
  await page.locator(".reply-row").scrollIntoViewIfNeeded();
  await shot(page, CP, "reconnecting");
  await page.reload();
  await expect(box).toHaveValue("Keep this draft for the same supervisor");
  await expect(page.getByRole("button", { name: "Copy resume command" })).toHaveCount(0);
  await box.fill("Still the same draft after reload");
  await herdr("fake.set_delay", { methods: slowMethods, ms: 0 });
  await expect(page.locator(".reply-row button[type=submit]")).toBeEnabled({ timeout: 15000 });
  await expect(box).toHaveValue("Still the same draft after reload");
  await page.locator(".reply-row").scrollIntoViewIfNeeded();
  await shot(page, CP, "recovered");
  await box.press("Enter");
  await expect.poll(async () => (await herdr("fake.state")).prompts.filter((p: { target: string; text: string }) => p.target === pane && p.text === "Still the same draft after reload").length).toBe(1);
  await expect(page.locator('[data-staged="queued"]')).toContainText("Still the same draft after reload");
  await page.reload();
  // The native queue can advance to delivered while the page reloads. The request must remain visible.
  await expect(page.locator("[data-staged]").filter({ hasText: "Still the same draft after reload" })).toBeVisible();
});

test("a provider transition keeps drafts and requests bound to their original conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Firstmate", exact: true }).click();
  const original = (await call("GET", `/api/workers/${encodeURIComponent(worker())}`)).body;
  await page.getByLabel("Reply to Chat lab supervisor").fill("Original Codex draft");
  const replacement = { pane_id: pane, workspace_id: pane.split(":")[0], label: "firstmate", name: "firstmate", title: "Recovered Claude supervisor", cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "idle", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: FAKE_SESSIONS.claudeWorking } };
  await herdr("fake.add_pane", replacement);
  await expect(page.getByLabel("Reply to Recovered Claude supervisor")).toHaveValue("");
  const rejected = (await call("POST", "/api/intents", { kind: "reply", target: worker(), payload: { text: "Pending original request", binding: { session, terminal_id: original.terminal_id, control: true } } })).body;
  expect(rejected).toMatchObject({ status: "failed", result: { code: "connection_changed" } });
  expect((await herdr("fake.state")).prompts.some((p: { text: string }) => p.text === "Pending original request")).toBe(false);
  await page.getByLabel("Reply to Recovered Claude supervisor").fill("Claude draft");
  await shot(page, CP, "provider-recovered");
  await herdr("fake.add_pane", { ...replacement, title: "Chat lab supervisor", agent: "codex", agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: FAKE_SESSIONS.codexIdle } });
  await expect(page.getByLabel("Reply to Chat lab supervisor")).toHaveValue("Original Codex draft");
  await page.reload();
  await expect(page.getByLabel("Reply to Chat lab supervisor")).toHaveValue("Original Codex draft");
  await expect(page.locator('[data-staged="failed"]')).toContainText("Pending original request");
});

test("unbound and stopped supervisors cannot send while their saved drafts remain recoverable", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Firstmate", exact: true }).click();
  await page.getByLabel("Reply to Chat lab supervisor").fill("Keep the original draft on stop");
  await herdr("fake.close_pane", { pane_id: pane });
  // The failed refresh must disable the retained composer rather than leave a stale live send button.
  await expect(page.locator(".wp-reply")).toContainText("not running");
  await expect(page.locator(".reply-row button[type=submit]")).toBeDisabled();
  await expect(page.getByLabel("Reply to Chat lab supervisor")).toHaveValue("Keep the original draft on stop");
  await page.reload();
  await expect(page.getByText("This worker has stopped", { exact: true })).toBeVisible();
  await expect(page.locator(".reply-row")).toHaveCount(0);
  await shot(page, CP, "stopped");
  await herdr("fake.add_pane", { pane_id: pane, workspace_id: pane.split(":")[0], label: "firstmate", name: "firstmate", title: "Unbound supervisor", cwd: "/tmp/joyride-fixture-firstmate", agent: "codex", agent_status: "unknown" });
  await page.goto("/");
  await page.getByRole("link", { name: "Firstmate", exact: true }).click();
  await expect(page.locator(".wp-reply")).toContainText("Waiting for Firstmate's conversation");
  await page.getByLabel("Reply to Unbound supervisor").fill("Unbound draft stays unsent");
  await expect(page.locator(".reply-row button[type=submit]")).toBeDisabled();
  await page.getByLabel("Reply to Unbound supervisor").press("Enter");
  expect((await herdr("fake.state")).prompts.some((p: { text: string }) => p.text === "Unbound draft stays unsent")).toBe(false);
  await shot(page, CP, "unbound");
});
