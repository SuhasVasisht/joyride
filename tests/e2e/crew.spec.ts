// C7 crew and capabilities, end to end against the sandbox daemon, a fixture
// FM_HOME and the fake Herdr: the crew panel on a mission, Start Firstmate,
// create a task, steer a task, and apply capabilities.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { fakeHerdrControl, FIXTURE_REPOS } from "../fixtures/fake-herdr";
import { writePng } from "../fixtures/images";

const port = Number(process.env.E2E_PORT ?? 4399);
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${port}/env.json`, "utf8")) as Record<string, string>;
const base = `http://127.0.0.1:${port}`;
// Not csv-export: all specs share one sandbox daemon, and that mission is seedWorld's.
const MISSION = "csv-totals";

async function api(method: string, p: string, body?: unknown) {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
async function until<T>(fn: () => Promise<T>, ms = 12000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 200)); }
}
const prompts = async () => (await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.state")).prompts as { target: string; text: string; images?: string[] }[];
/** The captain inbox note fm-inbox.sh filed for a create_task intent. */
function noteFor(intentId: string): string {
  const dir = path.join(env.JOYRIDE_RUNTIME, "firstmate", "state", "inbox");
  const body = fs.readdirSync(dir).filter((n) => n.endsWith(".note")).map((n) => fs.readFileSync(path.join(dir, n), "utf8")).find((b) => b.includes(`request_id=${intentId}`));
  if (!body) throw new Error(`no inbox note for ${intentId}`);
  return body;
}
const lastCreateTask = async () => (await api("GET", "/api/intents?kind=create_task&limit=1")).body[0];

async function openCrew(page: Page) {
  await page.goto(`/#/mission/${MISSION}`);
  const panel = page.getByTestId("crew-panel");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  return panel;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
  buildFirstmateHome(home, MISSION);
  for (const s of ["arena", "interrogate", "tdd", "blast-radius", "create-verification-skill", "show-me-your-work", "evals-start"]) {
    const dir = path.join(env.JOYRIDE_CLAUDE_DIR, "skills", s);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${s}\ndescription: fixture\n---\n`);
  }
  const m = await api("POST", "/api/missions", {
    id: MISSION, title: "CSV export with totals", goal: "Users can export the report as CSV, including a totals row.",
    done_when: ["The export button downloads a CSV with a totals row", "An e2e test covers the export"], repos: [FIXTURE_REPOS.alpha],
  });
  expect([201, 409]).toContain(m.status);
  await until(async () => (await api("GET", `/api/firstmate/tasks?mission=${MISSION}`)).body.length === 3);
  // The ship task's crewmate, in the Herdr pane its meta records (other specs may have opened it already).
  const wt = (await api("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees" });
  }
  await until(async () => (await api("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
});

// Close the Firstmate pane started here, so later specs see Firstmate not running, and the crewmate's
// pane, so later specs' missions count only their own workers.
test.afterAll(async () => {
  await api("PUT", `/api/missions/${MISSION}`, { archive: true });
  await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship }).catch(() => {});
  const pane = (await api("GET", "/api/firstmate/status")).body.pane;
  if (pane) await fakeHerdrControl(env.JOYRIDE_HERDR_SOCKET, "fake.close_pane", { pane_id: pane.pane_id });
  await until(async () => !(await api("GET", "/api/firstmate/status")).body.running);
});

test("crew panel shows the mission's Firstmate tasks with status, worktree, branch, last event and crew", async ({ page }) => {
  const panel = await openCrew(page);
  await expect(panel.locator(".fm-bar")).toContainText("Firstmate is not running");
  await expect(panel.getByRole("button", { name: "Start Firstmate" })).toBeEnabled();
  const ship = panel.locator(`[data-task="${T.ship}"]`);
  await expect(ship).toContainText("Add a CSV export button with totals");
  await expect(ship).toContainText("Working");
  await expect(ship).toContainText(`fm/${T.ship}`);
  await expect(ship).toContainText("running the e2e suite against the totals row");
  await expect(ship.getByRole("link", { name: "CSV crewmate" })).toBeVisible();
  const scout = panel.locator(`[data-task="${T.scout}"]`);
  await expect(scout.locator(".chip")).toHaveText("Needs your decision");
  await expect(panel.locator(`[data-task="${T.queued}"]`)).toContainText("Waiting on another task");
  await expect(panel.locator(`[data-task="${T.done}"]`)).toHaveCount(0); // the done task belongs to no mission here
  await panel.locator(".fm-bar").scrollIntoViewIfNeeded();
  await shot(page, "C7", "crew-panel");

  await scout.getByRole("button", { name: "Read report" }).click();
  await expect(scout.locator(".task-report pre")).toContainText("fix the race first");
  await scout.getByRole("button", { name: "Steer" }).click();
  await scout.locator("textarea").fill("Fix the download race first, then the timezone default.");
  await scout.getByRole("button", { name: "Send to the crew" }).click();
  await expect(scout.getByRole("status")).toContainText("Recorded in the task's inbox");
  await expect(scout).toContainText("1 steer waiting in the inbox");
  await scout.scrollIntoViewIfNeeded();
  await shot(page, "C7", "crew-report-and-steer");
  const inbox = path.join(env.JOYRIDE_RUNTIME, "firstmate", "state", `${T.scout}.inbox`);
  const msg = fs.readdirSync(inbox).find((n) => n.endsWith(".msg"))!;
  expect(fs.readFileSync(path.join(inbox, msg), "utf8")).toContain("Fix the download race first");
});

test("start Firstmate, then create a task", async ({ page }) => {
  const panel = await openCrew(page);
  await panel.getByRole("button", { name: "Create a task with Firstmate" }).click();
  const form = panel.getByRole("form", { name: "Create a task with Firstmate" });
  // A stopped Firstmate still takes the task: the inbox note waits for its next start.
  await expect(form).toContainText("The task waits in its inbox until Firstmate starts");
  await panel.getByRole("button", { name: "Start Firstmate" }).click();
  await expect(panel.locator(".fm-bar")).toContainText("Firstmate is running in its own Herdr pane", { timeout: 15000 });
  await until(async () => (await api("GET", "/api/firstmate/status")).body.primary.phase === "ready");
  await form.getByLabel("What should the crew do?").fill("Add the totals row to the CSV export and cover it with an e2e test");
  await form.scrollIntoViewIfNeeded();
  await shot(page, "C7", "crew-create-task-form");
  const typedBefore = (await prompts()).length;
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Sent to Firstmate's inbox" })).toBeVisible();
  // Filed as a captain inbox note, so nothing was typed into Firstmate's pane.
  expect((await prompts()).length).toBe(typedBefore);
  const p = { text: noteFor((await lastCreateTask()).id) };
  expect(p.text).toContain(`joyride-mission: ${MISSION}`);
  expect(p.text).toContain("project mode local-only, no push/PR");
  await page.locator("#panel-crew").evaluate((e) => e.scrollIntoView({ block: "start" }));
  await shot(page, "C7", "crew-task-sent");
});

test("images go to Firstmate with a new task and to a crewmate with a steer", async ({ page }) => {
  const panel = await openCrew(page);
  await expect(panel.locator(".fm-bar")).toContainText("Firstmate is running");
  const shotFile = writePng(path.join(env.JOYRIDE_RUNTIME, "e2e-images"), "totals-mock.png");

  // Create a task with a screenshot of the wanted result.
  await panel.getByRole("button", { name: "Create a task with Firstmate" }).click();
  const form = panel.getByRole("form", { name: "Create a task with Firstmate" });
  await form.getByLabel("What should the crew do?").fill("Make the totals row look like this mock");
  await form.locator("[data-attach-input]").setInputFiles(shotFile);
  await expect(form.locator('[data-attachment="ready"]')).toHaveCount(1);
  await form.scrollIntoViewIfNeeded();
  await shot(page, "chat-images", "firstmate-create-task-with-image");
  await form.getByRole("button", { name: "Create task" }).click();
  const sent = panel.getByRole("status").filter({ hasText: "and the image paths" });
  await expect(sent).toBeVisible();
  await expect(sent.locator(".sent-images img")).toHaveCount(1);
  const it = await lastCreateTask();
  expect(it.result.images).toHaveLength(1);
  expect(noteFor(it.id)).toContain(`- ${it.result.images[0]}`);

  // Steer a running task with an image: the crewmate's inbox gets the path and how to open it.
  const scout = panel.locator(`[data-task="${T.scout}"]`);
  await scout.getByRole("button", { name: "Steer" }).click();
  await scout.locator("textarea").fill("The CSV header is wrong, see the screenshot.");
  await scout.locator("[data-attach-input]").setInputFiles(shotFile);
  await expect(scout.locator('[data-attachment="ready"]')).toHaveCount(1);
  await scout.getByRole("button", { name: "Send to the crew" }).click();
  const ok = scout.getByRole("status");
  await expect(ok).toContainText("Recorded in the task's inbox with the image paths");
  await expect(ok.locator(".sent-images img")).toHaveCount(1);
  await scout.scrollIntoViewIfNeeded();
  await shot(page, "chat-images", "firstmate-steer-with-image");
  const inbox = path.join(env.JOYRIDE_RUNTIME, "firstmate", "state", `${T.scout}.inbox`);
  const bodies = fs.readdirSync(inbox).filter((n) => n.endsWith(".msg")).map((n) => fs.readFileSync(path.join(inbox, n), "utf8"));
  const msg = bodies.find((b) => b.includes("The CSV header is wrong"))!;
  expect(msg).toMatch(/- \/.*\/uploads\/\d{4}-\d{2}-\d{2}\/[a-z0-9]+\.png/);
  expect(msg).toContain("Read in Claude Code and view_image in Codex");
});
