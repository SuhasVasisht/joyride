// The map as a sorting table: open Firstmate from its node, drag a session between groups and see
// the move survive a reload, start a group by dropping a mission and undo it, and open an artifact
// from its chip. Runs against the sandbox daemon, a fixture FM_HOME and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome } from "./crew-fixture";
import { call, herdr, PORT, seedWorld, waitUntil } from "./map-seed";
import { stopFixtureFirstmate } from "./fixture-cleanup";
import { panTo } from "./chart-pan";

const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8")) as Record<string, string>;
const DRILL = "Sorting drill";
let control: string | null = null;
let drill: string | null = null;
let key = "";
let sessionArtifact = "";
let missionArtifact = "";

test.describe.configure({ mode: "serial" });

/** Press on `from`, carry it in small steps (so the map sees a drag, not a click) and let go over `to`. */
async function carry(page: Page, from: Locator, to: Locator | { x: number; y: number }, opts: { release?: boolean } = {}) {
  const a = (await from.boundingBox())!;
  const b = "x" in to ? { x: to.x, y: to.y, width: 0, height: 0 } : (await to.boundingBox())!;
  await page.mouse.move(a.x + Math.min(a.width / 2, 60), a.y + Math.min(a.height / 2, 12));
  await page.mouse.down();
  const tx = b.x + b.width / 2, ty = b.y + Math.min(b.height / 2, 30);
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + 60 + ((tx - a.x - 60) * i) / 12, a.y + 12 + ((ty - a.y - 12) * i) / 12);
  if (opts.release !== false) await page.mouse.up();
}

test.beforeAll(async () => {
  await stopFixtureFirstmate();
  await seedWorld();
  buildFirstmateHome(path.join(env.JOYRIDE_RUNTIME, "firstmate"), "csv-export");
  await waitUntil(async () => (await call("GET", "/api/firstmate/tasks")).body.length === 4);
  // A live worker on a session that belongs to no mission: it sits unfiled under gamma, ready to be sorted.
  const st = await herdr("fake.state");
  const have = st.panes.find((p: any) => p.title === DRILL);
  const live = new Set((await call<any[]>("GET", "/api/workers")).body.filter((w) => w.title !== DRILL).map((w) => w.session));
  const free = (await call<any[]>("GET", "/api/sessions?mission=none&limit=200")).body.find((s) => s.source === "claude" && !s.cwd.includes(".joyride") && !live.has(s.key));
  expect(free, "a fixture session outside every mission").toBeTruthy();
  key = free.key;
  drill = have?.pane_id ?? (await herdr("fake.add_pane", {
    cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: DRILL, label: "gamma",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: free.id },
  })).pane.pane_id;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.session === key));
  // Artifacts linked to the session and to a mission: the map shows them as chips.
  const a1 = await call("POST", "/api/artifacts", { url: "https://claude.ai/artifact/5e7f0a10-1d2c-4e3b-9a8f-000000000001", title: "Sorting notes", session: key });
  const a2 = await call("POST", "/api/artifacts", { url: "https://github.com/acme/alpha/pull/42", title: "CSV export PR", mission: "csv-export" });
  expect([200, 201]).toContain(a1.status);
  expect([200, 201]).toContain(a2.status);
  sessionArtifact = a1.body.id;
  missionArtifact = a2.body.id;
});

test.afterAll(async () => {
  if (control) await herdr("fake.close_pane", { pane_id: control }).catch(() => {});
  if (drill) await herdr("fake.close_pane", { pane_id: drill }).catch(() => {});
  // Leave the session where the spec found it, for later specs in the run.
  if (key) await call("POST", "/api/missions/move", { session: key, to: { mission: null } }).catch(() => {});
});

