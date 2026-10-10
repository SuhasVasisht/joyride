// C12 acceptance journeys (control-plane report §12): the captain runs a working day from the home page
// without opening Firstmate's chat. Each test starts at #/ and walks one journey, J1 to J10 in order, with
// Firstmate's control pane running in the fake Herdr; J11 adds the knowledge home's bare redirects and one
// search over what the day wrote; J12 then checks the whole run never went to Firstmate's worker route and
// never sent its pane a reply or a key. The detailed assertions for each journey also live in the CP specs
// named in docs/CHECKPOINTS.md (C12); these add what each journey still lacked end to end.
// Runs on the e2e sandbox with a fixture FM_HOME (real vendored intake, fm-send and tasks-axi, doorbells
// stubbed), the fake Herdr and fake models.
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { call, herdr, PORT, waitUntil, openIdea } from "./map-seed";
import { shot } from "./shot";
import { panTo } from "./chart-pan";
import { applyNew, composeTask, newInput, planNew } from "./new-box";
import { trackFixtureNotes } from "./fixture-cleanup";

let cleanNotes: (() => Promise<void>) | undefined;

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const CP = "C12";
const IDEA = "c12-export", QUIET = "c12-quiet", PARK = "c12-park", GROUP = "c12-group";
const IDEA_TITLE = "Ship the CSV export totals";
const LANDED = "c12-landed", OLD = "c12-old-charts", REPORT_CALL = "c12-report-call";
const LOOSE = ["c12-hk-round", "c12-hk-speed", "c12-hk-backup", "c12-hk-certs"] as const;
const CREW = `local:${FIXTURE_CREW_PANES.ship}`;
const CREW_SESSION = "c12-crew-session";
const WORDS = "Keep the server's rounding (quillback)";

const backlog = () => fs.readFileSync(path.join(home, "data", "backlog.md"), "utf8");
const setBacklog = (text: string) => fs.writeFileSync(path.join(home, "data", "backlog.md"), text);
const statusLog = (id: string) => fs.readFileSync(path.join(home, "state", `${id}.status`), "utf8");
const inboxMsgs = (id: string) => {
  const dir = path.join(home, "state", `${id}.inbox`);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".msg")).map((n) => fs.readFileSync(path.join(dir, n), "utf8")) : [];
};
const inboxNotes = () => {
  const out: string[] = [];
  for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
    if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) if (n.endsWith(".note")) out.push(fs.readFileSync(path.join(dir, n), "utf8"));
  }
  return out;
};
const enc = (s: string) => `fm-hold-v1:${Buffer.from(s, "utf8").toString("base64")}`;
const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const epoch = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const lastIntent = async (kind: string) => (await call("GET", `/api/intents?kind=${kind}&limit=1`)).body[0];
const task = async (id: string) => (await call("GET", `/api/firstmate/tasks/${id}`)).body;
const gitHome = (...args: string[]) => execFileSync("git", args, { cwd: env.JOYRIDE_HOME, encoding: "utf8" }).trim();

// ---------- the whole run, for J12 ----------
const started = new Date().toISOString();
const visited: string[] = [];
const controls = new Set<string>();
function watch(page: Page) {
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) visited.push(f.url()); });
}
async function startFirstmate() {
  const r = await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "idle", name: "firstmate", title: "Firstmate", label: "firstmate" });
  await waitUntil(async () => (await call("GET", "/api/firstmate/status")).body?.running === true);
  const control = (await call("GET", "/api/firstmate/status")).body.pane.worker as string;
  controls.add(control);
  return { pane: r.pane.pane_id as string, control };
}
let firstmatePane = "";

