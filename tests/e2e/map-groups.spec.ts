// Making groups on the map, from the captain's side: New group from the strip (named in place), dragging
// an idea and a session into it, renaming a group and an Unfiled box in place (the box becomes a group that
// keeps what it held), merging and deleting with Undo, and Unfiled work that can be acted on in place: open
// it, file it, accept the suggested idea, or set it aside so the box leaves the chart.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { shot } from "./shot";
import { call, herdr, seedWorld, waitUntil } from "./map-seed";
import { panTo } from "./chart-pan";

const CP = "jr-groups-custom";
const IDEA = "csv-export", IDEA_TITLE = "CSV export for the report page";
const DRILL = "Group drill";
let drill: string | null = null;
let key = "";
let suggestion: { id: string; title: string } | null = null;

test.describe.configure({ mode: "serial" });

const lenses = async () => (await call<any[]>("GET", "/api/lenses")).body;
const lensNamed = async (title: string) => (await lenses()).find((l) => l.title === title);
const lensesOf = async (id: string) => (await call("GET", `/api/missions/${id}`)).body.lenses as string[];
const region = (page: Page, id: string) => page.locator(`.region-label[data-region="${id}"]`);
const toast = (page: Page) => page.getByTestId("map-toast");
const card = (page: Page) => page.locator(`[data-worker][data-drag="s:${key}"]`);

async function openMap(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(`[data-mission="${IDEA}"]`)).toBeVisible();
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", "mid");
}

/** Bring a node to the middle of the chart. */
async function onScreen(l: Locator) {
  await panTo(l);
}

/** Wait until the chart stops re-laying itself out around `l` (it refits as live data arrives). */
async function settle(l: Locator) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const b = await l.boundingBox();
    const now = b ? `${Math.round(b.x)},${Math.round(b.y)}` : "";
    if (now && now === last) return;
    last = now;
    await l.page().waitForTimeout(150);
  }
}

async function carryTo(page: Page, from: Locator, to: Locator) {
  await settle(from);
  await settle(to);
  const a = (await from.boundingBox())!;
  const ax = a.x + Math.min(a.width / 2, 40), ay = a.y + Math.min(a.height / 2, 10);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(ax + 12, ay + 8, { steps: 3 });
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + Math.min(b.width / 2, 120), b.y + Math.min(b.height / 2, 14), { steps: 14 });
}

async function renameRegion(page: Page, id: string, from: string, to: string) {
  const label = region(page, id);
  await onScreen(label);
  // A group's name opens it; renaming is in its menu (or a double-click on the name).
  await label.hover();
  await label.getByRole("button", { name: `More for ${from}` }).click();
  await page.getByTestId("group-menu").getByRole("menuitem", { name: /^(Rename|Name this group…)$/ }).click();
  const input = label.getByRole("textbox");
  await expect(input).toBeFocused();
  await input.fill(to);
  await input.press("Enter");
}

test.beforeAll(async () => {
  await seedWorld();
  // A live worker on a session outside every idea sits unfiled under gamma. When a pending suggestion
  // (proposal) holds a free session, use that one, so its card offers the suggested idea.
  const live = new Set((await call<any[]>("GET", "/api/workers")).body.map((w) => w.session));
  const free = (await call<any[]>("GET", "/api/sessions?mission=none&limit=200")).body.filter((s) => s.source === "claude" && !s.cwd.includes(".joyride") && !live.has(s.key));
  expect(free.length, "a fixture session outside every idea").toBeGreaterThan(0);
  const props = (await call<any[]>("GET", "/api/missions/proposals")).body;
  const inProposal = free.find((s) => props.some((p) => p.sessions.some((r: any) => r.id === s.id)));
  const pick = inProposal ?? free[0];
  key = pick.key;
  const p = props.find((x) => x.sessions.some((r: any) => r.id === pick.id));
  suggestion = p ? { id: p.id, title: p.title } : null;
  drill = (await herdr("fake.add_pane", {
    cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: DRILL, label: "gamma",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: pick.id },
  })).pane.pane_id;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.session === key));
});

test.afterAll(async () => {
  if (drill) await herdr("fake.close_pane", { pane_id: drill }).catch(() => {});
  if (key) await call("POST", "/api/missions/move", { session: key, to: { mission: null } }).catch(() => {});
  if (key) await call("POST", "/api/missions/unhide", { key }).catch(() => {});
  for (const l of await lenses()) if (l.id !== "reporting") await call("POST", "/api/lenses/delete", { lens: l.id }).catch(() => {});
  // The seed's grouping, exactly: Reporting lists the idea, and the idea names no group itself.
  if ((await lensesOf(IDEA)).length) await call("PUT", `/api/missions/${IDEA}`, { lenses: [] }).catch(() => {});
  await seedWorld();
});