test("the Firstmate node is a live badge with a crew ticker, and one click opens its control session", async ({ page }) => {
  await page.route("**/api/firstmate/start", async (route) => {
    const r = await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "idle", name: "firstmate", title: "First-time setup", label: "firstmate" });
    control = r.pane.pane_id;
    await route.fulfill({ json: { id: "fixture-start", status: "acked", error: null, result: { started: true } } });
  });
  await page.goto("/");
  const vp = page.locator(".map-viewport");
  const node = page.getByTestId("firstmate-node");
  await expect(node).toBeVisible();
  await node.getByRole("button", { name: "Start Firstmate" }).focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  await expect(node.locator(".fm-avatar")).toBeVisible();
  await node.getByRole("button", { name: "Start Firstmate" }).click();
  await expect(node).toHaveAttribute("data-firstmate", "running", { timeout: 15000 });
  await herdr("fake.set_status", { pane_id: control, status: "working" });
  await expect(node).toHaveClass(/s-working/);
  await expect(node.locator(".fm-state")).toHaveText("Working");
  // Status, moving count and captain calls stay; the ticker walks the moving tasks.
  await expect(node.locator('[data-fm="in-flight"]')).toHaveText("2 tasks moving");
  const needsYou = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
  await expect(node.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(needsYou));
  await expect(node.locator('[data-fm="ticker"]')).toContainText(/CSV export|flakes/);
  await expect(node.locator(".fm-tick-n")).toHaveText(/^[12]\/2$/);
  // The wheel turns while Firstmate works.
  expect(await node.locator(".fm-turn").evaluate((el) => getComputedStyle(el).animationName)).toBe("fm-turn");
  await shot(page, "C2", "regroup-firstmate-mid");

  await node.locator(".fm-line").click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(`local:${control}`)}$`));
  await expect(page.getByRole("dialog", { name: /Worker/ }).getByRole("heading", { level: 1 })).toContainText("First-time setup");
});

test("default and Far zoom: the badge and groups stay readable; artifacts appear at Mid", async ({ page }) => {
  await page.goto("/");
  const vp = page.locator(".map-viewport");
  const node = page.getByTestId("firstmate-node");
  await expect(node).toBeInViewport();
  await expect(node.locator(".fm-title")).toBeVisible();
  await shot(page, "C2", "regroup-default");
  await node.locator(".fm-title").focus();
  await page.getByRole("radio", { name: "Far" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "far");
  await expect(node).toBeInViewport();
  await expect(node.locator(".fm-avatar")).toBeVisible();
  await expect(node.locator('[data-fm="in-flight"]')).toHaveText("2 moving");
  const needsYou = (await call("GET", "/api/asks?needs_you=1")).body.asks.length;
  await expect(node.locator('[data-count="needs-you"]')).toHaveAttribute("data-n", String(needsYou));
  // Far says what is live in the idea; its artifacts wait for Mid.
  await expect(page.locator('[data-mission="csv-export"] .mn-summary')).toHaveAttribute("data-glance", "live");
  await expect(page.locator(".map-plane .art-chips")).toHaveCount(0);
  await shot(page, "C2", "regroup-far");
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator(`[data-worker] [data-artifact="${sessionArtifact}"]`).first()).toBeAttached();
  // Off camera a card keeps only its glance line, so bring the idea into view first.
  await panTo(page.locator('[data-mission="csv-export"] .mn-head'));
  await expect(page.locator(`[data-mission="csv-export"] [data-artifact="${missionArtifact}"]`)).toBeVisible();
});

test("an artifact chip on a session card opens the artifact", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`[data-worker][data-drag="s:${key}"]`);
  // Focused first, so the zoom keeps the card on screen however much earlier specs charted.
  await card.locator(".wn-link").focus();
  await page.getByRole("radio", { name: "Mid" }).click();
  const chip = card.locator(`[data-artifact="${sessionArtifact}"]`);
  await expect(chip).toHaveText(/Sorting notes/);
  await chip.click();
  // #/artifacts/<id> redirects to the knowledge home with the artifact's sheet open.
  await expect(page).toHaveURL(new RegExp(`#/knowledge\\?.*open=artifact%3A${sessionArtifact}$`));
  await expect(page.getByTestId("knowledge-sheet").getByTestId("artifact-detail")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sorting notes" })).toBeVisible();
});