// ---------- map helpers (as in control-plane-integrate) ----------
async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  if (await page.locator(".map-viewport").getAttribute("data-focus")) await page.getByTestId("map-crumbs").getByRole("button", { name: "Map", exact: true }).click();
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
async function home0(page: Page, size = { width: 1600, height: 1600 }) {
  watch(page);
  await page.setViewportSize(size);
  await page.goto("/#/");
  await expect(page.getByTestId("firstmate-node")).toBeVisible();
}
/** Bring an idea into view at near zoom: focus its title, which centres it. */
async function nearOn(page: Page, mission: string) {
  const node = page.locator(`.mission-node[data-mission="${mission}"]`);
  await expect(node).toBeVisible();
  await node.locator(".mn-title").focus();
  await zoom(page, "Near");
  await node.locator(".mn-title").focus();
  // Acting on an idea's tasks, crew and every ask happens on the idea opened in full.
  await openIdea(page, mission);
  return node;
}
const landed = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll(".ghost")].every((el) => el.getAnimations().every((a) => a.playState !== "running")));
/** Firstmate (the fixture) writes the task a map request asked for, keeping both markers in its brief. */
function firstmateWritesTask(id: string, title: string, mission: string, request: string) {
  setBacklog(backlog().replace("## Queued\n", `## Queued\n\n- [ ] ${id} - ${title} (repo: alpha) (kind: ship)\n`));
  write(path.join(home, "data", id, "brief.md"), `# ${title}\n\n## Captain's intent\n\njoyride-mission: ${mission}\njoyride-request: ${request}\n\n${title}.\n`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  cleanNotes = await trackFixtureNotes();
  expect(home.startsWith(`/tmp/joyride-e2e-${PORT}/`)).toBe(true);
  for (const [id, title] of [[IDEA, IDEA_TITLE], [QUIET, "Revisit the old revenue charts"], [PARK, "Parked maintenance"]]) {
    if ((await call("GET", `/api/missions/${id}`)).status === 404) expect((await call("POST", "/api/missions", { id, title, repos: ["/tmp/joyride-fixture-repos/alpha"] })).status).toBe(201);
    else await call("PUT", `/api/missions/${id}`, { archive: false, state: "open" });
  }
  expect([200, 409]).toContain((await call("POST", "/api/lenses", { id: GROUP, title: "Control plane day", description: "C12 journeys", missions: [IDEA, QUIET, PARK] })).status);

  buildFirstmateHome(home, IDEA);
  addAskFixtures(home);
  fs.writeFileSync(path.join(home, "data", "secondmates.md"), "");
  let text = backlog()
    // Its own hold stamp, so another spec's answer receipt for the same fixture call is a different lifecycle.
    .replace(/(  Captain hold set: )\S+/, "$1" + day(-3))
    // A queued task on an idea nobody touched in six days: housekeeping asks "Still want this?".
    .replace("## Queued\n", `## Queued\n\n- [ ] ${OLD} - Rebuild the old revenue charts (repo: alpha) (kind: ship)\n`)
    // A task that landed three hours ago, past the "how did it land?" threshold. Its own id, so the CP6 spec's
    // nudge on the shared fixture's done task stays unanswered.
    .replace("## Done\n", `## Done\n\n- [x] ${LANDED} - Add the totals row to the PDF export (repo: alpha) (kind: ship) (done ${day(0)})\n`);
  setBacklog(text);
  write(path.join(home, "data", OLD, "brief.md"), `# Rebuild the old revenue charts\n\n## Captain's intent\n\njoyride-mission: ${QUIET}\n\nRedo the charts.\n`);
  const six = new Date(Date.now() - 6 * 864e5);
  fs.utimesSync(path.join(home, "data", OLD, "brief.md"), six, six);
  write(path.join(home, "data", LANDED, "brief.md"), `# Add the totals row to the PDF export\n\n## Captain's intent\n\njoyride-mission: ${IDEA}\n\nThe PDF gets the same totals row.\n`);
  write(path.join(home, "state", `${LANDED}.status`), `done [at=${epoch(3 * 36e5)}]: totals row in the PDF, 14 tests pass\n`);
  write(path.join(home, "state", `${LANDED}.meta`), `endpoint_task_id=${LANDED}\nharness=claude\nkind=ship\n`);
  const three = new Date(Date.now() - 3 * 36e5);
  for (const f of [path.join(home, "data", LANDED, "brief.md"), path.join(home, "state", `${LANDED}.status`), path.join(home, "state", `${LANDED}.meta`)]) fs.utimesSync(f, three, three);

  // The ship task's crewmate, live in its Herdr pane with a session of its own (agents carry notes by session).
  const wt = (await waitUntil(async () => (await task(T.ship))?.worktree)) as string;
  const st = await herdr("fake.state");
  if (st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) await herdr("fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship });
  await herdr("fake.add_pane", {
    workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: CREW_SESSION },
  });
  ({ pane: firstmatePane } = await startFirstmate());
  await waitUntil(async () => (await task(T.ship)).workers.length === 1 && (await task(T.ship)).mission === IDEA);
  await waitUntil(async () => {
    const asks: { id: string }[] = (await call("GET", "/api/asks")).body.asks;
    return asks.some((a) => a.id === `hold:${ASK_TASKS.calls}`) && asks.some((a) => a.id === `decision:${T.scout}:flake-cause`);
  });
});

