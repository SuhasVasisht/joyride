// CP3a, the map as the captain's control plane, from the home page: the Firstmate hub, ideas with their
// Firstmate tasks (who runs each, what it is doing now) and the crewmates inside them, asks pinned to
// the task they block and answered in place, "next ask", and dragging a task to another idea with undo.
// Runs on the e2e sandbox with a fixture FM_HOME (real vendored intake + tasks-axi) and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { call, herdr, openIdea, PORT, waitUntil } from "./map-seed";
import { shot } from "./shot";
import { panTo } from "./chart-pan";

const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const IDEA = "cp3a-export", OTHER = "cp3a-docs";
const SHIP = `local:${FIXTURE_CREW_PANES.ship}`;
const backlog = () => fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  for (const [id, title] of [[IDEA, "Export the report as CSV"], [OTHER, "Document the report page"]]) {
    if ((await call("GET", `/api/missions/${id}`)).status === 404) await call("POST", "/api/missions", { id, title, repos: ["/tmp/joyride-fixture-repos/alpha"] });
    else await call("PUT", `/api/missions/${id}`, { archive: false });
  }
  buildFirstmateHome(home, IDEA);
  addAskFixtures(home);
  // Every spec shares one sandbox daemon: give this call its own hold stamp, so an answer receipt another
  // spec left for the same fixture call is a different lifecycle, not a replay.
  const file = path.join(home, "data", "backlog.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/(  Captain hold set: )\S+/, "$1" + new Date(Date.now() - 864e5).toISOString().slice(0, 10)));
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
  const wt = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "Review worker role contract", label: "alpha-worktrees" });
  }
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === IDEA);
});

test.afterAll(async () => {
  await herdr("fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship }).catch(() => {});
  buildFirstmateHome(home, IDEA);
  for (const id of [IDEA, OTHER]) await call("PUT", `/api/missions/${id}`, { archive: true });
});

async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}

test("the home page charts the hub, ideas, task cards and the crew inside them at every zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const hub = page.getByTestId("firstmate-node");
  await expect(hub).toBeVisible();
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await expect(idea).toBeVisible();
  await idea.locator(".mn-title").focus();

  // Far: the idea's card says what needs the captain, what is stuck and what is moving, and an orange count of what it owes.
  await zoom(page, "Far");
  await expect(idea.locator(".mn-summary")).toHaveText("1 needs you · 1 stuck · 1 moving");
  await expect(idea.locator(".mn-summary .signal-text")).toHaveText("1 needs you");
  await expect(idea.locator(".mn-count.signal")).toBeVisible();
  await expect(idea.locator("[data-task]")).toHaveCount(0);
  await shot(page, "C12", "cp3a-far");

  // Mid: one row per task with what it is doing now (who runs it is on hover), and the call pinned to the scout as a one-line badge.
  await zoom(page, "Mid");
  await expect(idea.locator(`.mn-sec[data-bucket="moving"] .task-row[data-task="${T.ship}"] .tr-now`)).toContainText("running the e2e suite against the totals row");
  await expect(idea.locator(`.task-row[data-task="${T.ship}"] .tr-title`)).toHaveAttribute("title", /Claude Code · claude-opus-5-5, high · claude-2/);
  await expect(idea.locator(`.task-row[data-task="${T.scout}"] .ask-badge.needs-you`)).toContainText("Needs you");
  await expect(idea.locator(`.task-row[data-task="${T.scout}"] .ask-badge:not(.needs-you)`)).toContainText("Firstmate is deciding");
  await shot(page, "C12", "cp3a-mid");

  // Near: the brief card says what it is doing now. Opened, the idea shows the full card: the crewmate sits
  // inside its task (never unfiled), named as the agent on it, not by its brief boilerplate title.
  await zoom(page, "Near");
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await expect(ship.locator(".tc-now")).toContainText("running the e2e suite against the totals row");
  await expect(ship.locator(".tc-who")).toHaveCount(0);
  await shot(page, "C12", "cp3a-near");
  await openIdea(page, IDEA);
  await expect(ship.locator(".tc-who")).toContainText("claude-opus-5-5, high · claude-2");
  await expect(ship.locator(".tc-now")).toContainText("running the e2e suite against the totals row");
  const crew = ship.locator(`.tc-crew [data-worker="${SHIP}"]`);
  await expect(crew).toBeVisible();
  await expect(crew.locator(".wl-title")).toHaveText("Claude Code crewmate");
  await expect(crew.locator('[data-owner="crew"]')).toBeVisible();
  await expect(page.locator(`.region-label.k-unfiled ~ [data-worker="${SHIP}"]`)).toHaveCount(0);
  await expect(page.locator(`.worker-node[data-worker="${SHIP}"]`)).toHaveCount(0);
  await ship.scrollIntoViewIfNeeded();
  await shot(page, "C12", "cp3a-near-task");
});

