import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { call, waitUntil, PORT } from "./map-seed";
import { newInput, newSection, openNew } from "./new-box";
import { shot } from "./shot";
import type { NewReceipt } from "../../src/shared/freeform";

async function send(page: Page, text: string): Promise<NewReceipt> {
  await newInput(page).fill(text);
  const response = page.waitForResponse(r => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await newInput(page).press("Enter");
  return (await response).json();
}
test("New launches standalone own-group and existing-group sessions without Firstmate work", async ({ page }) => {
  const tasksBefore = (await call("GET", "/api/intents?kind=create_task")).body.length;
  const cwd = `/tmp/joyride-e2e-${PORT}/home`;
  await openNew(page);
  const own = await send(page, `Start a standalone session in repo ${cwd} in my own group called Solo triage: inspect the repo because Firstmate is unavailable`);
  expect(own, own.message).toMatchObject({ route: "standalone", state: "done", session: expect.stringMatching(/^codex:/), launch: { model: "gpt-6-luna", cwd } });
  await expect(newSection(page).getByRole("link", { name: "Open my session", exact: true })).toBeVisible();
  await newSection(page).getByRole("button", { name: "Show on map" }).click();
  const group = (await call("GET", "/api/missions/map")).body.groups.find((g: { title: string }) => g.title === "Solo triage");
  expect(group.sessions).toContain(own.session);
  await expect(page.locator(`[data-worker="${own.worker}"]`).first()).toBeVisible();
  await shot(page, "new-standalone", "own-group");
  await newSection(page).getByRole("link", { name: "Open my session", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await shot(page, "new-standalone", "usable-terminal");
  await openNew(page);
  const joined = await send(page, `Start my own session for deep work in repo ${cwd} join group Solo triage: review architecture`);
  expect(joined, joined.message).toMatchObject({ route: "standalone", state: "done", landing: { kind: "group", id: group.id } });
  expect((await call("GET", "/api/missions/map")).body.groups.find((g: { id: string }) => g.id === group.id).sessions).toContain(joined.session);
  await shot(page, "new-standalone", "join-existing");
  expect((await call("GET", "/api/intents?kind=create_task")).body).toHaveLength(tasksBefore);
});
test("uncertain repo or group offers a bounded choice and preserves the original request", async ({ page }) => {
  await openNew(page);
  const text = "Start my own session join group A group that does not exist: triage the repo";
  expect(await send(page, text)).toMatchObject({ route: "standalone", state: "choose", worker: null });
  await expect(newInput(page)).toHaveValue(text);
  const choices = newSection(page).locator("[data-standalone-choices]");
  await expect(choices).toBeVisible();
  await choices.getByLabel("Standalone repo folder", { exact: true }).fill(`/tmp/joyride-e2e-${PORT}/home`);
  await choices.getByLabel("Standalone canvas group").selectOption("new");
  await choices.getByLabel("Standalone group name").fill("Chosen solo group");
  await shot(page, "new-standalone", "supported-choice");
  await choices.getByRole("button", { name: "Start my session" }).click();
  await expect(newSection(page).locator('[data-new-result]')).toHaveAttribute("data-state", "done");
  await expect(newSection(page).locator('[data-new-result]')).toContainText("Chosen solo group");
});
test("New role models and accounts persist through reload with useful validation errors", async ({ page }) => {
  await page.goto("/#/settings");
  const form = page.getByRole("form", { name: "New models", exact: true });
  await form.getByLabel("Model for standalone sessions", { exact: true }).fill("gpt-5.6-luna");
  await form.getByLabel("Account for standalone sessions", { exact: true }).selectOption("codex");
  await form.getByLabel("Effort for standalone sessions", { exact: true }).selectOption("high");
  await form.getByLabel("Model for small New jobs", { exact: true }).fill("gpt-5.6-luna");
  await form.getByLabel("Model for New routing", { exact: true }).fill("jev-custom-test");
  await form.getByRole("button", { name: "Save New model settings" }).click();
  await expect(form.getByRole("status")).toContainText("Saved.");
  await page.reload();
  await expect(form.getByLabel("Model for standalone sessions", { exact: true })).toHaveValue("gpt-5.6-luna");
  await expect(form.getByLabel("Account for standalone sessions", { exact: true })).toHaveValue("codex");
  await expect(form.getByLabel("Effort for standalone sessions", { exact: true })).toHaveValue("high");
  await expect(form.getByLabel("Model for small New jobs", { exact: true })).toHaveValue("gpt-5.6-luna");
  await expect(form.getByLabel("Model for New routing", { exact: true })).toHaveValue("jev-custom-test");
  await form.getByLabel("Model for standalone sessions", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "new-standalone", "model-settings");
  await form.getByLabel("Model for standalone sessions", { exact: true }).fill("haiku");
  const refreshed = page.waitForResponse(r => r.url().endsWith("/api/system/config") && r.request().method() === "GET");
  expect((await call("PUT", "/api/system/config", { port: PORT })).status).toBe(200);
  await refreshed;
  await expect(form.getByLabel("Model for standalone sessions", { exact: true })).toHaveValue("haiku");
  await form.getByRole("button", { name: "Save New model settings" }).click();
  await expect(form.getByRole("status")).toContainText('Model "haiku" is not supported');
  await call("PUT", "/api/system/config", { new_models: { routing: { backend: "jev" }, small_job: { backend: "codex", model: "gpt-6-luna" }, standalone: { backend: "codex", model: "gpt-6-luna" } } });
});

test("standalone delivery report opens its saved self-contained HTML in the artifact reader", async ({ page }) => {
  const report = path.resolve("docs/reports/new-standalone.html");
  test.skip(!fs.existsSync(report), "needs the local proof report; docs/reports is gitignored");
  const registered = await call("POST", "/api/artifacts", {
    local_source: report,
    kind: "report", title: "New standalone sessions: implementation and proof",
  });
  expect(registered.status).toBe(201);
  expect(registered.body.snapshot_blob).toMatch(/^[a-f0-9]{64}$/);
  await page.goto(`/#/artifacts/${registered.body.id}`);
  const reader = page.getByTestId("artifact-reader");
  const frame = page.frameLocator('[data-testid="artifact-reader-frame"]');
  await expect(frame.getByRole("heading", { name: "New standalone sessions", exact: true })).toBeVisible();
  await expect(frame.locator("figure img")).toHaveCount(7);
  await expect(frame.locator("body")).toContainText("gpt-6-luna");
  await shot(page, "new-standalone", "report-reader");
  await reader.getByRole("button", { name: "Back to details" }).click();
  await expect(page.getByTestId("artifact-detail")).toBeVisible();
});
