// The Agents page (#/agents) replaces Proposals, Fleet, Crew and Views: every agent and session in the
// map's groups and ideas, with "Not in an idea yet" by project; filters for needs you, your helm, crew
// or yours and running, idle or done; every old action on the row; and
// the old routes redirecting to the matching filter. Runs against the sandbox daemon, a fixture
// FM_HOME and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, PORT, seedWorld, waitUntil, W } from "./map-seed";

const sandbox = `/tmp/joyride-e2e-${PORT}`;
const env = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8")) as Record<string, string>;
const CK = "agents";
const CAPTAIN_SESSION = "a6e7a000-0000-4000-8000-000000000001";
const SHIP = `local:${FIXTURE_CREW_PANES.ship}`;
const SYNC = `local:${FIXTURE_CREW_PANES.done}`;
const REPO = "/tmp/joyride-fixture-repos/epsilon-agents";
const S = { merge: "a6e7a001-0000-4000-8000-000000000001", fresh: "a6e7a002-0000-4000-8000-000000000002", drop: "a6e7a003-0000-4000-8000-000000000003" };
const PROPOSALS = { merge: "mp-agents-merge", fresh: "mp-agents-fresh", drop: "mp-agents-drop" };
const panes = { captain: "", prompt: "", idle: "" };
const id = (p: string) => `local:${p}`;
let workspaceYaml = "";

/** Hook events in the sandbox's event log, as the global hooks would write them from the captain's pane. */
function appendHookEvents(evs: { type: string; data: Record<string, unknown>; agoMs: number }[]) {
  const dir = path.join(env.JOYRIDE_RUNTIME, "events");
  if (!dir.startsWith(sandbox)) throw new Error("refusing: event log is not in the sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const lines = evs.map((e, i) => JSON.stringify({
    ts: new Date(Date.now() - e.agoMs).toISOString(), id: `ev_e2e_agents_${PORT}_${Date.now()}_${i}`, source: "hook.claude", type: e.type,
    session: CAPTAIN_SESSION, agent: "claude", cwd: "/tmp/joyride-fixture-repos/gamma", pane: panes.captain, data: e.data,
  }));
  fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
}

