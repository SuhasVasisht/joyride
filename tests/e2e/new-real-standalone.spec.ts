import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { call, waitUntil } from "./map-seed";
import { newInput, newSection, openNew } from "./new-box";
import { shot } from "./shot";
import type { NewReceipt } from "../../src/shared/freeform";

async function send(page: Page, text: string): Promise<NewReceipt> {
  await newInput(page).fill(text);
  const response = page.waitForResponse(r => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await newInput(page).press("Enter");
  return (await response).json();
}
function rollout(session: string) {
  const dir = process.env.E2E_LAB_CODEX_DIR!;
  const files = fs.readdirSync(path.join(dir, "sessions"), { recursive: true });
  const file = files.find(f => typeof f === "string" && f.endsWith(`${session.slice(6)}.jsonl`));
  if (!file) return null;
  return fs.readFileSync(path.join(dir, "sessions", String(file)), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function nativeTurn(session: string, model: string, marker: string) {
  return waitUntil(async () => {
    const rows = rollout(session);
    if (!rows) return false;
    const models = [...new Set(rows.filter(r => r.type === "turn_context").map(r => r.payload.model))];
    const assistant = rows.filter(r => r.type === "response_item" && r.payload.type === "message" && r.payload.role === "assistant").flatMap(r => r.payload.content.map((c: { text?: string }) => c.text ?? "")).join("\n");
    if (!assistant.includes(marker)) return false;
    expect(models).toContain(model);
    return { models, assistant };
  }, 120000);
}
test("native New standalone recovery, deep work, model persistence and Luna small-job proof", async ({ page }) => {
  test.skip(process.env.E2E_NEW_NATIVE !== "1", "Use scripts/lab-new-standalone.sh.");
  test.setTimeout(360000);
  const project = process.env.E2E_NEW_LAB_PROJECT!, cfg = process.env.E2E_LAB_CODEX_DIR!, home = process.env.E2E_LAB_FM_HOME!;
  expect(fs.existsSync(path.join(home, ".fm-lab-home"))).toBe(true);
  expect(home).not.toBe(path.resolve(".joyride/firstmate"));
  expect(process.env.E2E_LAB_HERDR_SOCKET).toContain(`/sessions/${process.env.E2E_NEW_LAB_SESSION}/`);
  const existing = (await call("GET", "/api/system/config")).body.config;
  const saved = await call("PUT", "/api/system/config", { usage: { accounts: [...existing.usage.accounts, { id: "lab-codex", provider: "codex", home: cfg, label: "Isolated Codex" }] }, new_models: { standalone: { backend: "codex", model: "gpt-6-luna", account: "lab-codex", effort: "low" }, small_job: { backend: "codex", model: "gpt-6-luna", account: "lab-codex", effort: "low" } } });
  expect(saved.status, saved.body.error).toBe(200);
  expect((await call("GET", "/api/firstmate/status")).body.running).toBe(false);
  await openNew(page);
  const own = await send(page, `Start a standalone session in repo ${project} in my own group called Native recovery: Firstmate is down. This is a bounded launch check. Do only these steps: read README.md, run pwd, then reply NATIVE_RECOVERY_READY with the folder and README text. Leave the session open for my next request.`);
  expect(own, own.message).toMatchObject({ route: "standalone", state: "done", session: expect.stringMatching(/^codex:/), launch: { model: "gpt-6-luna", account: "lab-codex", cwd: project } });
  const nativeOwn = await nativeTurn(own.session!, "gpt-6-luna", "NATIVE_RECOVERY_READY");
  expect(nativeOwn).toBeTruthy();
  expect(nativeOwn && nativeOwn.assistant).toContain("Standalone lab context");
  expect(nativeOwn && nativeOwn.assistant).toContain(project);
  const group = (await call("GET", "/api/missions/map")).body.groups.find((g: { title: string }) => g.title === "Native recovery");
  expect(group.sessions).toContain(own.session);
  await newSection(page).getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(`[data-worker="${own.worker}"]`).first()).toBeVisible();
  await shot(page, "new-standalone", "native-own-group");
  await newSection(page).getByRole("link", { name: "Open my session", exact: true }).click();
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  await expect(page.locator(".xterm-rows")).toContainText(/gpt-6-luna/i);
  await shot(page, "new-standalone", "native-terminal");
  // A real follow-up through the session's owner proves this is an interactive session.
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  await page.getByRole("dialog", { name: /Worker/ }).getByLabel(/Reply to /).fill("Reply NATIVE_FOLLOWUP_READY only.");
  await page.getByRole("dialog", { name: /Worker/ }).getByRole("button", { name: "Send", exact: true }).click();
  expect(await nativeTurn(own.session!, "gpt-6-luna", "NATIVE_FOLLOWUP_READY")).toBeTruthy();
  await page.goto("/#/settings");
  const form = page.getByRole("form", { name: "New models", exact: true });
  await form.getByLabel("Model for standalone sessions", { exact: true }).fill("gpt-5.6-luna");
  await form.getByRole("button", { name: "Save New model settings" }).click();
  await expect(form.getByRole("status")).toContainText("Saved.");
  await page.reload();
  await expect(form.getByLabel("Model for standalone sessions", { exact: true })).toHaveValue("gpt-5.6-luna");
  await expect(form.getByLabel("Account for standalone sessions", { exact: true })).toHaveValue("lab-codex");
  await form.getByLabel("Model for standalone sessions", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, "new-standalone", "native-model-reload");
  await openNew(page);
  const joined = await send(page, `Start my own session for deep work in repo ${project} join group Native recovery: This is my deep-work session. First do only a launch check: read README.md and run pwd, then reply NATIVE_DEEP_WORK_READY. Leave the session open for my next request.`);
  expect(joined, joined.message).toMatchObject({ route: "standalone", state: "done", landing: { id: group.id }, launch: { model: "gpt-5.6-luna" } });
  const nativeJoin = await nativeTurn(joined.session!, "gpt-5.6-luna", "NATIVE_DEEP_WORK_READY");
  expect(nativeJoin).toBeTruthy();
  expect((await call("GET", "/api/missions/map")).body.groups.find((g: { id: string }) => g.id === group.id).sessions).toEqual(expect.arrayContaining([own.session, joined.session]));
  await newSection(page).getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(`[data-worker="${joined.worker}"]`).first()).toBeVisible();
  await shot(page, "new-standalone", "native-joined-group");
  const idea = (await call("POST", "/api/missions", { id: "native-luna-job", title: "Luna small-job proof", repos: [project], goal: "Find and link an artifact" })).body;
  const artifact = (await call("POST", "/api/artifacts", { title: "Native Luna lookup", url: "https://example.com/native-luna", summary: "Seeded local lookup", mission: idea.id })).body;
  await openNew(page, idea.id);
  const job = await send(page, "Find the artifact titled Native Luna lookup and link it here using its artifact: reference. Use joyride directly. Complete your callback when the link is saved.");
  expect(job, job.message).toMatchObject({ route: "agent", state: "running", session: expect.stringMatching(/^codex:/), launch: { model: "gpt-6-luna" } });
  const done = await waitUntil(async () => {
    const r = (await call<NewReceipt>("GET", `/api/new/${job.id}`)).body;
    if (r.state === "failed") throw new Error(r.message);
    return r.state === "done" ? r : false;
  }, 150000);
  expect(done).toBeTruthy();
  const rows = rollout(job.session!);
  expect(rows?.some(r => r.type === "turn_context" && r.payload.model === "gpt-6-luna")).toBe(true);
  const notes = (await call("GET", `/api/notes?mission=${idea.id}`)).body;
  expect(notes.some((n: { bullets: string[] }) => n.bullets.some(b => b.includes(`artifact:${artifact.id}`)))).toBe(true);
  await shot(page, "new-standalone", "native-luna-job-result");
  fs.mkdirSync("docs/reports", { recursive: true });
  fs.writeFileSync("docs/reports/new-standalone-native.json", JSON.stringify({ at: new Date().toISOString(), fake: false, routing: "fake Jev for repeatability", labSession: process.env.E2E_NEW_LAB_SESSION, firstmateRunning: false, project, own, ownTurn: nativeOwn, joined, joinedTurn: nativeJoin, job: done, jobModels: [...new Set(rows?.filter(r => r.type === "turn_context").map(r => r.payload.model))] }, null, 2) + "\n");
});