test("drag an unfiled session onto a mission in another group; the move survives a reload", async ({ page }) => {
  await page.goto("/");
  const vp = page.locator(".map-viewport");
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  await page.keyboard.press("0"); // fit, so every group is on screen
  const card = page.locator(`[data-worker][data-drag="s:${key}"]`);
  const target = page.locator('[data-mission="oauth-login"]');
  await expect(card).toBeVisible();
  await expect(target).toBeVisible();
  // Let the chart finish laying out (measurements land once the camera stops) before pressing on the card.
  await expect.poll(async () => { const a = await card.boundingBox(); await page.waitForTimeout(150); const b = await card.boundingBox(); return JSON.stringify(a) === JSON.stringify(b); }).toBe(true);

  await carry(page, card, target, { release: false });
  // While carrying: a ghost, a hint, and the mission under the pointer lit as the drop target.
  await expect(page.locator(".carry-ghost")).toContainText(DRILL);
  await expect(page.locator(".drop-dock .dd-hint")).toContainText("Drop on an idea");
  await expect(target).toHaveClass(/drop-hover/);
  await expect(page.locator('[data-mission="csv-export"]')).toHaveClass(/drop-ok/);
  await expect(page.locator(".carry-ghost .cg-target")).toHaveText("Move to OAuth login flow");
  await shot(page, "C2", "regroup-carrying-session");
  await page.mouse.up();

  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText("Moved the session to OAuth login flow.");
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.locator(`.worker-node[data-drag="s:${key}"]`)).toHaveCount(0); // the unfiled card; its line in the mission stays
  // At Near the session hangs off its new mission as a worker line, and its artifact comes along.
  await target.locator(".mn-title").focus();
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "near");
  const line = page.locator(`[data-mission="oauth-login"] [data-drag="s:${key}"]`);
  await expect(line).toBeVisible();
  await expect(target.locator(`.mn-detail > .mn-foot > .art-chips [data-artifact="${sessionArtifact}"]`)).toBeVisible();
  await shot(page, "C2", "regroup-session-moved");

  await page.reload();
  await expect(page.locator('[data-mission="oauth-login"]')).toBeVisible();
  await expect(page.locator(`.worker-node[data-drag="s:${key}"]`)).toHaveCount(0); // the unfiled card; its line in the mission stays
  await page.locator('[data-mission="oauth-login"] .mn-title').focus();
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(line).toBeVisible();
  const m = (await call("GET", "/api/missions/oauth-login")).body;
  expect(m.sessions.map((r: any) => `${r.source}:${r.id}`)).toContain(key);
  const log = (await call<any[]>("GET", "/api/artifacts")).body; // the registry sees the new mission through the session
  expect(log.find((a) => a.id === sessionArtifact)?.mission).toBe("oauth-login");

  // And back out to Unfiled from the mission card.
  await panTo(line);
  await carry(page, line, { x: 720, y: 450 }, { release: false });
  const zone = page.locator('[data-drop-zone="unfiled"]');
  await expect(zone).toBeVisible();
  const zb = (await zone.boundingBox())!;
  await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2, { steps: 4 });
  await expect(zone).toHaveClass(/drop-hover/);
  await page.mouse.up();
  await expect(page.getByTestId("map-toast")).toContainText("to Unfiled");
  await expect(page.locator(`[data-worker][data-drag="s:${key}"]`)).toBeVisible();
});

test("drop a mission on New group, name it, and undo the move", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("radio", { name: "Mid" }).click();
  await page.keyboard.press("0");
  const csv = page.locator('[data-mission="csv-export"]');
  await expect(page.locator(".region-label .rl-title", { hasText: "Reporting" })).toBeVisible();
  await expect(csv).toHaveClass(/can-drag/);

  await carry(page, csv.locator(".mn-head .health-mark"), { x: 720, y: 500 }, { release: false });
  await expect(page.locator(".drop-dock .dd-hint")).toContainText("Drop on a group");
  const zone = page.locator('[data-drop-zone="new-group"]');
  const zb = (await zone.boundingBox())!;
  await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2, { steps: 5 });
  await expect(zone).toHaveClass(/drop-hover/);
  await shot(page, "C2", "regroup-carrying-mission");
  await page.mouse.up();

  const dialog = page.getByRole("dialog", { name: "Name the new group" });
  await dialog.getByLabel("Group name").fill("Exports");
  await dialog.getByRole("button", { name: "Create group" }).click();
  const toast = page.getByTestId("map-toast");
  await expect(toast).toContainText("Moved CSV export for the report page to the new group Exports.");
  await expect(page.locator('.region-label[data-region="lens:exports"]')).toBeVisible();
  await expect(page.locator('.region-label[data-region="lens:exports"] .rl-title')).toHaveText("Exports");
  await shot(page, "C2", "regroup-new-group");

  // Undo puts it back in Reporting and removes the group it started.
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("map-toast")).toContainText("Move undone.");
  await expect(page.locator('.region-label[data-region="lens:exports"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();
  await expect(page.locator('.region-label[data-region="lens:reporting"]')).toBeVisible();
  await expect(page.locator('.region-label[data-region="lens:exports"]')).toHaveCount(0);
  expect((await call<any[]>("GET", "/api/lenses")).body.map((l) => l.id)).not.toContain("exports");
  expect((await call("GET", "/api/missions/csv-export")).body.lenses).toEqual([]);
});