/** A short closed Claude Code session in the sandbox's transcripts, outside any idea. */
function transcript(sid: string, prompt: string, reply: string, minsAgo: number) {
  const ago = (m: number) => new Date(Date.now() - m * 60e3).toISOString();
  const base = (n: number, o: object) => JSON.stringify({ sessionId: sid, cwd: REPO, gitBranch: "main", isSidechain: false, uuid: `${sid}-${n}`, ...o });
  const dir = `${sandbox}/claude/projects/${REPO.replace(/[^A-Za-z0-9]/g, "-")}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), [
    base(0, { type: "user", timestamp: ago(minsAgo + 2), origin: { kind: "human" }, message: { role: "user", content: prompt } }),
    base(1, { type: "assistant", timestamp: ago(minsAgo), message: { id: `m-${sid}`, role: "assistant", content: [{ type: "text", text: reply }], usage: { input_tokens: 900, output_tokens: 200 } } }),
  ].join("\n") + "\n");
}

/** A pending idea proposal as backfill stores one (sandbox runtime only). */
function stageProposal(pid: string, title: string, sid: string, mergeInto: string | null) {
  const dir = `${sandbox}/runtime/proposals/missions`;
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  fs.writeFileSync(`${dir}/${pid}.json`, JSON.stringify({
    id: pid, title, goal: `${title}.`, repos: [REPO], branches: ["main"], sessions: [{ source: "claude", id: sid }],
    first_ts: t, last_ts: t, status: "pending", reason: "1 session in epsilon-agents on main", merge_into: mergeInto, created: t,
  }));
}

const agents = (page: Page) => page.getByTestId("agents-page");
const row = (page: Page, key: string) => agents(page).locator(`[data-agent="${key}"]`);
const filterLink = (page: Page, seg: string, f: string) => agents(page).locator(`[data-seg="${seg}"] [data-filter="${f}"]`);
const tabCount = async (page: Page, seg: string, f: string) => Number(await filterLink(page, seg, f).locator(".n").textContent());

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
  // The captain's own session, steered in its pane: the captain holds its helm.
  panes.captain = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "working", title: "Captain's docs pass", label: "gamma" })).pane.pane_id;
  appendHookEvents([{ type: "session.start", data: {}, agoMs: 4 * 60e3 }, { type: "prompt.submit", data: { prompt: "Rewrite the export section of the user guide" }, agoMs: 3 * 60e3 }]);
  // A watched session stuck at a permission prompt, and an idle one to save and close.
  panes.prompt = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "blocked", title: "Agents prompt pane", label: "gamma" })).pane.pane_id;
  await herdr("fake.set_menu", { pane_id: panes.prompt, status: "blocked" });
  panes.idle = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/gamma", agent: "claude", agent_status: "idle", title: "Agents idle pane", label: "gamma" })).pane.pane_id;
  await waitUntil(async () => (await call("GET", `/api/workers/${encodeURIComponent(id(panes.prompt))}`)).status === 200);
  await call("POST", "/api/attention", { level: "L3", kind: "approval", title: "Allow Bash in the agents prompt pane?", why: "Allow this tool", worker: id(panes.prompt) });
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === id(panes.captain))?.helm?.by === "captain", 10000);
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.id === SYNC && w.owner?.tier === "crew"));
  // Three closed sessions outside any idea, each with a suggestion.
  fs.mkdirSync(REPO, { recursive: true });
  if (!fs.existsSync(path.join(REPO, ".git"))) execFileSync("git", ["init", "-q", REPO]);
  transcript(S.merge, "Polish the CSV export column names", "Renamed the export columns.", 40);
  transcript(S.fresh, "Sketch a dark theme for the report page", "Drafted dark tokens for the report page.", 30);
  transcript(S.drop, "What time is it in Tokyo?", "It is evening in Tokyo.", 20);
  await call("POST", "/api/sessions/reindex");
  await waitUntil(async () => (await call<any[]>("GET", "/api/sessions?since=1d&limit=200")).body.filter((s) => Object.values(S).some((x) => s.key === `claude:${x}`)).length === 3, 15000);
  stageProposal(PROPOSALS.merge, "epsilon-agents: Polish the CSV export", S.merge, "csv-export");
  stageProposal(PROPOSALS.fresh, "Report page dark theme", S.fresh, null);
  stageProposal(PROPOSALS.drop, "Tokyo time", S.drop, null);
  workspaceYaml = fs.readFileSync(path.join(env.JOYRIDE_HOME, "workspace.yaml"), "utf8");
});

test.afterAll(async () => {
  if (createdIdea) await call("PUT", `/api/missions/${createdIdea}`, { archive: true });
  for (const pane_id of [...Object.values(panes), ...Object.values(FIXTURE_CREW_PANES)]) if (pane_id) await herdr("fake.close_pane", { pane_id }).catch(() => {});
  if (workspaceYaml) fs.writeFileSync(path.join(env.JOYRIDE_HOME, "workspace.yaml"), workspaceYaml);
});

let createdIdea: string | undefined;

test("the nav is Map, Agents, Search, Usage: Agents replaces Proposals, Fleet, Crew and Views, grouped like the map", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Map", "Agents", "Search", "Usage"]) await expect(nav.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
  await expect(nav.locator(":scope > a").first()).toHaveText("Map");
  await expect(nav.locator(":scope > a").nth(1)).toHaveText(/^Agents/);
  await expect(nav.getByRole("button", { name: /More/ })).toBeVisible();
  for (const gone of ["New task", "Proposals", "Fleet", "Crew", "Views"]) await expect(nav.getByRole("link", { name: new RegExp(`^${gone}`) })).toHaveCount(0);
  // The map draws the groups this page uses.
  await expect(page.locator('.region-label[data-region="lens:reporting"]')).toBeAttached();
  await expect(page.locator('.region-label[data-region="repo:/tmp/joyride-fixture-repos/beta"]')).toBeAttached();

  await nav.getByRole("link", { name: /^Agents/ }).click();
  await expect(page).toHaveURL(/#\/agents$/);
  await expect(nav.getByRole("link", { name: /^Agents/ })).toHaveAttribute("aria-current", "page");
  const a = agents(page);
  await expect(a.getByRole("heading", { level: 1 })).toHaveText("Agents");
  await expect(a.locator(".ag-kicker")).toHaveText("Sessions");
  await expect(a.locator("[data-firstmate]")).toBeVisible();
  await expect(a.getByTestId("fleet-feed")).toBeVisible();

  // Ideas sit in the map's groups: the reporting group holds the CSV idea with its crew task and crewmate,
  // and the sync idea sits in its repo's group.
  const reporting = a.locator('[data-group="lens:reporting"]');
  await expect(reporting.locator("h2")).toHaveText("Reporting");
  const csv = reporting.locator('[data-idea="csv-export"]');
  await expect(csv.locator(".ag-idea-title a")).toHaveText("CSV export for the report page");
  await expect(csv.locator(`[data-agent="t:${T.ship}"]`)).toHaveAttribute("data-owner", "crew");
  await expect(csv.locator(`[data-agent="t:${T.ship}"] [data-crewmate="${SHIP}"]`)).toBeVisible();
  await expect(csv.locator(`[data-agent="w:${W.working}"]`)).toBeVisible();
  const beta = a.locator('[data-group="repo:/tmp/joyride-fixture-repos/beta"]');
  await expect(beta.locator("h2")).toHaveText("beta");
  await expect(beta.locator(`[data-idea="idempotent-sync"] [data-agent="w:${W.codex}"]`)).toBeVisible();

  // Everything else is in "Not in an idea yet", last, one block per project.
  const unfiled = a.locator('[data-group="unfiled"]');
  await expect(a.locator("[data-group]").last()).toHaveAttribute("data-group", "unfiled");
  await expect(unfiled.locator("h2")).toHaveText("Not in an idea yet");
  await expect(unfiled.locator(`[data-idea="project:gamma"] [data-agent="w:${id(panes.captain)}"]`)).toBeVisible();
  // Closed sessions fold under each idea or project until asked for.
  const epsilon = unfiled.locator('[data-idea="project:epsilon-agents"]');
  await expect(epsilon.locator(`[data-agent="s:claude:${S.merge}"]`)).toHaveCount(0);
  await epsilon.getByRole("button", { name: /Show 3 finished ones/ }).click();
  await expect(epsilon.locator(`[data-agent="s:claude:${S.merge}"]`)).toBeVisible();
  // A crew task no idea names yet waits here too, with its crewmate on its row.
  await expect(unfiled.locator(`[data-agent="t:${T.done}"] [data-crewmate="${SYNC}"]`)).toBeVisible();
  await expect(a.locator(`[data-agent="w:${SYNC}"]`)).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shot(page, CK, "agents-not-in-an-idea");
  await a.locator(".ag-filters").scrollIntoViewIfNeeded();
  await reporting.scrollIntoViewIfNeeded();
  await shot(page, CK, "agents-by-idea");
});

test("filters: needs you, your helm, crew or yours, running, idle or done, and most recent", async ({ page }) => {
  await page.goto("/#/agents");
  const a = agents(page);
  await expect(row(page, `w:${id(panes.prompt)}`)).toBeVisible();

  // Needs you: blocked at a prompt or holding a call that is yours; signal orange only here.
  await expect(filterLink(page, "show", "needs-you")).toHaveClass(/hot/);
  await filterLink(page, "show", "needs-you").click();
  await expect(page).toHaveURL(/#\/agents\?show=needs-you$/);
  await expect(filterLink(page, "show", "needs-you")).toHaveAttribute("aria-current", "page");
  const rows = a.locator("[data-agent]");
  await expect(row(page, `w:${id(panes.prompt)}`)).toBeVisible();
  await expect(row(page, `w:${W.blocked}`)).toBeVisible();
  await expect(rows).toHaveCount(await tabCount(page, "show", "needs-you"));
  for (const r of await rows.all()) await expect(r).toHaveClass(/needs-you/);
  await expect(row(page, `w:${id(panes.prompt)}`).locator(".ag-needs")).toHaveText("Waiting at a prompt");
  await shot(page, CK, "filter-needs-you", { fullPage: true });

  // At your helm.
  await filterLink(page, "show", "your-helm").click();
  await expect(page).toHaveURL(/#\/agents\?show=your-helm$/);
  await expect(filterLink(page, "show", "your-helm")).toHaveAttribute("aria-current", "page");
  await expect(row(page, `w:${id(panes.captain)}`).locator('[data-helm="captain"]')).toHaveText("Helm: you");
  for (const r of await a.locator('[data-agent^="w:"]').all()) await expect(r.locator('[data-helm="captain"]')).toHaveCount(1);
  await expect(rows).toHaveCount(await tabCount(page, "show", "your-helm"));
  await shot(page, CK, "filter-your-helm");

  // Crew or yours.
  await filterLink(page, "show", "all").click();
  await filterLink(page, "owner", "crew").click();
  await expect(page).toHaveURL(/#\/agents\?owner=crew$/);
  await expect(row(page, `t:${T.ship}`)).toBeVisible();
  await expect(row(page, `t:${T.scout}`)).toBeVisible();
  await expect(a.locator('[data-agent][data-owner="yours"]')).toHaveCount(0);
  await expect(row(page, `t:${T.ship}`).locator('.ag-meta [data-owner="crew"]')).toHaveText("Crew");
  await shot(page, CK, "filter-crew", { fullPage: true });
  await filterLink(page, "owner", "yours").click();
  await expect(page).toHaveURL(/#\/agents\?owner=yours$/);
  await expect(row(page, `w:${id(panes.captain)}`)).toBeVisible();
  await expect(a.locator('[data-agent][data-owner="crew"]')).toHaveCount(0);
  await expect(a.locator('[data-agent^="t:"]')).toHaveCount(0);

  // Running, idle, done; done rows also open from each idea's fold.
  await filterLink(page, "owner", "all").click();
  for (const s of ["running", "idle", "done"] as const) {
    await filterLink(page, "state", s).click();
    await expect(page).toHaveURL(new RegExp(`#/agents\\?state=${s}$`));
    await expect(filterLink(page, "state", s)).toHaveAttribute("aria-current", "page");
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(await tabCount(page, "state", s));
    for (const r of await rows.all()) await expect(r).toHaveAttribute("data-state", s);
    await shot(page, CK, `filter-${s}`, { fullPage: s === "done" });
  }
  await expect(row(page, `s:claude:${S.merge}`)).toBeVisible();
  await expect(row(page, `s:claude:${S.merge}`).locator('[data-state="done"]')).toHaveText("Done");

  // Filters combine, and the URL carries them.
  await filterLink(page, "owner", "yours").click();
  await expect(page).toHaveURL(/#\/agents\?owner=yours&state=done$/);
  await expect(filterLink(page, "owner", "yours")).toHaveAttribute("aria-current", "page");
  await expect(rows).toHaveCount(await tabCount(page, "owner", "yours"));
  for (const r of await rows.all()) { await expect(r).toHaveAttribute("data-owner", "yours"); await expect(r).toHaveAttribute("data-state", "done"); }
  await filterLink(page, "owner", "crew").click();
  await expect(page).toHaveURL(/#\/agents\?owner=crew&state=done$/);
  await expect(filterLink(page, "owner", "crew")).toHaveAttribute("aria-current", "page");
  await expect(rows).toHaveCount(await tabCount(page, "owner", "crew"));

  // Most recent: one list, newest first, each row naming its idea.
  await page.goto("/#/agents?order=recent");
  await expect(a.getByTestId("agents-recent")).toBeVisible();
  await expect(a.locator("[data-group]")).toHaveCount(0);
  await expect(row(page, `w:${W.working}`).locator(".ag-sub")).toContainText("In CSV export for the report page");
  await expect(row(page, `w:${id(panes.captain)}`).locator(".ag-sub")).toContainText("Not in an idea yet");
  await shot(page, CK, "order-recent", { fullPage: true });
});

