// The map as the control plane, closing two gaps from the CP8 live smoke: Firstmate's reply to a map request
// (fm-inbox.sh reply) shows on the card the request became, a new idea, an existing idea, then the task it
// became, until the captain dismisses it; and the hub's ticker and a task card's "Now" never show a raw tool
// call such as `ScheduleWakeup: {"stop":true}`. Runs on the sandbox daemon with a fixture FM_HOME, the real
// vendored fm-inbox.sh and the fake Herdr.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { buildFirstmateHome, FIXTURE_CREW_PANES, FIXTURE_TASKS as T } from "./crew-fixture";
import { call, herdr, PORT, waitUntil, openIdea } from "./map-seed";
import { shot } from "./shot";
import { composeTask, newInput } from "./new-box";

const sandbox = `/tmp/joyride-e2e-${PORT}`;
const env: Record<string, string> = JSON.parse(fs.readFileSync(`${sandbox}/env.json`, "utf8"));
const home = path.join(env.JOYRIDE_RUNTIME, "firstmate");
const IDEA = "replies-export";
const CP = "CP8";
const CREW_SESSION = "c8e00000-0000-4000-8000-000000000008";
const RAW = 'ScheduleWakeup: {"stop":true}';
let fmInbox = "";
let fmPane: string | null = null;
const created: string[] = [];

function noteId(requestId: string): string {
  for (const dir of [path.join(home, "state", "inbox"), path.join(home, "state", "inbox", "handled")]) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith(".note"))) {
      const text = fs.readFileSync(path.join(dir, n), "utf8");
      if (text.includes(`request_id=${requestId}`)) return text.match(/^id=(.+)$/m)![1];
    }
  }
  throw new Error(`no inbox note for ${requestId}`);
}
/** Firstmate answers the note with its own intake script, as it does live. */
function reply(requestId: string, text: string) {
  if (!home.startsWith(`${sandbox}/`)) throw new Error("refusing: FM_HOME is not in the sandbox");
  execFileSync(fmInbox, ["reply", noteId(requestId), text], { env: { ...process.env, FM_HOME: home } });
}
async function request(brief: string) {
  return waitUntil(async () => {
    const list = (await call<any[]>("GET", "/api/intents?kind=create_task&limit=5")).body;
    return list.find((x) => x.payload?.brief === brief && x.status === "sent") ?? null;
  }, 15000);
}
/** Hook events from the ship task's crewmate, as the global hooks would write them. */
function crewEvents(evs: { type: string; data: Record<string, unknown> }[]) {
  const dir = path.join(env.JOYRIDE_RUNTIME, "events");
  if (!dir.startsWith(sandbox)) throw new Error("refusing: event log is not in the sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const lines = evs.map((e, i) => JSON.stringify({
    ts: new Date(Date.now() - (evs.length - i) * 1000).toISOString(), id: `ev_e2e_replies_${PORT}_${Date.now()}_${i}`, source: "hook.claude", type: e.type,
    session: CREW_SESSION, agent: "claude", cwd: "/tmp/joyride-fixture-repos/alpha", data: e.data,
  }));
  fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
}
async function zoom(page: Page, level: "Far" | "Mid" | "Near") {
  await page.getByRole("radio", { name: level }).click();
  await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", level.toLowerCase());
}
/** Work for Firstmate through New, opened by the #/compose link the test just followed. */
async function compose(page: Page, text: string) {
  await expect(newInput(page)).toBeFocused();
  return composeTask(page, text);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(home.startsWith(`${sandbox}/`)).toBe(true);
  if ((await call("GET", `/api/missions/${IDEA}`)).status === 404) await call("POST", "/api/missions", { id: IDEA, title: "Export the report with totals", goal: "Analysts export the report as CSV with a totals row.", repos: ["/tmp/joyride-fixture-repos/alpha"] });
  else await call("PUT", `/api/missions/${IDEA}`, { archive: false });
  buildFirstmateHome(home, IDEA);
  fmInbox = path.join((await call("GET", "/api/firstmate/status")).body.vendor.path, "bin", "fm-inbox.sh");
  expect(fs.existsSync(fmInbox)).toBe(true);
  const wt = (await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body?.worktree)) as string;
  const st = await herdr("fake.state");
  if (st.panes.some((p: any) => p.pane_id === FIXTURE_CREW_PANES.ship)) await herdr("fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship });
  await herdr("fake.add_pane", {
    workspace_id: "w90", pane_id: FIXTURE_CREW_PANES.ship, cwd: path.join(wt, "src"), agent: "claude", agent_status: "working", title: "CSV crewmate", label: "alpha-worktrees",
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: CREW_SESSION },
  });
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.workers.length === 1);
  await waitUntil(async () => (await call("GET", `/api/firstmate/tasks/${T.ship}`)).body.mission === IDEA);
});