test.afterAll(async () => {
  await cleanNotes?.();
  for (const p of [FIXTURE_CREW_PANES.ship, firstmatePane]) if (p) await herdr("fake.close_pane", { pane_id: p }).catch(() => {});
  // Later specs build their own home and expect Firstmate stopped.
  buildFirstmateHome(home, IDEA);
  const ours = ((await call("GET", "/api/missions")).body as { id: string; title: string }[]).filter((m) => m.id.startsWith("c12-") || created.has(m.id));
  for (const m of ours) await call("PUT", `/api/missions/${m.id}`, { archive: true }).catch(() => {});
  await call("DELETE", `/api/lenses/${GROUP}`).catch(() => {});
});
/** Ideas this run made (a new idea from the map, housekeeping's new ideas): archived afterwards. */
const created = new Set<string>();

test("J1 see the plane: hub, groups, ideas and task cards at far, mid and near; every open task in an idea; who runs each", async ({ page }) => {
  await home0(page);
  const hub = page.getByTestId("firstmate-node");
  await expect(hub).toHaveAttribute("data-firstmate", "running");
  // Housekeeping has filed the minted captain rows by now (J9 proves how): link them, as a placement would.
  const open = ((await call("GET", "/api/firstmate/tasks")).body as { id: string; section: string | null; mission: string | null }[]).filter((t) => t.section === "in_flight" || t.section === "queued");
  const loose = open.filter((t) => !t.mission).map((t) => t.id);
  if (loose.length) {
    const m = (await call("GET", `/api/missions/${IDEA}`)).body;
    expect((await call("PUT", `/api/missions/${IDEA}`, { crews: [...new Set([...(m.crews ?? []), ...loose])] })).status).toBe(200);
  }
  await waitUntil(async () => ((await call("GET", "/api/firstmate/tasks")).body as { section: string | null; mission: string | null }[])
    .filter((t) => t.section === "in_flight" || t.section === "queued").every((t) => t.mission));
  const idea = page.locator(`.mission-node[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();

  await zoom(page, "Far");
  await expect(page.locator(`.region-label[data-region="lens:${GROUP}"]`)).toBeVisible();
  await expect(page.locator(`.region-label[data-region="lens:${GROUP}"]`)).toContainText("Control plane day");
  await expect(idea.locator(".mn-summary")).toContainText(/\d+ needs? you/);
  await expect(idea.locator(".mn-count.signal")).toBeVisible();
  await expect(idea.locator("[data-task]")).toHaveCount(0);
  await expect(page.locator(".orphans-node")).toHaveCount(0); // nothing unfiled on the hub
  await shot(page, CP, "j1-far");

  await zoom(page, "Mid");
  await expect(page.locator(`.region-label[data-region="lens:${GROUP}"]`)).toBeVisible();
  for (const id of [T.ship, T.scout, T.queued]) await expect(idea.locator(`.task-row[data-task="${id}"]`)).toBeVisible();
  await expect(idea.locator(`.task-row[data-task="${T.ship}"] .tr-now`)).toContainText("running the e2e suite against the totals row");
  await expect(idea.locator(`.task-row[data-task="${T.ship}"] .tr-title`)).toHaveAttribute("title", /Claude Code · claude-opus-5-5, high · claude-2/);
  await expect(hub.locator('[data-fm="ticker"]')).not.toHaveClass(/quiet/);
  await shot(page, CP, "j1-mid");

  await zoom(page, "Near");
  await idea.locator(".mn-title").focus();
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await expect(ship.locator(".tc-now")).toContainText("running the e2e suite against the totals row");
  // Who runs it and its crew show on the idea opened in full.
  await openIdea(page, IDEA);
  await expect(ship.locator(".tc-who")).toContainText("Claude Code · claude-opus-5-5, high · claude-2");
  await expect(ship.locator(".tc-now")).toContainText("running the e2e suite against the totals row");
  const crew = ship.locator(`.tc-crew [data-worker="${CREW}"]`);
  await expect(crew.locator('[data-owner="crew"]')).toBeVisible();
  await expect(crew.locator("[data-helm]")).toHaveText("Helm: Firstmate");
  await expect(page.locator(".orphans-node")).toHaveCount(0);
  await ship.scrollIntoViewIfNeeded();
  await shot(page, CP, "j1-near");
});

test("J2 a crewmate's decision: Firstmate decides first, it turns orange once Firstmate has been stopped past the threshold, and an option answers it", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const id = `decision:${T.scout}:flake-cause`;
  const card = idea.locator(`.task-card[data-task="${T.scout}"] .ask-card[data-ask="${id}"]`);
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card.locator(".ak-state")).toHaveText("Firstmate is deciding");
  await expect(card).not.toHaveClass(/needs-you/);

  // Firstmate stops. Fifteen minutes in, it is still Firstmate's (the threshold is twenty).
  await herdr("fake.close_pane", { pane_id: firstmatePane });
  await expect(page.getByTestId("firstmate-node")).toHaveAttribute("data-firstmate", "stopped");
  await expect(card.locator(".ak-state")).toHaveText("Firstmate is deciding");
  // Time passes: the decision has now waited 25 minutes on a stopped Firstmate.
  const file = path.join(home, "state", `${T.scout}.status`);
  fs.writeFileSync(file, statusLog(T.scout).replace(/(needs-decision \[key=flake-cause\] \[at=)\d+/, `$1${epoch(25 * 6e4)}`));
  await expect(card).toHaveClass(/needs-you/, { timeout: 15000 });
  await expect(card.locator(".ak-state")).toHaveText("Needs you");
  expect((await call("GET", `/api/asks/${encodeURIComponent(id)}`)).body).toMatchObject({ needs_you: true, state: "Firstmate is stopped", owner: "captain" });
  await expect(card.getByRole("radio", { name: /Hold off for now/ })).toBeVisible({ timeout: 15000 }); // options suggested from the question
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "j2-decision-orange");

  await card.getByRole("radio", { name: /Hold off for now/ }).check();
  await card.getByRole("button", { name: "Send these choices" }).click();
  await waitUntil(async () => /resolved .*\[key=flake-cause\].*answered: B \(Hold off for now\)/.test(statusLog(T.scout)));
  expect(inboxMsgs(T.scout).join("\n")).toContain("B (Hold off for now)");
  await expect(card).toHaveCount(0, { timeout: 15000 });
  await shot(page, CP, "j2-decision-answered");
  ({ pane: firstmatePane } = await startFirstmate());
});

test("J3 a captain call answered with all recommendations and words: Done with the exact words from joyride-map, a wake note, and a decision in Knowledge", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const card = idea.locator(`.ask-card[data-ask="hold:${ASK_TASKS.calls}"]`);
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card).toContainText("Needs you");
  await card.getByRole("button", { name: "Add your own words" }).click();
  await card.getByRole("textbox", { name: "Your answer" }).fill(WORDS);
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "j3-call-with-words");
  await card.getByRole("button", { name: "Use all recommendations" }).click();
  const exact = `Go with your recommendations: 1 A, 2 B. ${WORDS}`;
  await waitUntil(async () => backlog().includes(`- [x] ${ASK_TASKS.calls}`));
  const row = backlog().slice(backlog().indexOf(`- [x] ${ASK_TASKS.calls}`));
  expect(row).toContain("Resolution recorded by fm-captain-hold");
  expect(row).toContain(exact);
  expect(row).toContain("joyride-map");
  await expect(card).toHaveCount(0, { timeout: 10000 });
  const it = await waitUntil(async () => {
    const latest = (await call("GET", `/api/intents?kind=answer_ask&target=${encodeURIComponent(`hold:${ASK_TASKS.calls}`)}&limit=1`)).body[0];
    return latest?.status === "sent" ? latest : null;
  }, 30000);
  expect(it).toMatchObject({ status: "sent", origin: "captain" });
  expect(inboxNotes().some((n) => n.includes(`request_id=${it.id}`) && n.includes(`Captain answered ${ASK_TASKS.calls} on the map: ${exact}`))).toBe(true);
  expect(fs.readFileSync(path.join(home, "state", ".wake-queue"), "utf8")).toContain("check");
  const decision = (await call("GET", `/api/notes/${it.result.note}`)).body;
  expect(decision).toMatchObject({ kind: "note", status: "active", scope: `mission:${IDEA}` });

  // The decision is in Knowledge, under its idea.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Search/ }).click();
  await expect(page.getByTestId("knowledge-page")).toBeVisible();
  await page.getByTestId("knowledge-search").fill("quillback");
  const hit = page.locator(`[data-key="note:${decision.id}"]`);
  await expect(hit).toBeVisible();
  await page.getByRole("combobox", { name: "Filter by idea" }).selectOption(IDEA);
  await expect(hit).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, CP, "j3-decision-in-knowledge");
});

test("J4 approve a held work item (release): it is unheld, back in the queue, and the ask clears", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const card = idea.locator(`.task-card[data-task="${T.queued}"] .ask-card[data-ask="hold:${T.queued}"]`);
  await card.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(card).toContainText("Start the docs");
  await expect(card.getByRole("combobox")).toHaveValue("release"); // a held work item resumes, it isn't closed
  // The hold names no options, so they are suggested from its words.
  await card.getByRole("radio", { name: /Go ahead as proposed/ }).check({ timeout: 15000 });
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "j4-release");
  await card.getByRole("button", { name: "Send these choices" }).click();
  await waitUntil(async () => { const t = await task(T.queued); return t.hold_kind === null && t.hold_reason === null; });
  expect(await task(T.queued)).toMatchObject({ section: "queued" });
  expect(backlog()).toContain(`- [ ] ${T.queued}`);
  expect(backlog()).not.toContain(`- [x] ${T.queued}`);
  await expect(card).toHaveCount(0, { timeout: 10000 });
  expect((await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${T.queued}`)).toBe(false);
});