test("New group from the strip, named in place, then an idea and a session dragged into it", async ({ page }) => {
  await openMap(page);
  await page.getByRole("button", { name: "New group" }).click();
  const name = page.getByRole("textbox", { name: "New group name" });
  await expect(name).toBeFocused();
  await name.fill("Q4 bets");
  await shot(page, CP, "create-naming");
  await name.press("Enter");
  await expect(toast(page)).toContainText("Started the group Q4 bets");
  const q4 = region(page, "lens:q4-bets");
  await expect(q4).toBeVisible();
  await expect(page.locator(`.empty-group[data-region="lens:q4-bets"]`)).toContainText("No ideas or sessions here yet");
  await shot(page, CP, "create-empty-group");

  // An idea, dragged by its card onto the new group.
  const idea = page.locator(`[data-mission="${IDEA}"]`);
  await page.locator(".map-viewport").focus();
  await page.keyboard.press("0");
  await carryTo(page, idea.locator(".mn-head"), q4);
  await expect(q4).toHaveAttribute("data-drop-label", "Move to Q4 bets");
  await shot(page, CP, "drag-idea-into-group");
  await page.mouse.up();
  await expect(toast(page)).toContainText(`Moved ${IDEA_TITLE} to Q4 bets.`);
  await waitUntil(async () => (await lensesOf(IDEA))[0] === "q4-bets");

  // A session, dragged from its Unfiled box onto the group: it sits in the group directly.
  // Fit everything, so neither end of the drag sits at the chart's edge (where the chart drifts).
  await page.locator(".map-viewport").focus();
  await page.keyboard.press("0");
  const w = card(page);
  await carryTo(page, w, region(page, "lens:q4-bets"));
  await expect(page.locator(".carry-ghost .cg-target")).toHaveText("Move to Q4 bets");
  await page.mouse.up();
  await expect(toast(page)).toContainText("Moved the session to Q4 bets.");
  await waitUntil(async () => (await lensNamed("Q4 bets"))?.sessions.includes(key));
  await expect(card(page)).toHaveAttribute("data-region", "lens:q4-bets");
  await onScreen(region(page, "lens:q4-bets"));
  await shot(page, CP, "group-with-idea-and-session");
});

test("rename a group in place, with Undo", async ({ page }) => {
  await openMap(page);
  await renameRegion(page, "lens:q4-bets", "Q4 bets", "Q4 big bets");
  await expect(toast(page)).toContainText("Renamed Q4 bets to Q4 big bets.");
  await expect(region(page, "lens:q4-bets").locator(".rl-title")).toHaveText("Q4 big bets");
  await shot(page, CP, "rename-group");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Move undone.");
  await expect(region(page, "lens:q4-bets").locator(".rl-title")).toHaveText("Q4 bets");
});

test("rename an Unfiled box: it becomes a group that keeps what it held", async ({ page }) => {
  // Back to Unfiled first: the session leaves the group.
  expect((await call("POST", "/api/missions/move", { session: key, to: { mission: null } })).status).toBe(200);
  await openMap(page);
  const box = region(page, "unfiled:gamma");
  await expect(box).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-region", "unfiled:gamma");
  await onScreen(box);
  await shot(page, CP, "rename-unfiled-before");
  await renameRegion(page, "unfiled:gamma", "gamma", "Gamma scratch");
  await expect(toast(page)).toContainText("Unfiled is now the group Gamma scratch, with everything it held.");
  const g = await lensNamed("Gamma scratch");
  expect(g?.projects).toEqual(["gamma"]);
  await expect(region(page, "unfiled:gamma")).toHaveCount(0);
  await expect(card(page)).toHaveAttribute("data-region", `lens:${g.id}`);
  await onScreen(region(page, `lens:${g.id}`));
  await shot(page, CP, "rename-unfiled-after");
});

test("delete a group with Undo: its members go back to where they were", async ({ page }) => {
  const g = await lensNamed("Gamma scratch");
  await openMap(page);
  const label = region(page, `lens:${g.id}`);
  await onScreen(label);
  await label.getByRole("button", { name: "More for Gamma scratch" }).click();
  await expect(page.getByTestId("group-menu")).toBeVisible();
  await shot(page, CP, "delete-menu");
  await page.getByTestId("group-menu").getByRole("menuitem", { name: "Delete group" }).click();
  await expect(toast(page)).toContainText("Deleted the group Gamma scratch.");
  await expect(card(page)).toHaveAttribute("data-region", "unfiled:gamma");
  await shot(page, CP, "delete-after");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Move undone.");
  await expect(card(page)).toHaveAttribute("data-region", `lens:${g.id}`);
  await shot(page, CP, "delete-undone");
});

