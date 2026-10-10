// CP3b task sheet, from the home page: the crew list and a task's sheet open over the live
// map; the sheet pins the task's asks and answers them in place (a crewmate's keyed decision
// through fm-send --resolve-key, a captain call through fm-captain-hold), shows the report and
// its calls, the timeline, the crew, steers the task, peeks or widens, and #/crew redirects to the crew
// on the Agents page.
// Real vendored intake and tasks-axi in the sandbox FM_HOME; JOYRIDE_TEST stubs every doorbell.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { call, PORT, waitUntil } from "./map-seed";
import { fakeHerdrControl } from "../fixtures/fake-herdr";
import { stopFixtureFirstmate } from "./fixture-cleanup";

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const MISSION = "cp3b-task-sheet";
const CP = "CP3b";
const statusLog = (id: string) => fs.readFileSync(path.join(home, "state", `${id}.status`), "utf8");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await stopFixtureFirstmate();
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  if ((await call("GET", `/api/missions/${MISSION}`)).status === 404) {
    await call("POST", "/api/missions", { id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV with a totals row.", repos: ["/tmp/joyride-fixture-repos/alpha"] });
  }
  buildFirstmateHome(home, MISSION);
  addAskFixtures(home);
  fs.writeFileSync(path.join(home, "data", "secondmates.md"), "");
  const wt = (await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body?.worktree)) as string;
  const st = await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees" });
  }
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
});

test.afterAll(async () => {
  await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship }).catch(() => {});
  await call("PUT", `/api/missions/${MISSION}`, { archive: true });
});

const sheet = (page: Page) => page.getByRole("dialog");

test("from the home page, Agents shows the crew, and a task opens its sheet over the live map", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main[data-route=map]")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Agents/ }).click();
  await page.getByTestId("agents-page").locator('[data-seg="owner"] [data-filter="crew"]').click();
  await expect(page).toHaveURL(/#\/agents\?owner=crew$/);
  const list = page.getByTestId("agents-page");
  await expect(list.locator(".fm-bar")).toContainText("Firstmate is not running");
  const scout = list.locator(`[data-agent="t:${T.scout}"]`);
  await expect(scout).toContainText("Needs your decision");
  await expect(list.locator(`[data-agent="t:${T.ship}"]`)).toContainText("Working");
  await shot(page, CP, "01-crew-list-over-map");

  await scout.locator(".ag-title").click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T.scout}$`));
  await expect(sheet(page).getByRole("heading", { level: 1 })).toContainText(/flake/i);
  // The map stays live beside the peek-width sheet.
  const box = await sheet(page).boundingBox();
  expect(box!.width).toBeLessThanOrEqual(560);
  await expect(page.locator(".sheet-layer")).toBeVisible();
});


test("the scout's sheet pins its decision and the captain call its report raised; the timeline shows the open decision", async ({ page }) => {
  await page.goto(`/#/task/${T.scout}`);
  const s = sheet(page);
  const decision = s.locator(`[data-ask="decision:${T.scout}:flake-cause"]`);
  await expect(decision).toBeVisible();
  await expect(decision.locator(".ask-state")).toHaveText("Firstmate is deciding");
  const calls = s.locator(`.ts-asks [data-ask="hold:${ASK_TASKS.calls}"]`);
  await expect(calls).toBeVisible();
  await expect(calls).toHaveClass(/needs-you/);
  await expect(calls.getByRole("button", { name: "Use all recommendations" })).toBeVisible();
  const open = s.locator(".tl-status.st-open");
  await expect(open).toContainText("pick which to fix first");
  await expect(open).toContainText("still open");
  await expect(s.locator('[data-tl="brief"]')).toBeVisible();
  await shot(page, CP, "02-task-sheet-asks-and-timeline");

  await s.getByRole("tab", { name: /Report/ }).click();
  await expect(s.locator(".ts-doc .md")).toContainText("fix the race first");
  await expect(s.locator(`[data-call="hold:${ASK_TASKS.calls}"]`)).toContainText("Needs you");
  await shot(page, CP, "03-report-and-its-calls");
  await s.locator(`[data-call="hold:${ASK_TASKS.calls}"]`).getByRole("button", { name: "Answer it above" }).click();
  await expect(calls).toBeInViewport();

  await s.getByRole("tab", { name: "Brief" }).click();
  await expect(s.locator(".ts-doc .md")).toContainText("fails one run in five");
});