test.afterAll(async () => {
  await herdr("fake.close_pane", { pane_id: FIXTURE_CREW_PANES.ship }).catch(() => {});
  if (fmPane) await herdr("fake.close_pane", { pane_id: fmPane }).catch(() => {});
  buildFirstmateHome(home, IDEA);
  for (const id of [IDEA, ...created]) await call("PUT", `/api/missions/${id}`, { archive: true });
});

test("a request that started a new idea: Firstmate's reply sits on that idea's card until the captain dismisses it", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.goto("/#/compose");
  const ghost = await compose(page, "Task: Smoke reply pong");
  await expect(ghost.getByRole("list", { name: "Progress" })).toBeVisible();
  const it = await request("Task: Smoke reply pong");
  expect(it.result).toMatchObject({ created_idea: true, via: "inbox" });
  const mission = it.result.mission as string;
  created.push(mission);

  reply(it.id, "pong. No task needed: this was a smoke check.");
  // The ghost shows the reply while it is up; the idea's card keeps it after the ghost leaves.
  await expect(ghost.locator(".ghost-reply")).toContainText("pong. No task needed", { timeout: 12000 });
  const idea = page.locator(`.mission-node[data-mission="${mission}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  const card = idea.locator(`.fm-reply[data-reply="${it.id}"]`);
  await expect(card).toContainText("Firstmate replied");
  await expect(card.locator(".fm-reply-body")).toHaveText("pong. No task needed: this was a smoke check.");
  await expect(card.locator(".fm-reply-asked")).toHaveText("You asked: Task: Smoke reply pong");
  await expect(ghost).toBeHidden({ timeout: 20000 });
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "reply-new-idea-near");

  // Mid zoom: one quiet line.
  await zoom(page, "Mid");
  await expect(idea.locator(`.fm-reply.line[data-reply="${it.id}"]`)).toContainText("Firstmate replied pong.");
  await shot(page, CP, "reply-new-idea-mid");

  // It lives on the daemon, not in this tab: a reload keeps it.
  await page.reload();
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Dismiss Firstmate's reply" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(idea).toBeVisible();
  await expect(page.locator(`.fm-reply[data-reply="${it.id}"]`)).toHaveCount(0);
  expect((await call<any[]>("GET", "/api/firstmate/replies")).body.some((r) => r.request === it.id)).toBe(false);
});

test("a request placed into an existing idea: the reply sits on the idea, then on the task the request became", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/#/compose?idea=${IDEA}`);
  const ghost = await compose(page, "Task: Round the totals row to cents");
  await expect(ghost.getByRole("list", { name: "Progress" })).toBeVisible({ timeout: 8000 });
  const it = await request("Task: Round the totals row to cents");
  expect(it).toMatchObject({ target: IDEA, result: { mission: IDEA, created_idea: false } });
  await ghost.getByRole("button", { name: "Hide this request" }).click();

  reply(it.id, "Briefing a ship task for this in Export the report with totals.");
  const idea = page.locator(`.mission-node[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  const onIdea = idea.locator(`.mn-detail > .fm-reply[data-reply="${it.id}"]`);
  await expect(onIdea.locator(".fm-reply-body")).toHaveText("Briefing a ship task for this in Export the report with totals.", { timeout: 12000 });
  await onIdea.scrollIntoViewIfNeeded();
  await shot(page, CP, "reply-existing-idea");

  // Firstmate writes the task, keeping the request marker in its brief: the reply moves onto that task's card.
  const id = "jr-round-totals";
  const backlog = path.join(home, "data", "backlog.md");
  fs.writeFileSync(backlog, fs.readFileSync(backlog, "utf8").replace("## In flight\n", `## In flight\n\n- [ ] ${id} - Task: Round the totals row to cents (repo: alpha) (kind: ship) (since ${new Date().toISOString().slice(0, 10)})\n`));
  fs.mkdirSync(path.join(home, "data", id), { recursive: true });
  fs.writeFileSync(path.join(home, "data", id, "brief.md"), `# Task\n## Captain's intent\njoyride-mission: ${IDEA}\njoyride-request: ${it.id}\n\nRound the totals row.\n`);
  const task = idea.locator(`.task-card[data-task="${id}"]`);
  await expect(task.locator(`.fm-reply[data-reply="${it.id}"]`)).toContainText("Briefing a ship task", { timeout: 12000 });
  await expect(onIdea).toHaveCount(0);
  await task.scrollIntoViewIfNeeded();
  await shot(page, CP, "reply-on-task-card");

  await zoom(page, "Mid");
  await expect(idea.locator(`.task-row[data-task="${id}"] .fm-reply.line`)).toContainText("Firstmate replied Briefing");
  await zoom(page, "Near");
  await task.getByRole("button", { name: "Dismiss Firstmate's reply" }).click();
  await expect(page.locator(`.fm-reply[data-reply="${it.id}"]`)).toHaveCount(0);
});