test("J5 a worker's permission prompt: Allow on its card sends the keys through answer_prompt to the pane", async ({ page }) => {
  // Claude Code's PermissionRequest hook raises the approval for its session; Herdr then reports the pane
  // blocked, which joins that item instead of opening a second one.
  await call("POST", "/api/attention", { level: "L3", kind: "approval", title: "Needs permission: Bash in alpha", why: "npm run test:export -- --runInBand", worker: CREW, session: `claude:${CREW_SESSION}` });
  await herdr("fake.set_menu", { pane_id: FIXTURE_CREW_PANES.ship, status: "blocked" });
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  const prompt = ship.locator('.ask-card[data-ask-kind="prompt"]');
  await prompt.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(prompt).toContainText("Needs you", { timeout: 10000 });
  await expect(ship.locator(`.tc-crew [data-worker="${CREW}"]`)).toBeVisible(); // the worker line it belongs to, on the same card
  await prompt.scrollIntoViewIfNeeded();
  await shot(page, CP, "j5-prompt-on-card");
  const before = (await herdr("fake.state")).keys.length;
  await prompt.getByRole("button", { name: "Allow", exact: true }).click();
  const sent = await waitUntil(async () => (await herdr("fake.state")).keys.slice(before).find((k: any) => k.target === FIXTURE_CREW_PANES.ship));
  expect(sent.keys).toEqual(["1"]);
  const it = (await call("GET", `/api/intents?kind=answer_prompt&target=${encodeURIComponent(CREW)}&limit=1`)).body[0];
  expect(it).toMatchObject({ status: "sent", origin: "captain", result: { choice: "allow" } });
  await expect(prompt).toHaveCount(0, { timeout: 10000 });
});