test("retired pages redirect to Agents, with no generated views or evolution commands", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/")) requests.push(r.url()); });
  for (const route of ["evolve", "hillclimb/run-old", "capabilities", "learnings", "view/needs-me", "views"]) {
    await page.goto(`/#/${route}`);
    await expect(page).toHaveURL(/#\/agents$/);
    await expect(agents(page)).toBeVisible();
  }
  await expect(agents(page).getByTestId("saved-filters")).toHaveCount(0);
  for (const gone of ["/api/query", "/api/workspace/proposals", "/api/learnings", "/api/capabilities", "/api/hillclimb"]) {
    expect(requests.some((r) => r.includes(gone))).toBe(false);
  }
  await expect(row(page, `t:${T.ship}`)).toBeVisible();
  await shot(page, "C8", "placement-only-agents");
});

test("your sessions: answer a prompt, save and close first, steer, hand back, keep to yourself, open", async ({ page }) => {
  await page.goto("/#/agents?owner=yours");
  // Answer the permission prompt in place.
  const prompt = row(page, `w:${id(panes.prompt)}`);
  const ask = prompt.getByRole("region", { name: "Needs you: Allow Bash in the agents prompt pane?" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await shot(page, CK, "answer-prompt");
  const keysBefore = (await herdr("fake.state")).keys.length;
  await ask.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(async () => (await herdr("fake.state")).keys.filter((k: any) => k.target === panes.prompt).length, { timeout: 10000 }).toBeGreaterThan(0);
  expect((await herdr("fake.state")).keys.length).toBeGreaterThan(keysBefore);
  await expect(ask).toHaveCount(0, { timeout: 10000 });

  // Save and close asks first: Firstmate's prune ask, answered here.
  const idle = row(page, `w:${id(panes.idle)}`);
  await idle.getByRole("button", { name: "Save and close" }).click();
  const prune = idle.locator('.ask-card[data-ask-kind="approval"]');
  await expect(prune).toBeVisible({ timeout: 10000 });
  await expect(prune).toContainText("Save the session before closing its idle pane");
  await expect(idle.getByRole("button", { name: "Save and close" })).toHaveCount(0);
  await shot(page, CK, "save-and-close");
  await prune.getByRole("button", { name: "Keep the pane open" }).click();
  await expect(prune).toHaveCount(0, { timeout: 10000 });
  expect((await call<any[]>("GET", "/api/fleet/prunes")).body.some((p) => p.worker === id(panes.idle) && p.status === "rejected")).toBe(true);
  // Preserve and close runs the guarded retirement, which refuses a pane idle for minutes; nothing closes.
  await idle.getByRole("button", { name: "Save and close" }).click();
  await idle.locator('.ask-card[data-ask-kind="approval"]').getByRole("button", { name: "Preserve and close" }).click();
  await expect(idle.locator(".ak-err")).toContainText(/Cannot retire|idle less than/);
  expect((await herdr("fake.state")).panes.some((p: any) => p.pane_id === panes.idle)).toBe(true);

  // Steer it yourself: the reply reaches its pane and you take the helm; then hand it back.
  await idle.getByRole("button", { name: "Steer" }).click();
  const box = idle.locator(".ag-steer").getByRole("textbox");
  await expect(box).toBeFocused();
  await box.fill("Summarise what you changed in two lines");
  await box.press("Enter");
  await expect.poll(async () => (await herdr("fake.state")).prompts.some((p: any) => p.target === panes.idle && String(p.text).includes("Summarise what you changed")), { timeout: 10000 }).toBe(true);
  await expect(idle.locator('[data-helm="captain"]')).toHaveText("Helm: you", { timeout: 10000 });
  await shot(page, CK, "steer-takes-helm");
  await idle.getByRole("button", { name: "Hand back" }).click();
  await expect(idle.locator('[data-helm="firstmate"]')).toHaveText("Helm: Firstmate", { timeout: 10000 });

  // Keep it to yourself, then put it back in the fleet.
  await idle.getByRole("button", { name: "Keep to myself" }).click();
  await expect(idle.locator('[data-owner="excluded"]')).toHaveText("Yours only", { timeout: 10000 });
  await idle.getByRole("button", { name: "Back in the fleet" }).click();
  await expect(idle.locator('[data-owner="watched"]')).toHaveText("Watched", { timeout: 10000 });

  // Open: its worker pane.
  await idle.getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(id(panes.idle))}$`));
});

test("crew: open the task sheet, steer the task, open a crewmate", async ({ page }) => {
  await page.goto("/#/agents?owner=crew");
  const ship = row(page, `t:${T.ship}`);
  await ship.locator(".ag-actions").getByRole("button", { name: "Steer" }).click();
  const box = ship.locator(`[data-steer="t:${T.ship}"]`).getByRole("textbox");
  await box.fill("Keep the totals row bold");
  await box.press("Enter");
  await expect(ship.locator(`[data-steer="t:${T.ship}"]`).getByRole("status")).toContainText("Recorded in the task's inbox", { timeout: 20000 });
  const inbox = path.join(env.JOYRIDE_RUNTIME, "firstmate", "state", `${T.ship}.inbox`);
  expect(fs.readdirSync(inbox).filter((n) => n.endsWith(".msg")).map((n) => fs.readFileSync(path.join(inbox, n), "utf8")).join("\n")).toContain("Keep the totals row bold");
  await shot(page, CK, "steer-task");

  await ship.locator(".ag-actions").getByRole("link", { name: "Open" }).click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T.ship}$`));
  const sheet = page.locator(`[data-task-sheet="${T.ship}"]`);
  await expect(sheet).toBeVisible();
  await shot(page, CK, "task-sheet");
  await page.goto("/#/agents?owner=crew");
  await row(page, `t:${T.ship}`).locator(`[data-crewmate="${SHIP}"] a`).click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(SHIP)}$`));
});

test("suggestions sit on unsorted sessions: file it into an idea, make it one, or leave it out", async ({ page }) => {
  await page.goto("/#/agents?state=done");
  const merge = row(page, `s:claude:${S.merge}`);
  const s1 = merge.locator(`[data-suggestion="${PROPOSALS.merge}"]`);
  await expect(s1).toContainText("Looks like CSV export for the report page");
  await expect(row(page, `s:claude:${S.fresh}`).locator(`[data-suggestion="${PROPOSALS.fresh}"]`)).toContainText("Looks like a new idea: “Report page dark theme”");
  await page.mouse.move(0, 0);
  await merge.scrollIntoViewIfNeeded();
  await shot(page, CK, "suggestions-inline");

  await s1.getByRole("button", { name: "File it there" }).click();
  await expect(agents(page).locator(`[data-idea="csv-export"] [data-agent="s:claude:${S.merge}"]`)).toBeVisible({ timeout: 10000 });
  expect((await call("GET", "/api/missions/csv-export")).body.sessions.some((s: any) => s.id === S.merge)).toBe(true);

  await row(page, `s:claude:${S.fresh}`).getByRole("button", { name: "Make it an idea" }).click();
  await expect(agents(page).locator(`[data-idea="project:epsilon-agents"] [data-agent="s:claude:${S.fresh}"]`)).toHaveCount(0, { timeout: 10000 });
  const made = (await call<any[]>("GET", "/api/missions")).body.find((m) => m.sessions.some((s: any) => s.id === S.fresh));
  createdIdea = made?.id;
  expect(made?.title).toBe("Report page dark theme");
  await expect(agents(page).locator(`[data-idea="${made.id}"] [data-agent="s:claude:${S.fresh}"]`)).toBeVisible();

  const drop = row(page, `s:claude:${S.drop}`);
  await drop.getByRole("button", { name: "Not an idea" }).click();
  await expect(drop.locator("[data-suggestion]")).toHaveCount(0, { timeout: 10000 });
  expect((await call<any[]>("GET", "/api/missions/proposals?status=rejected")).body.some((p) => p.id === PROPOSALS.drop)).toBe(true);

  // The rest wait under Suggested ideas, with the full triage.
  await page.goto("/#/agents");
  const link = agents(page).locator("[data-suggested-link]");
  const pending = (await call<any[]>("GET", "/api/missions/proposals")).body.length;
  if (pending) {
    await expect(link).toContainText(`${pending} suggested idea`);
    await link.click();
  } else await filterLink(page, "show", "suggested").click();
  await expect(page).toHaveURL(/#\/agents\?show=suggested$/);
  const triage = agents(page).getByTestId("suggested-ideas");
  await expect(triage.getByRole("heading", { level: 2, name: "Suggested ideas" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).locator(".nav-badge")).toHaveText(pending ? String(pending) : /.*/);
  await shot(page, CK, "suggested-ideas");
});

test("old routes land on the matching filter", async ({ page }) => {
  const cases: [string, RegExp][] = [
    ["fleet", /#\/agents$/],
    ["fleet?show=crew", /#\/agents\?owner=crew$/],
    ["fleet?show=watched", /#\/agents\?owner=yours$/],
    ["fleet?show=yours-only", /#\/agents\?owner=yours$/],
    ["fleet?show=needs-you", /#\/agents\?show=needs-you$/],
    ["fleet?show=your-helm", /#\/agents\?show=your-helm$/],
    ["task", /#\/agents\?owner=crew$/],
    ["crew", /#\/agents\?owner=crew$/],
    [`crew/${T.ship}`, new RegExp(`#/task/${T.ship}$`)],
    ["proposals", /#\/agents\?show=suggested$/],
    ["view", /#\/agents$/],
    ["view/needs-me", /#\/agents$/],
  ];
  for (const [from, to] of cases) {
    await page.goto(`/#/${from}`);
    await expect(page, `#/${from}`).toHaveURL(to);
    if (!from.startsWith("crew/")) await expect(agents(page)).toBeVisible();
  }
  // A task keeps its sheet.
  await page.goto(`/#/task/${T.scout}`);
  await expect(page.locator(`[data-task-sheet="${T.scout}"]`)).toBeVisible();
  // Back never lands on the redirect again.
  await page.goto("/#/map");
  await page.goto("/#/fleet?show=crew");
  await expect(page).toHaveURL(/#\/agents\?owner=crew$/);
  await page.goBack();
  await expect(page).toHaveURL(/#\/map$/);

  // The palette has the new page and none of the old ones.
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill("agents");
  await expect(palette.getByRole("option", { name: /Go to agents/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /Agents that need you/ })).toBeVisible();
  for (const old of ["fleet", "crew", "views", "proposals"]) {
    await palette.getByRole("textbox").fill(`go to ${old}`);
    await expect(palette.getByRole("option", { name: new RegExp(`^Go to ${old}`, "i") })).toHaveCount(0);
  }
});
