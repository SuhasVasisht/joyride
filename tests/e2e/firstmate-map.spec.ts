// Firstmate's own node on the map, the fleet bridge: always charted, apart from
// missions and unfiled work, with the control session's state, tasks in flight,
// captain calls and the fleet's counts; one click opens the control session. Runs against the sandbox daemon,
// a fixture FM_HOME and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, PORT, seedWorld, waitUntil } from "./map-seed";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const CONTROL_TITLE = "First-time setup";
let control: string | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), "csv-export");
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
  // Crewmates in the panes their tasks recorded. The ship task is csv-export's, so its crewmate sits in
  // that mission; the done task belongs to no mission, so its crewmate is unfiled under its project, beta.
  const wt = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    const dir = (await call("GET", "/api/firstmate/status")).body.vendor.path;
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: dir, foreground_cwd: path.join(wt, "src"), agent: "codex", agent_status: "working", title: "CSV crewmate", label: "firstmate" });
  }
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.done)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.done, cwd: "/tmp/joyride-fixture-repos/beta", agent: "claude", agent_status: "working", title: "Sync crewmate", label: "beta-worktrees" });
  }
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.done}`)).body.workers.length === 1);
});

test.afterAll(async () => {
  // Later specs in the same run expect Firstmate stopped, and count only their own workers.
  if (control) await herdr("fake.close_pane", { pane_id: control }).catch(() => {});
  for (const pane_id of Object.values(FIXTURE_CREW_PANES)) await herdr("fake.close_pane", { pane_id }).catch(() => {});
});

test("the map charts Firstmate as its own node; start it and open the control session in one click", async ({ page }) => {
  // Firstmate is not vendored in every checkout, so the start endpoint is answered here by bringing up
  // its pane in the fake Herdr. The daemon's own start flow is covered in crew.spec.ts.
  let started = 0;
  await page.route("**/api/firstmate/start", async (route) => {
    started++;
    const r = await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "idle", name: "firstmate", title: CONTROL_TITLE, label: "firstmate" });
    control = r.pane.pane_id;
    await route.fulfill({ json: { id: "fixture-start", status: "acked", error: null, result: { started: true } } });
  });

  await page.goto("/");
  const vp = page.locator(".map-viewport");
  const node = page.getByTestId("firstmate-node");
  await expect(node).toBeVisible();
  // Fit on load picks the zoom from how much is charted, which depends on earlier specs; Mid shows every
  // stat, and zooming keeps the focused node in view.
  await node.getByRole("button", { name: "Start Firstmate" }).focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  await expect(node).toHaveAttribute("data-firstmate", "stopped");
  await expect(node.locator(".fm-title")).toHaveText("Firstmate");
  await expect(node.locator(".fm-state")).toHaveText("Not running");
  await expect(node.locator('[data-fm="in-flight"]')).toHaveText("2 tasks moving");
  const needs = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
  if (needs) await expect(node.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(needs));
  else await expect(node.locator('[data-count="needs-you"]')).toHaveCount(0);
  await expect(node.getByRole("button", { name: "Start Firstmate" })).toBeEnabled();
  // Its own node, not a mission cluster or an unfiled group; no place-name of its own.
  await expect(page.locator(".region-label .rl-title", { hasText: "Firstmate" })).toHaveCount(0);
  await expect(page.locator(".mission-node .mn-title", { hasText: "Firstmate" })).toHaveCount(0);

  await shot(page, "C7", "map-firstmate-stopped");

  await node.getByRole("button", { name: "Start Firstmate" }).click();
  await expect(node).toHaveAttribute("data-firstmate", "running", { timeout: 15000 });
  expect((await call("GET", "/api/firstmate/status")).body.pane.pane_id).toBe(control);
  expect(started).toBe(1);
  await herdr("fake.set_status", { pane_id: control, status: "working" });
  await expect(node.locator(".fm-state")).toHaveText("Working");
  await expect(node.getByRole("button", { name: "Start Firstmate" })).toHaveCount(0);

  // The control session never shows up as unfiled work. A crewmate whose task no idea names sits in
  // that task's card beside the hub ("Not in an idea yet"), never loose in its project.
  await expect(page.locator("[data-worker]", { hasText: CONTROL_TITLE })).toHaveCount(0);
  await expect(page.locator(".sessions-node", { hasText: CONTROL_TITLE })).toHaveCount(0);
  await expect(page.locator(`.orphans-node [data-task="${T.done}"]`)).toHaveCount(1);
  await expect(page.locator(`.worker-node[data-worker="local:${FIXTURE_CREW_PANES.done}"]`)).toHaveCount(0);

  // Default view (fit on load), then Far: the node stays on screen and readable.
  await page.goto("/");
  await expect(node).toHaveAttribute("data-firstmate", "running");
  await expect(node).toBeInViewport();
  await expect(node.locator(".fm-title")).toBeVisible();
  await expect(async () => {
    const count = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
    if (count) await expect(node.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(count), { timeout: 500 });
    else await expect(node.locator('[data-count="needs-you"]')).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await shot(page, "C7", "map-firstmate-default");

  await node.locator(".fm-title").focus();
  await page.getByRole("radio", { name: "Far" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "far");
  await expect(node).toBeInViewport();
  await expect(node.locator(".fm-title")).toBeVisible();
  await expect(node.locator('[data-fm="in-flight"]')).toHaveText("2 moving");
  await expect(async () => {
    const count = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
    if (count) await expect(node.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(count), { timeout: 500 });
    else await expect(node.locator('[data-count="needs-you"]')).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await shot(page, "C7", "map-firstmate-far");

  await page.getByRole("radio", { name: "Near" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "near");
  // The bridge counts the fleet instead of mooring crew cards.
  await expect(node.locator(".fm-crew")).toHaveCount(0);
  await expect(node.locator('[data-fm="fleet"] [data-count="crew"]')).toHaveText("2 crewmates");
  await shot(page, "C7", "map-firstmate-near");

  // One click on the card opens the control session: chat, terminal and the reply box.
  await node.locator(".fm-line").click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(`local:${control}`)}$`));
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toContainText(CONTROL_TITLE);
  await expect(sheet.locator(".mp-crumbs")).toHaveText(/Map\s*\/\s*Firstmate\s*\/\s*Worker/);
  await expect(sheet.getByRole("tab", { name: "Chat" })).toBeVisible();
  await expect(sheet.getByRole("tab", { name: "Terminal" })).toBeVisible();
  await expect(sheet.getByLabel(`Reply to ${CONTROL_TITLE}`)).toBeVisible();
  await expect(node).toHaveClass(/selected/);
  await shot(page, "C7", "map-firstmate-open");
});