test("J6 the side sheet: a worker opens on the right with the map in view, the task sheet's steer reaches fm-send, and Esc returns to the card", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  const line = ship.locator(`.tc-crew [data-worker="${CREW}"] a`).first();
  await line.click();
  await expect(page).toHaveURL(new RegExp(`#/worker/${encodeURIComponent(CREW)}`));
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet).toBeVisible();
  await expect(page.locator(".map-viewport")).toBeVisible();
  // The sheet sits on the right; a band of the live map stays in view to its left.
  const box = (await sheet.boundingBox())!, map = (await page.locator(".map-viewport").boundingBox())!, vw = page.viewportSize()!.width;
  expect(box.x - map.x).toBeGreaterThan(200);
  expect(box.x + box.width).toBeGreaterThan(vw * 0.7);
  await shot(page, CP, "j6-worker-sheet-over-map");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(line).toBeFocused();

  const title = ship.locator(".tc-title");
  await panTo(title);
  await title.click();
  await expect(page).toHaveURL(new RegExp(`#/task/${T.ship}$`));
  const ts = page.locator(`[data-task-sheet="${T.ship}"]`);
  await expect(ts).toBeVisible();
  await expect(ship).toHaveClass(/selected/);
  const steer = page.getByRole("textbox", { name: /^Steer / });
  await steer.fill("Put the totals row in bold.");
  await steer.press("Enter");
  await expect(page.locator(".ts-steer").getByRole("status")).toContainText("Recorded in the task's inbox", { timeout: 20000 });
  expect(inboxMsgs(T.ship).join("\n")).toContain("Put the totals row in bold.");
  // fm-send rang its doorbell through the stubbed terminal, never a real one.
  expect(fs.readFileSync(path.join(env.JOYRIDE_RUNTIME, "firstmate-stubs", "calls.log"), "utf8")).toMatch(/^(herdr|tmux) /m);
  await shot(page, CP, "j6-task-sheet-steer");
  await steer.press("Escape"); // the first Esc leaves the steer box, the second closes the sheet
  await page.keyboard.press("Escape");
  await expect(ts).toBeHidden();
  await expect(title).toBeFocused();
  await expect(ship).not.toHaveClass(/selected/);
});