test("needs-you opens the rail; picking options and words answers its pinned call in place", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
  const next = page.getByTestId("next-ask");
  await expect(next).toHaveClass(/needs-you/);
  await next.click();
  await expect(page.locator(`[data-rail="attention"] .ask-card[data-ask="hold:${ASK_TASKS.calls}"]`)).toBeVisible();
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await expect(idea).toBeVisible();
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  const card = page.locator(`.map-plane .ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
  await panTo(card);
  // Pinned to the task it blocks (the scout's), with the recommendations picked already.
  await expect(page.locator(`.task-card[data-task="${T.scout}"] .ask-card[data-ask="hold:${ASK_TASKS.calls}"]`)).toHaveCount(1);
  await expect(card.getByRole("radio")).toHaveCount(0);
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card.locator(".ak-state")).toHaveText("Needs you");
  await expect(card.getByRole("radio", { name: /the last row/ })).toBeChecked();
  await expect(card.getByRole("radio", { name: /CSV and XLSX/ })).toBeChecked();
  const railCall = page.locator(`[data-rail="attention"] .ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
  await expect(railCall.getByRole("radio", { name: /the last row/ })).toBeChecked();
  await expect(railCall.getByRole("radio", { name: /CSV and XLSX/ })).toBeChecked();
  // The crewmate's keyed decision is Firstmate's to make first: a quiet navy line, not an orange card.
  const decision = page.locator(`.map-plane .ask-card[data-ask="decision:${T.scout}:flake-cause"]`);
  await expect(decision).toHaveAttribute("aria-label", /Firstmate is deciding/);
  await expect(decision).not.toHaveClass(/needs-you/);
  await expect(decision.getByRole("radio")).toHaveCount(0);
  await shot(page, "C12", "cp3a-next-ask");

  await card.getByRole("radio", { name: /the first row/ }).check();
  await card.getByRole("button", { name: "Add your own words" }).click();
  await card.getByRole("textbox", { name: "Your answer" }).fill("Keep the server's rounding.");
  await card.getByRole("button", { name: "Send these choices" }).click();
  const words = "1 B (the first row); 2 B (CSV and XLSX). Keep the server's rounding.";
  await waitUntil(async () => backlog().includes(`- [x] ${ASK_TASKS.calls}`));
  expect(backlog()).toContain(words);
  expect(backlog()).toContain("joyride-map");
  // The card clears once the owner confirms; the idea's count drops with it.
  await expect(card).toHaveCount(0, { timeout: 10000 });
  await shot(page, "C12", "cp3a-answered");
});

test("dragging a task card onto another idea moves it there, and Undo puts it back", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Mid");
  const row = idea.locator(`.task-row[data-task="${T.ship}"] .tr-head`);
  const target = page.locator(`[data-mission="${OTHER}"]`);
  await expect(target).toBeVisible();
  const a = (await row.boundingBox())!, b = (await target.locator(".mn-head").boundingBox())!;
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 10, { steps: 4 });
  await expect(page.locator(".carry-ghost .cg-kind")).toHaveText("Task");
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(target).toHaveClass(/drop-hover/);
  await shot(page, "C12", "cp3a-drag-task");
  await page.mouse.up();

  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText("Moved the task to Document the report page");
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === OTHER);
  await expect(target.locator(`[data-task="${T.ship}"]`)).toHaveCount(1);
  await expect(idea.locator(`[data-task="${T.ship}"]`)).toHaveCount(0);
  await toast.getByRole("button", { name: "Undo" }).click();
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === IDEA);
  await expect(idea.locator(`[data-task="${T.ship}"]`)).toHaveCount(1);
});