test("merge a group into another with Undo: its ideas, sessions and projects all join it", async ({ page }) => {
  const g = await lensNamed("Gamma scratch");
  await openMap(page);
  const label = region(page, "lens:q4-bets");
  await onScreen(label);
  await label.getByRole("button", { name: "More for Q4 bets" }).click();
  await page.getByTestId("group-menu").getByRole("menuitem", { name: "Merge into…" }).click();
  await shot(page, CP, "merge-menu");
  await page.getByRole("menuitem", { name: "Gamma scratch" }).click();
  await expect(toast(page)).toContainText("Merged Q4 bets into Gamma scratch.");
  await expect(region(page, "lens:q4-bets")).toHaveCount(0);
  await waitUntil(async () => (await lensesOf(IDEA))[0] === g.id);
  await expect(page.locator(`[data-mission="${IDEA}"]`)).toBeVisible();
  await onScreen(region(page, `lens:${g.id}`));
  await shot(page, CP, "merge-after");
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Move undone.");
  await expect(region(page, "lens:q4-bets")).toBeVisible();
  await waitUntil(async () => (await lensesOf(IDEA))[0] === "q4-bets");
});

test("Unfiled work is actionable in place, and set aside it leaves the chart (the box with it)", async ({ page }) => {
  // Out of the group again, so the card sits in an Unfiled box.
  const g = await lensNamed("Gamma scratch");
  expect((await call("POST", "/api/lenses/delete", { lens: g.id })).status).toBe(200);
  await openMap(page);
  const w = card(page);
  await expect(w).toHaveAttribute("data-region", "unfiled:gamma");
  await onScreen(w);
  await expect(w.getByRole("link", { name: "Open" })).toHaveAttribute("href", /#\/worker\//);
  await expect(w.getByRole("button", { name: /^File .* in an idea or group$/ })).toBeVisible();
  if (suggestion) await expect(w.locator(".wn-suggest")).toContainText(suggestion.title);
  await shot(page, CP, "unfiled-actions");

  // File in… opens Move to, with groups and New group as well as ideas.
  const fileButton = w.getByRole("button", { name: /^File .* in an idea or group$/ });
  await panTo(fileButton);
  const point = (await fileButton.boundingBox())!;
  await page.mouse.click(point.x + point.width / 2, point.y + point.height / 2);
  const menu = page.getByTestId("move-menu");
  await expect(menu.getByRole("button", { name: "Move to Q4 bets" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "New group…" })).toBeVisible();
  await page.keyboard.press("Escape");

  if (suggestion) {
    await w.locator(".wn-suggest").getByRole("button", { name: "Accept" }).click();
    await expect(toast(page)).toContainText("Filed into");
    await expect(region(page, "unfiled:gamma")).toHaveCount(0);
    await shot(page, CP, "unfiled-accepted");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(card(page)).toHaveAttribute("data-region", "unfiled:gamma");
  }

  await shot(page, CP, "unfiled-before-set-aside");
  await card(page).getByRole("button", { name: "Set aside" }).click();
  await expect(toast(page)).toContainText("Set aside.");
  await expect(card(page)).toHaveCount(0);
  await expect(region(page, "unfiled:gamma")).toHaveCount(0);
  await shot(page, CP, "unfiled-after-set-aside");
  // Still reachable from the Agents page.
  expect((await call<any[]>("GET", "/api/workers")).body.some((x) => x.session === key)).toBe(true);
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(card(page)).toHaveAttribute("data-region", "unfiled:gamma");
});

test("dropped ideas leave the chart and come back under Show archive", async ({ page }) => {
  expect((await call("PUT", "/api/missions/oauth-login/state", { state: "dropped", reason: "e2e: not doing it" })).status).toBe(200);
  try {
    await openMap(page);
    await expect(page.locator(`[data-mission="oauth-login"]`)).toHaveCount(0);
    await page.getByText(/^Show archive/).click();
    await expect(page.locator(`[data-mission="oauth-login"]`)).toBeVisible();
    await page.getByText(/^Show archive/).click();
  } finally {
    await call("PUT", "/api/missions/oauth-login/state", { state: "open", reason: "e2e: restore" });
  }
});
