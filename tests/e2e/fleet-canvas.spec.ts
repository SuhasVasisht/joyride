// Fleet phase 1, one canvas, from the home page: every session card carries an owner chip (crew or
// watched) and a helm chip; the Firstmate node is the fleet bridge with the fleet's counts; work
// outside missions is unfiled by project, crew and the captain's own sessions together; and each count
// opens the Agents page on that filter, with quick actions to open or steer. Runs against the sandbox
// daemon, a fixture FM_HOME and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, openIdea, PORT, seedWorld, waitUntil } from "./map-seed";

const sandbox = `/tmp/joyride-e2e-${PORT}`;
const env = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8")) as Record<string, string>;
const CAPTAIN = "Captain's docs pass";
const CAPTAIN_SESSION = "f1ee7000-0000-4000-8000-000000000001";
const SHIP = `local:${FIXTURE_CREW_PANES.ship}`;
const SYNC = `local:${FIXTURE_CREW_PANES.done}`;
let captainPane = "";
const captain = () => `local:${captainPane}`;

/** Hook events in the sandbox's event log, as the global hooks would write them from the captain's pane. */
function appendHookEvents(evs: { type: string; data: Record<string, unknown>; agoMs: number }[]) {
  const dir = path.join(env.JOYRIDE_RUNTIME, "events");
  if (!dir.startsWith(sandbox)) throw new Error("refusing: event log is not in the sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const lines = evs.map((e, i) => JSON.stringify({
    ts: new Date(Date.now() - e.agoMs).toISOString(), id: `ev_e2e_fleet_${PORT}_${Date.now()}_${i}`, source: "hook.claude", type: e.type,
    session: CAPTAIN_SESSION, agent: "claude", cwd: "/tmp/joyride-fixture-repos/gamma", pane: captainPane, data: e.data,
  }));
  fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
}

/** The bridge's counts as the API says they should be: crew, watched, needs you, at your helm. */
async function expectedCounts() {
  const ws = (await call<any[]>("GET", "/api/workers")).body.filter((w) => w.owner?.tier !== "control");
  return {
    crew: ws.filter((w) => w.owner?.tier === "crew").length,
    watched: ws.filter((w) => (w.owner?.tier ?? "watched") === "watched").length,
    "needs-you": (await call<any>("GET", "/api/asks?needs_you=1")).body.asks.length,
    "your-helm": ws.filter((w) => w.helm?.by === "captain").length,
  };
}

async function expectBridge(page: Page) {
  const bridge = page.getByTestId("firstmate-node").locator('[data-fm="fleet"]');
  await expect(async () => {
    const want = await expectedCounts();
    for (const [k, n] of Object.entries(want)) {
      if (k === "needs-you" && n === 0) await expect(bridge.locator(`[data-count="${k}"]`)).toHaveCount(0);
      else await expect(bridge.locator(`[data-count="${k}"]`)).toHaveAttribute("data-n", String(n), { timeout: 500 });
    }
  }).toPass({ timeout: 10000 });
  return bridge;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedWorld();
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), "csv-export");
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
  const wt = (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.worktree;
  const st = await herdr("fake.state");
  // The ship task is csv-export's: its crewmate sits in that mission. The done task has no mission: its
  // crewmate sits in its task's card, which waits beside the hub in "Not in an idea yet" (CP3a).
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees" });
  }
  if (!st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.done)) {
    await herdr("fake.add_pane", { workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.done, cwd: "/tmp/joyride-fixture-repos/beta", agent: "claude", agent_status: "working", title: "Sync crewmate", label: "beta-worktrees" });
  }
  // The captain's own session in another project, steered by the captain in the pane itself.
  captainPane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: CAPTAIN, label: "gamma" })).pane.pane_id;
  appendHookEvents([
    { type: "session.start", data: {}, agoMs: 4 * 60e3 },
    { type: "prompt.submit", data: { prompt: "Rewrite the export section of the user guide" }, agoMs: 3 * 60e3 },
  ]);
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === captain())?.helm?.by === "captain", 10000);
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.id === SYNC && w.owner?.tier === "crew"));
});

test.afterAll(async () => {
  for (const pane_id of [captainPane, ...Object.values(FIXTURE_CREW_PANES)]) if (pane_id) await herdr("fake.close_pane", { pane_id }).catch(() => {});
});