test("the hub's ticker and a task card's Now never show a raw tool call", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Back to the fixture's four tasks, so the ship task leads the ticker.
  buildFirstmateHome(home, IDEA);
  await waitUntil(async () => (await call<any[]>("GET", "/api/firstmate/tasks")).body.length === 4);
  // Firstmate is running (the ticker only shows then), and the ship crewmate's last action is a raw tool call.
  const st = await herdr("fake.state");
  if (!st.panes.some((p: any) => p.name === "firstmate" || p.label === "firstmate")) {
    fmPane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-firstmate", agent: "claude", agent_status: "working", name: "firstmate", title: "Firstmate", label: "firstmate" })).pane.pane_id;
  }
  crewEvents([
    { type: "tool.pre", data: { tool: "Bash", input: { command: "npm test -- csv" } } },
    { type: "tool.pre", data: { tool: "ScheduleWakeup", input: { stop: true } } },
  ]);
  const ship = `local:${FIXTURE_CREW_PANES.ship}`;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === ship)?.current_action === RAW, 10000);

  await page.goto("/");
  const hub = page.getByTestId("firstmate-node");
  await expect(hub).toHaveAttribute("data-firstmate", "running", { timeout: 15000 });
  await hub.locator(".fm-title").focus();
  await zoom(page, "Near");
  const ticker = hub.locator('[data-fm="ticker"]');
  await expect(ticker.locator(".fm-tick-who")).toHaveText("Add a CSV export button with totals");
  await expect(ticker.locator(".fm-tick-what")).not.toBeEmpty();
  await expect(ticker).not.toContainText("ScheduleWakeup");
  await expect(ticker).not.toContainText('{"stop"');
  await shot(page, CP, "hub-ticker-readable");

  const idea = page.locator(`.mission-node[data-mission="${IDEA}"]`);
  await idea.locator(".mn-title").focus();
  await zoom(page, "Near");
  const card = idea.locator(`.task-card[data-task="${T.ship}"]`);
  await expect(card.locator(".tc-now")).toBeVisible();
  await expect(card.locator(".tc-now")).not.toContainText("ScheduleWakeup");
  // Opened, the card shows its crewmate's line, also without the raw call.
  await openIdea(page, IDEA);
  await expect(card.locator(".wl-action")).toHaveText("No action reported");
  await expect(card).not.toContainText('{"stop"');
  await card.scrollIntoViewIfNeeded();
  await shot(page, CP, "task-card-now-readable");
});