test("J7 notes on an idea, a task and an agent: scoped entries, chips, the CLI, the task digest and source Search", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  const add = async (where: Locator, button: string, text: string) => {
    await where.getByRole("button", { name: button }).click();
    const f = where.getByRole("textbox", { name: "Note" });
    await f.fill(text);
    await f.press("Enter");
    // An idea's notes are cards on its board; a task's and an agent's are chips.
    await expect(where.locator(".note-chip, .note-card", { hasText: text.slice(0, 24) }).first()).toBeVisible();
  };
  await idea.getByRole("button", { name: "Add to this idea", exact: true }).click();
  await planNew(page, "add a note: Idea note: totals match the screen to the cent (quillback)");
  await applyNew(page);
  await expect(idea.locator(".note-card", { hasText: "Idea note: totals match" })).toBeVisible();
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await add(ship, "Add a note on this task", "Task note: label the button Export CSV");
  const line = ship.locator(`.tc-crew [data-worker="${CREW}"]`);
  await add(line, "Add a note on this agent", "Agent note: this crewmate is on the old branch");
  await ship.scrollIntoViewIfNeeded();
  await shot(page, CP, "j7-notes-on-map");

  type Note = { id: string; scope: string; bullets: string[] };
  const ideaNote = ((await call("GET", `/api/notes?idea=${IDEA}`)).body as Note[]).find((n) => n.bullets[0].startsWith("Idea note:"))!;
  const taskNote = ((await call("GET", `/api/notes?task=${T.ship}`)).body as Note[]).find((n) => n.bullets[0].startsWith("Task note:"))!;
  const agentNote = ((await call("GET", `/api/notes?session=${encodeURIComponent(`claude:${CREW_SESSION}`)}`)).body as Note[]).find((n) => n.bullets[0].startsWith("Agent note:"))!;
  expect(ideaNote.scope).toBe(`mission:${IDEA}`);
  expect(taskNote.scope).toBe(`task:${T.ship}`);
  expect(agentNote.scope).toBe(`session:claude:${CREW_SESSION}`);
  for (const n of [ideaNote, taskNote, agentNote]) {
    const f = path.join(env.JOYRIDE_HOME, "notes", `${n.id}.md`);
    expect(path.basename(f)).toMatch(/^note-/);
    const body = fs.readFileSync(f, "utf8");
    expect(body).toContain("kind: note");
    expect(body).toContain(`scope: ${n.scope}`);
  }

  // `joyride notes --task` prints the task's notes and its idea's.
  const cli = spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "src/cli/joyride.ts"), "notes", "--task", T.ship], { env: { ...process.env, ...env, FM_TASK_ID: "" }, encoding: "utf8", timeout: 30000 });
  expect(cli.status, cli.stderr).toBe(0);
  expect(cli.stdout).toContain("- Task note: label the button Export CSV");
  expect(cli.stdout).toContain("- Idea note: totals match the screen to the cent (quillback)");
  // The task digest a crewmate's SessionStart hook appends holds both.
  const digest = path.join(env.JOYRIDE_RUNTIME, "task-notes", `task-${T.ship}.md`);
  await expect.poll(() => (fs.existsSync(digest) ? fs.readFileSync(digest, "utf8") : "")).toContain("Task note: label the button Export CSV");
  expect(fs.readFileSync(digest, "utf8")).toContain("Idea note: totals match the screen to the cent");
  expect(fs.readFileSync(digest, "utf8")).not.toContain("Agent note:");

  // Search finds each authored source through its idea, task or session anchor.
  const search = async (q: string, anchor: string) => JSON.stringify((await call("GET", `/api/knowledge/search?q=${encodeURIComponent(q)}&anchor=${encodeURIComponent(anchor)}&types=notes`)).body);
  expect(await search("totals cent", `idea:${IDEA}`)).toContain(ideaNote.id);
  expect(await search("label button", `task:${T.ship}`)).toContain(taskNote.id);
  expect(await search("old branch", `session:claude:${CREW_SESSION}`)).toContain(agentNote.id);

});

test("J8 New sends tasks with context and explicit steering needs no picker", async ({ page }) => {
  await home0(page);
  const idea = await nearOn(page, IDEA);
  await idea.getByRole("button", { name: "Add to this idea" }).click();
  const ghost = await composeTask(page, "Add a grand total row to the CSV export");
  await expect(ghost.getByRole("list", { name: "Progress" })).toBeVisible();
  const it = await lastIntent("create_task");
  expect(it).toMatchObject({ target: IDEA, status: "sent" });
  expect(inboxNotes().some((n) => n.includes(`request_id=${it.id}`) && n.includes(`joyride-mission: ${IDEA}`))).toBe(true);
  firstmateWritesTask("c12-grand-total", "Add a grand total row to the CSV export", IDEA, it.id);
  await expect(idea.locator('.task-card[data-task="c12-grand-total"]')).toBeVisible({ timeout: 12000 });
  await expect(ghost).toHaveClass(/is-task/, { timeout: 12000 });
  await shot(page, CP, "j8-direct-task");
  await ghost.getByRole("button", { name: "Hide this request" }).click();
  await page.goto("/#/compose");
  await newInput(page).fill(`Steer task ${T.ship}: Also show the totals row in bold`);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new"));
  await newInput(page).press("Enter");
  expect((await (await response).json()).state).toBe("done");
  expect(await lastIntent("steer_task")).toMatchObject({ target: T.ship, status: "sent", payload: { text: "Also show the totals row in bold" } });
  expect(inboxMsgs(T.ship).join("\n")).toContain("Also show the totals row in bold");
  await shot(page, CP, "j8-direct-steer");
});

