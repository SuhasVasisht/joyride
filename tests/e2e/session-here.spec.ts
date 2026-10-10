import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, herdr, PORT, waitUntil } from "./map-seed";
import { panTo } from "./chart-pan";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const IDEA = "session-here-export", GROUP = "session-here-reporting";
const REPO = "/tmp/joyride-fixture-repos/alpha";
const FORMER = "a4947948-be11-4c58-94b4-76b5c5e06db0";
const CHECKPOINT = "C12";
let formerWorker = "";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await call("POST", "/api/missions", { id: IDEA, title: "Export totals together", goal: "Export totals once at the end.", repos: [REPO], lenses: [GROUP] });
  await call("POST", "/api/lenses", { id: GROUP, title: "Session reporting", missions: [IDEA] });
  await call("POST", "/api/artifacts", { title: "Export specification", url: "https://example.com/export-spec", mission: IDEA });
  const dir = path.join(env.JOYRIDE_CLAUDE_DIR, "projects", "session-here");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${FORMER}.jsonl`), JSON.stringify({ type: "user", sessionId: FORMER, cwd: REPO, timestamp: new Date().toISOString(), message: { role: "user", content: "Review the map's zoomed view" } }) + "\n");
  await call("POST", "/api/sessions/reindex", {});
  await call("POST", `/api/missions/${IDEA}/sessions`, { refs: [`claude:${FORMER}`] });
  const p = await herdr("fake.add_pane", { cwd: REPO, agent: "claude", agent_status: "idle", title: "Former research session", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: FORMER } });
  formerWorker = `local:${p.pane.pane_id}`;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some(w => w.id === formerWorker), 10000);
});

async function lastLaunch() {
  const intents = (await call<any[]>("GET", "/api/intents?kind=launch_session")).body;
  return intents.find(i => i.payload.here);
}

test("idea card launches with context, is filed on the map and appears in Agents alongside the former dive", async ({ page }) => {
  await page.goto(`/#/map?focus=lens:${GROUP}&idea=${IDEA}`);
  const card = page.locator(`[data-mission="${IDEA}"]`);
  await expect(card).toHaveClass(/d-full/);
  const button = card.getByRole("button", { name: "Start a session here" });
  await panTo(button);
  await shot(page, CHECKPOINT, "session-here-idea-action");
  await button.click();
  await expect(page).toHaveURL(/#\/worker\//, { timeout: 15000 });
  const launch = await lastLaunch();
  expect(launch).toMatchObject({ kind: "launch_session", status: "sent", origin: "captain", payload: { here: { kind: "idea", id: IDEA } } });
  const worker = launch.result.worker, session = launch.result.session;
  const state = await herdr("fake.state");
  expect(launch.result.argv).toContain("--permission-mode");
  const prompt = state.prompts.find((p: any) => p.target === launch.result.pane_id)?.text;
  for (const text of ["Export totals once at the end.", `joyride notes --idea ${IDEA}`, "https://example.com/export-spec", "Write any report to a file and register it with joyride map link."]) expect(prompt).toContain(text);
  expect((await call("GET", `/api/missions/${IDEA}`)).body.sessions.map((s: any) => `${s.source}:${s.id}`)).toContain(session);
  await page.goto(`/#/map?focus=lens:${GROUP}&idea=${IDEA}`);
  await expect(card.locator(`[data-worker="${worker}"]`)).toBeVisible();
  await shot(page, CHECKPOINT, "session-here-filed-on-map");
  await page.goto("/#/agents?owner=yours");
  const idea = page.locator(`[data-idea="${IDEA}"]`);
  await expect(idea.locator(`[data-agent="w:${worker}"]`)).toBeVisible();
  const former = idea.locator(`[data-agent="w:${formerWorker}"]`);
  await expect(former).toBeVisible();
  await expect(former.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", `#/worker/${encodeURIComponent(formerWorker)}`);
  await expect(former.locator('[data-owner="watched"]')).toBeVisible();
  await expect(former.locator('[data-helm="firstmate"]')).toBeVisible();
  await expect(page.getByTestId("agents-dives")).toHaveCount(0);
  const fleet = (await call("GET", "/api/fleet")).body;
  expect(fleet.members.find((m: any) => m.worker === worker)).toMatchObject({ tier: "watched", session });
  expect(fleet.members.find((m: any) => m.worker === formerWorker)).toMatchObject({ tier: "watched", session: `claude:${FORMER}` });
  await idea.scrollIntoViewIfNeeded();
  await shot(page, CHECKPOINT, "session-here-agents-and-former-session");
});

test("idea page falls back to the project checkout and group menu launches into the group", async ({ page }) => {
  await call("POST", "/api/missions", { id: "session-here-no-repo", title: "Plan the launch here", goal: "Plan a small launch." });
  await page.goto("/#/mission/session-here-no-repo");
  await page.locator('[data-mission-page="session-here-no-repo"]').getByRole("button", { name: "Start a session here" }).click();
  await expect(page).toHaveURL(/#\/worker\//, { timeout: 15000 });
  const ideaLaunch = await lastLaunch();
  await expect.poll(async () => (await call<any[]>("GET", "/api/workers")).body.find(w => w.id === ideaLaunch.result.worker)?.cwd).toBe(env.JOYRIDE_HOME);
  await page.goto(`/#/map?focus=lens:${GROUP}`);
  const label = page.locator(`.region-label[data-region="lens:${GROUP}"]`);
  const more = label.getByRole("button", { name: "More for Session reporting" });
  await panTo(more);
  await more.click();
  const button = label.getByRole("button", { name: "Start a session here" });
  await expect(button).toBeVisible();
  await shot(page, CHECKPOINT, "session-here-group-menu");
  await button.click();
  await expect(page).toHaveURL(/#\/worker\//, { timeout: 15000 });
  const groupLaunch = await lastLaunch();
  expect(groupLaunch.payload.here).toEqual({ kind: "group", id: GROUP });
  expect((await call("GET", "/api/lenses")).body.find((l: any) => l.id === GROUP).sessions).toContain(groupLaunch.result.session);
  await page.goto(`/#/map?focus=lens:${GROUP}`);
  const node = page.locator(`[data-worker="${groupLaunch.result.worker}"]`);
  await expect(node).toHaveAttribute("data-region", `lens:${GROUP}`);
  await panTo(node);
  await shot(page, CHECKPOINT, "session-here-group-session");
});