test("the home map: owner and helm chips on every card, the Firstmate bridge, and unfiled work by project", async ({ page }) => {
  await page.goto("/");
  const vp = page.locator(".map-viewport");
  const node = page.getByTestId("firstmate-node");
  await expect(node).toBeVisible();
  await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();

  // The bridge: crew, watched, needing you and at your helm, as the API counts them. No crew list.
  const bridge = await expectBridge(page);
  await expect(bridge.locator(".fb-all")).toHaveText("Fleet");
  await expect(bridge.locator('[data-count="your-helm"]')).not.toHaveAttribute("data-n", "0");
  await expect(bridge.locator('[data-count="needs-you"]')).toHaveClass(/signal-text/);
  await expect(node.locator(".fm-crew")).toHaveCount(0);
  await shot(page, "fleet-p1", "map-home");

  // No Unsorted, and no crew-outside-missions bucket: unfiled work is grouped by project.
  await expect(page.locator(".region-label .rl-title", { hasText: "Unsorted" })).toHaveCount(0);
  const gamma = page.locator('.region-label[data-region="unfiled:gamma"]');
  await expect(gamma.locator(".rl-kicker")).toHaveText("Unfiled");
  await expect(gamma.locator(".rl-title")).toHaveText("gamma");

  // The captain's session sits in its project's group. A crewmate is never loose: the crewmate of the
  // done task, which no idea names, sits inside its task's card beside the hub, never unfiled under beta.
  const mine = page.locator(`[data-worker="${captain()}"]`);
  await expect(mine).toHaveAttribute("data-region", "unfiled:gamma");
  await expect(page.locator('.region-label[data-region="unfiled:beta"]')).toHaveCount(0);
  const orphans = page.locator("[data-orphans]");
  await expect(orphans.locator(".mn-summary")).toHaveText("1 task");

  // Mid: each unfiled card has an owner chip and a helm chip in its own row.
  await mine.locator(".wn-link").focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  await expect(orphans.locator(`.task-row[data-task="${T.done}"]`)).toBeVisible();
  await expect(mine.locator('.wn-chips [data-owner="watched"]')).toHaveText("Watched");
  const helm = mine.locator('.wn-chips [data-helm="captain"]');
  await expect(helm).toHaveText("Helm: you");
  await expect(helm).toHaveAttribute("title", /You steered it in its pane at .*you hold the helm until its turn ends, plus 15 quiet minutes/);
  for (const card of await page.locator(".worker-node[data-worker], .orphans-node [data-worker]").all()) {
    await expect(card.locator("[data-owner]")).toHaveCount(1);
    await expect(card.locator("[data-helm]")).toHaveCount(1);
  }
  await expect(mine).toBeInViewport();
  await shot(page, "fleet-p1", "map-unfiled-by-project");

  // Near, on the mission opened in full: its worker lines carry the same chips, crew and watched side by side.
  // (Unopened, an idea's lines say only who is working on what.)
  const mission = page.locator('[data-mission="csv-export"]');
  await mission.locator(".mn-title").focus();
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "near");
  await expect(mission.locator(".mn-sec .wl [data-owner]")).toHaveCount(0);
  await openIdea(page, "csv-export");
  const crewLine = mission.locator(`.wl:has(a[href$="${encodeURIComponent(SHIP)}"])`);
  await expect(crewLine.locator('.wl-chips [data-owner="crew"]')).toHaveText(`Crew${T.ship}`);
  await expect(crewLine.locator('.wl-chips [data-helm]')).toHaveText("Helm: Firstmate");
  const lines = mission.locator(".mn-workers .wl");
  for (const line of await lines.all()) await expect(line.locator("[data-owner]")).toHaveCount(1);
  await expect(mission.locator('.mn-workers [data-owner="watched"]').first()).toBeAttached();
  // The idea's island is taller than the screen at Near now that task cards carry their asks: focusing the
  // line pans the chart to it.
  await crewLine.locator("a").first().focus();
  await expect(crewLine).toBeInViewport();
  await shot(page, "fleet-p1", "map-mission-chips");

  // The bridge up close, at Near.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-crumbs")).toHaveCount(0);
  await node.getByRole("button", { name: "Start Firstmate" }).focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  await node.getByRole("button", { name: "Start Firstmate" }).focus();
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(bridge).toBeInViewport({ ratio: 1 });
  await shot(page, "fleet-p1", "map-firstmate-bridge");

  // Near, beside the hub: the done task's card holds its crewmate's line, with the same chips.
  const sync = orphans.locator(`.task-card[data-task="${T.done}"] [data-worker="${SYNC}"]`);
  await expect(sync.locator('.wl-chips [data-owner="crew"]')).toHaveText(`Crew${T.done}`);
  await expect(sync.locator('.wl-chips [data-owner="crew"]')).toHaveAttribute("title", `Firstmate crew on task ${T.done}. Firstmate launched it and owns its lifecycle.`);
  await expect(sync.locator('.wl-chips [data-helm="firstmate"]')).toHaveText("Helm: Firstmate");
});