test("J9 placement files four loose tasks in one commit and Undo restores their files", async ({ page }) => {
  test.setTimeout(120_000);
  const titles: Record<(typeof LOOSE)[number], string> = {
    "c12-hk-round": "Round the CSV export totals to cents",
    "c12-hk-speed": "Speed up the CSV export totals query",
    "c12-hk-backup": "Snapshot the archive bucket weekly",
    "c12-hk-certs": "Rotate the staging certificates",
  };
  setBacklog(backlog().replace("## Queued\n", `## Queued\n\n${LOOSE.map((id) => `- [ ] ${id} - ${titles[id]} (repo: alpha) (kind: ship)`).join("\n")}\n`));
  for (const id of LOOSE) write(path.join(home, "data", id, "brief.md"), `# ${titles[id]}\n\n## Captain's intent\n\n${titles[id]}.\n`);
  await waitUntil(async () => { const ts = (await call("GET", "/api/firstmate/tasks")).body as { id: string; mission: string | null }[]; return LOOSE.every((id) => ts.some((t) => t.id === id && !t.mission)); });

  await home0(page);
  await expect(page.locator(".orphans-node")).toHaveAttribute("data-orphans", "4"); // waiting on the hub
  await page.waitForTimeout(800); // what is there at mount is not news
  const head = gitHome("rev-parse", "HEAD");
  const place = (await call("POST", "/api/ideas/place", { tasks: [...LOOSE] })).body;
  expect(place.commit, JSON.stringify(place)).toBeTruthy();
  expect(gitHome("rev-list", "--count", `${head}..HEAD`)).toBe("1"); // one commit
  for (const o of place.ops) if (o.op?.op === "create") created.add(((await call("GET", "/api/missions")).body as { id: string; title: string }[]).find((m) => m.title === o.op.title)!.id);
  const placed = await waitUntil(async () => { const ts = (await call("GET", "/api/firstmate/tasks")).body as { id: string; mission: string | null }[]; const l = LOOSE.map((id) => ts.find((t) => t.id === id)!); return l.every((t) => t.mission) ? l : null; });
  const toast1 = page.locator(`[data-toast="tidied:${place.id}"]`);
  await expect(toast1).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".orphans-node")).toHaveCount(0);
  await shot(page, CP, "j9-placed-toast");

  expect((await call("POST", "/api/ideas/tidy", {})).status).toBe(404);
  await toast1.getByRole("button", { name: "Undo" }).click();
  await expect(toast1).toContainText("Undone");
  await waitUntil(async () => {
    const tasks = (await call("GET", "/api/firstmate/tasks")).body as { id: string; mission: string | null }[];
    return LOOSE.every((id) => tasks.some((t) => t.id === id && !t.mission));
  });
  await expect(page.locator(".orphans-node")).toHaveAttribute("data-orphans", "4");
  await shot(page, CP, "j9-placement-undone");
});

