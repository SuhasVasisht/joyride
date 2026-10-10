// Fleet phase 0, truthful projection, from the home page: a crewmate on a mission's task sits in that
// mission (not at the Firstmate node), a crewmate outside missions is unfiled under its project (phase 1;
// it used to moor at the Firstmate node), and a captain session opened inside a crew worktree is the
// captain's (watched), not crew. Runs against
// the sandbox daemon, a fixture FM_HOME and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, PORT, seedWorld, waitUntil, openIdea } from "./map-seed";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const CAPTAIN = "Captain in the crew worktree";
const SHIP = `local:${FIXTURE_CREW_PANES.ship}`;
const DONE = `local:${FIXTURE_CREW_PANES.done}`;
let captain: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), "csv-export");
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
  const wt = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees" });
  }
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.done)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.done, cwd: "/tmp/joyride-fixture-repos/beta", agent: "claude", agent_status: "working", title: "Sync crewmate", label: "beta-worktrees" });
  }
  // The captain's own session, opened inside the ship task's worktree: the old cwd rule called it crew.
  captain = (await herdr("fake.add_pane", { cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: CAPTAIN, label: "captain" })).pane.pane_id;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.title === CAPTAIN));
});

// Later specs count only their own workers.
test.afterAll(async () => {
  for (const pane_id of [captain, ...Object.values(FIXTURE_CREW_PANES)]) if (pane_id) await herdr("fake.close_pane", { pane_id }).catch(() => {});
});

test("the projection names crew by recorded pane, ties a mission's crewmate to that mission, and leaves the captain's session watched", async () => {
  const ws = (await call<any[]>("GET", "/api/workers")).body;
  expect(ws.find((w) => w.id === SHIP)).toMatchObject({ crew: T.ship, owner: { tier: "crew", task: T.ship, via: "pane" }, mission: "csv-export" });
  expect(ws.find((w) => w.id === DONE)).toMatchObject({ crew: T.done, owner: { tier: "crew", task: T.done, via: "pane" }, mission: null });
  expect(ws.find((w) => w.title === CAPTAIN)).toMatchObject({ crew: null, owner: { tier: "watched", task: null }, mission: null });
  const ship = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body;
  expect(ship.workers.map((w: any) => w.id)).toEqual([SHIP]);
});

test("on the home map, a crewmate sits in its task's card: inside its mission, or beside the hub when no mission names the task", async ({ page }) => {
  await page.goto("/");
  const vp = page.locator(".map-viewport");
  const node = page.getByTestId("firstmate-node");
  await expect(node).toBeVisible();
  // Fit on load picks a zoom once the world has loaded; then zoom to Near around the mission.
  const mission = page.locator('[data-mission="csv-export"]');
  await expect(mission).toBeVisible();
  // The captain's card shows at every zoom once the workers have loaded.
  await expect(page.locator(`[data-worker="local:${captain}"]`)).toBeAttached();
  await mission.locator(".mn-title").focus();
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "near");

  // The csv-export mission, opened, shows its crewmate inside its task's card, named as the agent on the task.
  await openIdea(page, "csv-export");
  const crewLine = mission.locator(`.task-card .tc-crew a[href$="${encodeURIComponent(SHIP)}"]`);
  await expect(crewLine).toBeAttached();
  await expect(crewLine).toContainText("Claude Code crewmate");
  await expect(crewLine).toHaveAttribute("title", "CSV crewmate");

  // The Firstmate node moors no crew: the crewmate whose task has no mission sits in that task's
  // card beside the hub, never unfiled under its project.
  await expect(node.locator(".fm-crew")).toHaveCount(0);
  const sync = page.locator(`.orphans-node .task-card [data-worker="${DONE}"]`);
  await expect(sync).toBeAttached();
  await expect(sync.locator('[data-owner="crew"]')).toBeAttached();
  await expect(page.locator(`.worker-node[data-worker="${DONE}"]`)).toHaveCount(0);

  // The captain's session is not crew: it is a worker card of its own, outside the Firstmate node.
  const card = page.locator(`[data-worker="local:${captain}"]`);
  await expect(card).toBeAttached();
  await expect(card).toContainText(CAPTAIN);
  await expect(card.locator('[data-owner="watched"]')).toBeAttached();
  await expect(page.locator("[data-worker]", { hasText: "CSV crewmate" })).toHaveCount(0);

  await expect(mission.locator(".mn-title")).toBeInViewport();
  await shot(page, "fleet-p0", "map-crew-in-mission");
});