test("the bridge opens the Agents page on each count, with open and steer", async ({ page }) => {
  await page.goto("/");
  const bridge = await expectBridge(page);
  const want = await expectedCounts();
  const a = page.getByTestId("agents-page");
  const rowOf = async (w: any) => (w.owner?.tier === "crew" && w.crew ? a.locator(`[data-agent="t:${w.crew}"] [data-crewmate="${w.id}"]`) : a.locator(`[data-agent="w:${w.id}"]`));

  if (want["needs-you"]) {
    await bridge.locator('[data-count="needs-you"]').click();
    await expect(page.locator('[data-rail="attention"]')).toBeFocused();
    await expect(page.locator('[data-rail="attention"] [data-needs-you]')).toHaveCount(want["needs-you"]);
  }

  // Crew: the crewmate outside missions sits on its task's row, in its project under "Not in an idea yet";
  // the ship task's crewmate sits in the CSV idea.
  await page.goto("/");
  await (await expectBridge(page)).locator('[data-count="crew"]').click();
  await expect(page).toHaveURL(/#\/agents\?owner=crew$/);
  const syncTask = a.locator(`[data-group="unfiled"] [data-idea="project:beta"] [data-agent="t:${T.done}"]`);
  await expect(syncTask.locator(`[data-crewmate="${SYNC}"]`)).toBeVisible();
  await expect(syncTask.locator(`[data-crewmate="${SYNC}"] [data-helm="firstmate"]`)).toHaveText("Helm: Firstmate");
  await expect(a.locator(`[data-idea="csv-export"] [data-agent="t:${T.ship}"] [data-crewmate="${SHIP}"]`)).toBeVisible();
  await expect(a.locator('[data-agent][data-owner="yours"]')).toHaveCount(0);

  // Watched: the captain's own session, with its chips, in its project.
  await page.goto("/");
  await (await expectBridge(page)).locator('[data-count="watched"]').click();
  await expect(page).toHaveURL(/#\/agents\?owner=yours$/);
  const mine = a.locator(`[data-group="unfiled"] [data-idea="project:gamma"] [data-agent="w:${captain()}"]`);
  await expect(mine.locator('[data-owner="watched"]')).toHaveText("Watched");
  await expect(mine.locator('[data-helm="captain"]')).toHaveText("Helm: you");
  await expect(mine.locator(".ag-sub")).toContainText("gamma");
  await shot(page, "fleet-p1", "fleet-table", { fullPage: true });

  // At your helm.
  await page.goto("/");
  await (await expectBridge(page)).locator('[data-count="your-helm"]').click();
  await expect(page).toHaveURL(/#\/agents\?show=your-helm$/);
  await expect(mine).toBeVisible();

  // Steer the crewmate outside missions as the captain: the reply reaches its pane and the captain takes its helm.
  await page.goto("/#/agents?owner=crew");
  const sync = syncTask.locator(`[data-crewmate="${SYNC}"]`);
  await sync.getByRole("button", { name: "Steer" }).click();
  const box = sync.getByRole("textbox");
  await expect(box).toBeFocused();
  await box.fill("Hold off on the merge until I check the retry test");
  await box.press("Enter");
  await expect.poll(async () => (await herdr("fake.state")).prompts.some((p: any) => p.target === FIXTURE_CREW_PANES.done && String(p.text).includes("Hold off on the merge")), { timeout: 10000 }).toBe(true);
  await expect(sync.locator('[data-helm="captain"]')).toHaveText("Helm: you", { timeout: 10000 });
  await shot(page, "fleet-p1", "fleet-steer-takes-helm");

  // Open: the crewmate's worker pane, with the same chips in its header.
  await sync.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(SYNC)}$`));
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.locator(".mp-crumbs")).toHaveText(/Map\s*\/\s*Unfiled\s*\/\s*Worker/);
  await expect(sheet.locator('.wp-status [data-owner="crew"]')).toBeVisible();
  await expect(sheet.locator('.wp-status [data-helm="captain"]')).toHaveText("Helm: you");

  // Back on the home map the bridge counts the new helm too.
  await page.goto("/");
  await expect(page.getByTestId("firstmate-node").locator('[data-count="your-helm"]')).toHaveAttribute("data-n", String(want["your-helm"] + 1), { timeout: 10000 });
});