test("J10 live: a status line updates the card and a report's new call appears without a reload; Still want this? Pause; a 👎 files a feedback note while knowledge generation is frozen", async ({ page }) => {
  test.setTimeout(90_000);
  await home0(page);
  const idea = await nearOn(page, IDEA);
  await page.evaluate(() => { (window as any).__c12 = "same page"; });
  const ship = idea.locator(`.task-card[data-task="${T.ship}"]`);
  fs.appendFileSync(path.join(home, "state", `${T.ship}.status`), `working [at=${epoch(0)}]: wiring the totals into the PDF footer\n`);
  await expect(ship.locator(".tc-now, .tc-last")).toContainText("wiring the totals into the PDF footer", { timeout: 10000 });

  // The scout's report is in; Firstmate holds the call it raises for the captain.
  setBacklog(backlog().replace("## Done", [
    `- [ ] ${REPORT_CALL} - Flake report: which fix ships first (repo: alpha) (kind: captain) (hold: ${enc("The report is ready. Which fix ships first? (A, recommended) the download race; (B) the timezone default.")}) (hold-kind: captain)`,
    `  Captain hold set: ${day(0)}`,
    `  Captain hold origin: ${T.scout}`,
    "",
    "## Done",
  ].join("\n")));
  const reportCall = idea.locator(`.task-card[data-task="${T.scout}"] .ask-card[data-ask="hold:${REPORT_CALL}"]`);
  await reportCall.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(reportCall).toContainText("Needs you", { timeout: 10000 });
  await expect(reportCall.getByRole("radio", { name: /the download race/ })).toBeChecked();
  expect(await page.evaluate(() => (window as any).__c12)).toBe("same page"); // no reload
  await reportCall.scrollIntoViewIfNeeded();
  await shot(page, CP, "j10-live-card-and-report-call");

  const quiet = await nearOn(page, QUIET);
  const nudge = quiet.locator(`[data-nudge="idea_quiet:${QUIET}"]`);
  await expect(nudge).toContainText("Still want this?", { timeout: 15000 });
  await shot(page, CP, "j10-still-want-this");
  await nudge.getByRole("button", { name: "Pause" }).click();
  await waitUntil(async () => (await call("GET", `/api/missions/${QUIET}`)).body.state === "paused");

  const tray = page.locator('[data-rail="nudges"]');
  const done = tray.locator(`[data-nudge="task_done:${LANDED}"]`);
  await expect(done).toContainText("Done: how did it land?", { timeout: 15000 });
  await done.getByRole("button", { name: /Didn't land/ }).click();
  await done.getByPlaceholder(/What didn't land/).fill("The PDF totals row wraps on A4");
  await shot(page, CP, "j10-feedback");
  await done.getByRole("button", { name: "Send 👎" }).click();
  await expect(done).toHaveCount(0);
  const fb = ((await call("GET", `/api/notes?task=${LANDED}`)).body as any[]).find((n) => n.tags?.includes("feedback"));
  expect(fb?.bullets).toEqual(["Feedback: didn't land well", "The PDF totals row wraps on A4"]);
  expect(await page.evaluate(() => (window as any).__c12)).toBe("same page");
});

test("J11 the knowledge home: the old bookmarks land in Search, and one search finds the day's decision and note", async ({ page }) => {
  watch(page);
  await page.goto("/#/memory");
  await expect(page).toHaveURL(/#\/knowledge/);
  await expect(page.getByTestId("knowledge-page")).toBeVisible();
  await page.goto("/#/artifacts");
  await expect(page).toHaveURL(/#\/knowledge/);
  await expect(page.getByTestId("knowledge-page")).toBeVisible();
  await page.goto("/#/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Search/ }).click();
  await page.getByTestId("knowledge-search").fill("quillback");
  const kinds = page.getByTestId("knowledge-row");
  await expect(kinds.filter({ hasText: "Idea note: totals match the screen" }).first()).toBeVisible();
  await expect(kinds.filter({ hasText: /recommendations|quillback/ }).first()).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, CP, "j11-one-search");
});

test("J12 no chat needed: the day never opened Firstmate's worker route nor sent its pane a reply or a key", async () => {
  expect(controls.size).toBeGreaterThan(0);
  expect(visited.length).toBeGreaterThan(10);
  const routes = visited.map((u) => decodeURIComponent(new URL(u).hash));
  for (const c of controls) expect(routes.filter((r) => r.startsWith(`#/worker/${c}`))).toEqual([]);
  const intents = ((await call("GET", "/api/intents?limit=1000")).body as { kind: string; target: string; created: string }[]).filter((i) => i.created >= started);
  expect(intents.filter((i) => i.kind === "reply")).toEqual([]);
  expect(intents.filter((i) => controls.has(i.target))).toEqual([]);
  const kinds = [...new Set(intents.map((i) => i.kind))].sort();
  for (const k of ["answer_ask", "answer_prompt", "create_task", "steer_task"]) expect(kinds).toContain(k);
  const st = await herdr("fake.state");
  const panes = new Set([...controls].map((c) => c.split(":").slice(1).join(":")));
  for (const list of [st.keys, st.prompts, st.inputs, st.typed]) expect((list ?? []).filter((k: any) => panes.has(k.target))).toEqual([]);
  fs.mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "test-results", "c12-j12-no-chat.txt"),
    `Firstmate control panes: ${[...controls].join(", ")}\nroutes visited (${routes.length}):\n${[...new Set(routes)].join("\n")}\n\nintents since ${started}: ${intents.length}, kinds: ${kinds.join(", ")}\nreply intents: 0; intents to Firstmate: 0; keys, prompts, inputs or text typed into Firstmate's pane: 0\n`);
});