test("answering in the sheet: the crewmate's keyed decision and the captain call close at their owners", async ({ page }) => {
  await page.goto(`/#/task/${T.scout}`);
  const s = sheet(page);
  const decision = s.locator(`[data-ask="decision:${T.scout}:flake-cause"]`);
  await decision.getByRole("textbox").fill("Fix the download race first");
  await decision.getByRole("button", { name: "Send answer" }).click();
  await expect(decision).toHaveCount(0, { timeout: 15000 });
  expect(statusLog(T.scout)).toMatch(/resolved .*\[key=flake-cause\].*answered: Fix the download race first/);
  const inbox = path.join(home, "state", `${T.scout}.inbox`);
  expect(fs.readdirSync(inbox).filter((n) => n.endsWith(".msg")).map((n) => fs.readFileSync(path.join(inbox, n), "utf8")).join("\n")).toContain("Fix the download race first");
  // The answer shows in the timeline: the decision is closed and the steer waits in the inbox.
  await expect(s.locator(".tl-status.st-open")).toHaveCount(0);
  await expect(s.locator(".tl-status.v-resolved")).toContainText("Fix the download race first");

  const calls = s.locator(`[data-ask="hold:${ASK_TASKS.calls}"]`);
  await calls.getByRole("button", { name: "Use all recommendations" }).click();
  await calls.getByRole("textbox").fill("Keep the server's rounding.");
  await shot(page, CP, "04-captain-call-picked");
  await calls.getByRole("button", { name: "Send answer" }).click();
  await expect(calls).toHaveCount(0, { timeout: 15000 });
  const backlog = fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8");
  expect(backlog).toContain(`- [x] ${ASK_TASKS.calls}`);
  expect(backlog).toContain("1 A: the last row; 2 B: CSV and XLSX; Keep the server's rounding.");
  expect(backlog).toContain("joyride-map");
  await shot(page, CP, "05-asks-answered");
});

test("the steer box sends to the task's inbox and the step lands on the timeline", async ({ page }) => {
  await page.goto(`/#/task/${T.ship}`);
  const s = sheet(page);
  const steer = s.getByRole("textbox", { name: /^Steer / });
  await steer.fill("Put the totals row in bold.");
  await steer.press("Enter");
  await expect(s.locator(".ts-steer").getByRole("status")).toContainText("Recorded in the task's inbox", { timeout: 20000 });
  await expect(s.locator(".tl-steer.st-pending").last().locator(".tl-text")).toHaveText("Put the totals row in bold.");
  await expect(s.locator(".ts-pending")).toContainText("1 steer is waiting");
  const inbox = path.join(home, "state", `${T.ship}.inbox`);
  expect(fs.readdirSync(inbox).filter((n) => n.endsWith(".msg")).map((n) => fs.readFileSync(path.join(inbox, n), "utf8")).join("\n")).toContain("Put the totals row in bold.");
  await shot(page, CP, "06-steer-on-timeline");
  await expect(s.getByRole("button", { name: /Apply a capability/ })).toHaveCount(0);
});

test("the crew tab names who runs the task and opens its worker in the same sheet; widen and Esc", async ({ page }) => {
  await page.goto(`/#/task/${T.ship}`);
  const s = sheet(page);
  await expect(s.locator("[data-who]")).toHaveText("Claude Code · claude-opus-5-5, high · claude-2");
  await s.getByRole("tab", { name: "Crew" }).click();
  await expect(s.locator(".ts-facts")).toContainText("claude-opus-5-5");
  await expect(s.locator(".ts-facts")).toContainText(FIXTURE_CREW_PANES.ship);
  await shot(page, CP, "07-crew-tab");

  const peek = (await s.boundingBox())!.width;
  await s.getByRole("button", { name: "Widen" }).click();
  await expect.poll(async () => (await s.boundingBox())!.width).toBeGreaterThan(peek + 200);
  await shot(page, CP, "08-widened");
  await s.getByRole("button", { name: "Narrow to peek" }).click();
  await expect.poll(async () => (await s.boundingBox())!.width).toBeLessThanOrEqual(560);

  await s.getByRole("link", { name: "CSV crewmate" }).click();
  await expect(page).toHaveURL(/#\/worker\//);
  await expect(page.locator("[data-worker-pane]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`#/task/${T.ship}$`));
  await page.keyboard.press("Escape");
  await expect(page.locator(".sheet-layer")).toHaveCount(0);
});

test("#/crew redirects to the crew or a task's sheet, and an unknown task says what to do", async ({ page }) => {
  await page.goto("/#/crew");
  await expect(page).toHaveURL(/#\/agents\?owner=crew$/);
  await expect(page.getByTestId("agents-page")).toBeVisible();
  await page.goto(`/#/crew/${T.ship}`);
  await expect(page).toHaveURL(new RegExp(`#/task/${T.ship}$`));
  await expect(sheet(page).locator(`[data-task-sheet="${T.ship}"]`)).toBeVisible();
  await page.goto("/#/task/no-such-task");
  await expect(sheet(page)).toContainText("Firstmate has no task by this name");
  await expect(sheet(page).getByRole("link", { name: "See every task" })).toBeVisible();
});
