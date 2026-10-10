import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { call, PORT, seedWorld, waitUntil, W, raise, guardRequest, FAKE_SESSIONS, openIdea } from "./map-seed";
import { buildFirstmateHome, FIXTURE_TASKS } from "./crew-fixture";
import { addAskFixtures, ASK_TASKS } from "./asks-fixture";
import { herdr } from "./map-seed";
import { liveStdout } from "../fixtures/quota";
import { CLAUDE_PERMISSION_MENU } from "../fixtures/fake-herdr";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { shot } from "./shot";
import { panTo } from "./chart-pan";
import type { NewReceipt, ScreenContext } from "../../src/shared/freeform";

const cp = "new-freeform";
const proofFile = "docs/reports/new-freeform-browser.json";
const proofs: { text: string; test: string; receipt: NewReceipt; screenshot: string; animation: string; context?: ScreenContext }[] = [];
const env: Record<string, string> = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${PORT}/env.json`, "utf8"));
const home = env.FM_HOME;
const box = (p: Page) => p.locator('[data-rail="new"]');
const outcome = (p: Page) => p.locator('[data-new-result]');
async function send(page: Page, text: string, idea?: string, failure = false): Promise<NewReceipt> {
  await page.goto(idea ? `/#/compose?idea=${idea}` : "/#/compose");
  await expect(box(page).getByRole("textbox", { name: "New", exact: true })).toBeFocused();
  return sendHere(page, text, failure);
}
async function sendHere(page: Page, text: string, failure = false): Promise<NewReceipt> {
  await box(page).getByRole("textbox", { name: "New", exact: true }).fill(text);
  await expect(box(page).locator('select,input[type="radio"],.nb-option')).toHaveCount(0);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await box(page).getByRole("textbox", { name: "New", exact: true }).press("Enter");
  const received = await response;
  const r: NewReceipt = await received.json();
  if (failure) expect(r.state, r.message).toBe("failed");
  else expect(r.state, r.message).not.toBe("failed");
  await recordProof(page, text, r, received.request().postDataJSON().context);
  return r;
}
async function settleFeedback(page: Page) {
  await expect(outcome(page)).toHaveCSS("opacity", "1");
  await page.waitForTimeout(850);
  const landing = await outcome(page).evaluate((e) => ({ opacity: getComputedStyle(e).opacity, color: getComputedStyle(e).color }));
  expect(landing.opacity).toBe("1");
}
async function frameLanding(page: Page, r: NewReceipt) {
  if (!r.landing || !await page.locator(".map-viewport").isVisible()) return;
  const e = r.landing;
  const target = page.locator(e.kind === "note" ? `[data-board-item="${e.id}"]` : e.kind === "idea" ? `[data-mission="${e.id}"]` : `[data-region="lens:${e.id}"]`).first();
  if (!await target.isVisible()) return;
  const [node, viewport] = await Promise.all([target.boundingBox(), page.locator(".map-viewport").boundingBox()]);
  if (node && viewport && node.width < viewport.width - 40 && node.height < viewport.height - 40) await panTo(target);
}
async function recordProof(page: Page, text: string, r: NewReceipt, context: ScreenContext) {
  await expect(outcome(page)).toBeVisible();
  const name = `action-${proofs.length + 1}`;
  const animation = await outcome(page).evaluate((e) => getComputedStyle(e).animationName);
  await settleFeedback(page);
  await frameLanding(page, r);
  await shot(page, cp, name);
  proofs.push({ text, test: test.info().title, receipt: r, screenshot: `../checkpoints/${cp}/${name}.png`, animation, context });
  fs.writeFileSync(proofFile, JSON.stringify(proofs, null, 2));
}
async function undo(page: Page) { await outcome(page).getByRole("button", { name: "Undo", exact: true }).click(); await expect(outcome(page)).toHaveAttribute("data-state", "undone"); }
const notes = async () => (await call("GET", "/api/notes?include_archived=1&limit=10000")).body as { id: string; title: string; bullets: string[]; scope: string; status: string }[];
async function resolvedProof(page: Page, id: string) {
  const i = proofs.findIndex((p) => p.receipt.id === id); if (i < 0) throw new Error("Missing initial proof.");
  const name = `action-${i + 1}-result`;
  proofs[i].receipt = (await call("GET", `/api/new/${id}`)).body;
  await settleFeedback(page); await frameLanding(page, proofs[i].receipt); await shot(page, cp, name);
  proofs[i].screenshot = `../checkpoints/${cp}/${name}.png`;
  fs.writeFileSync(proofFile, JSON.stringify(proofs, null, 2));
}

// The fake Herdr serves only this daemon's private socket. No lifecycle action reaches default.
test.beforeAll(async () => {
  expect(home).toContain(`/tmp/joyride-e2e-${PORT}/runtime/`);
  expect(home).not.toBe(path.resolve(".joyride/firstmate"));
  buildFirstmateHome(home, "csv-export");
  await seedWorld();
  await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: liveStdout(Date.now()) } });
  await herdr("fake.set_menu", { pane_id: "w1:p2", menu: CLAUDE_PERMISSION_MENU, status: "blocked" });
  await herdr("fake.set_status", { pane_id: "w2:p1", status: "idle" });
  await call("POST", "/api/lenses", { id: "new-core", title: "New Core" });
  await call("POST", "/api/lenses", { id: "new-research", title: "New Research" });
});

test("no choices, single submission, note/list/link animations, canvas landings and Undo", async ({ page }) => {
  for (const [text, animation] of [["note: freeform Friday release", "note"], ["Note: Friday release\n## Verification\n[ ] Review totals\nhttps://example.com/spec", "note"], ["List: build, test and tag", "list"], ["Make a release list: build, test and tag", "list"], ["artifact:rep-launch", "link"], ["Link: https://claude.ai/public/artifacts/freeform", "link"], ["Link: https://example.com/report.pdf", "link"]]) {
    const r = await send(page, text, "report-scaffold");
    expect(r.route).toBe("deterministic"); expect(r.animation).toBe(animation); expect(r.undo).toBe(true);
    const n = (await notes()).find((n) => n.id === r.landing?.id)!;
    expect(n.scope).toBe("mission:report-scaffold");
    if (text.startsWith("Make a release")) expect(n.title).toBe("Release list");
    if (text.startsWith("Note: Friday")) expect(n.bullets).toEqual(["Friday release", "## Verification", "[ ] Review totals", "https://example.com/spec"]);
    await outcome(page).getByRole("button", { name: "Show on map" }).click();
    await expect(page.locator(`[data-board-item="${n.id}"]`).first()).toBeVisible();
    await settleFeedback(page); await panTo(page.locator(`[data-board-item="${n.id}"]`).first());
    if (text.startsWith("Note: Friday")) {
      const card = page.locator(`[data-board-item="${n.id}"]`).first();
      await expect(card.locator(".nk-heading")).toHaveText("Verification");
      await expect(card).not.toContainText("## Verification");
      await expect(card.getByRole("link", { name: /Spec/ })).toBeVisible();
    }
    await shot(page, cp, `animation-${animation}-${r.id.slice(0, 6)}`);
    await undo(page);
    expect((await notes()).some((x) => x.id === n.id)).toBe(false);
  }
});

test("groups: create, rename, merge, delete, place and reset, plus idea/task/session moves and Undo", async ({ page }) => {
  const cases = [
    "Create a group called Experiments", "Rename New Research to Studies", "Merge New Research into New Core", "Delete group New Research", "Move group New Core to 1200 0", "Reset group New Core",
    "Move OAuth login flow to New Core", "Move task jr-csv-export to Scaffold the report page",
    "Move Idempotent sync job to New Core", "Move Idempotent sync job to Scaffold the report page", "Move Idempotent sync job to Unfiled",
    "Make a group Sandbox with OAuth login flow",
    "Make a group Session sandbox with Idempotent sync job",
  ];
  for (const [i, text] of cases.entries()) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); expect(r.undo, text).toBe(true);
    await shot(page, cp, `map-action-${i}`); await undo(page);
    // The missions cache re-reads authored files after Undo.
    await page.waitForTimeout(350);
  }
});

test("notes and lists: edit, tick, untick, add, rename, remove, move, delete and restore", async ({ page }) => {
  const created = await call("POST", "/api/notes", { title: "Release list", bullets: ["[ ] build", "[x] test", "[ ] tag"], global: true });
  const id = created.body.id;
  for (const [i, text] of ["Edit list Release list: ship, celebrate", "Tick build in Release list", "Untick test in Release list", "Add item docs to Release list", "Rename item tag in Release list: publish", "Remove item tag from Release list", "Move list Release list to New Core", "Delete list Release list"].entries()) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); await shot(page, cp, `list-action-${i}`); await undo(page);
    expect((await notes()).find((n) => n.id === id)?.bullets).toEqual(["[ ] build", "[x] test", "[ ] tag"]);
  }
  await call("POST", `/api/notes/${id}/archive`, {});
  await send(page, "Restore list Release list"); expect((await notes()).find((n) => n.id === id)?.status).toBe("active"); await undo(page);
});

test("idea creation, title, goal, pause, resume, drop, archive and unarchive", async ({ page }) => {
  for (const [i, text] of ["Create an empty idea: Accessibility", "Rename idea OAuth login flow to Login", "Set OAuth login flow goal: Accessible login", "Pause idea OAuth login flow", "Resume idea OAuth login flow", "Drop idea OAuth login flow", "Finish idea OAuth login flow", "Archive idea OAuth login flow"].entries()) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); await shot(page, cp, `idea-action-${i}`); if (r.undo) await undo(page); await page.waitForTimeout(350);
  }
  await call("PUT", "/api/missions/oauth-login", { archive: true });
  await send(page, "Unarchive idea OAuth login flow"); expect((await call("GET", "/api/missions/oauth-login")).body.archive).toBe(false); await undo(page);
  await call("PUT", "/api/missions/oauth-login", { archive: false });
});

test("navigation, zoom, focus, archive visibility, search and filters are reversible browser actions", async ({ page }) => {
  for (const [i, text] of ["Go to Board", "Open Map", "Open Agents", "Open Settings", "Open Artifacts", "Open Search", "Open Setup", "Open Usage", "Open Evidence", "Open Guide", "Open Start session", "Open OAuth login flow", `Open session codex:${FAKE_SESSIONS.codexIdle}`, "Zoom far", "Zoom mid", "Zoom near", "Fit the map", "Focus New Core", "Focus OAuth login flow", "Clear focus", "Show archived ideas", "Hide archived ideas", "Search for export", "Show running agents", "Show crew agents", "Show suggested ideas"].entries()) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); expect(r.ui.length, text).toBe(1); await shot(page, cp, `view-action-${i}`); await undo(page);
  }
});

test("palette, attention rail, sheet close, native preferences and an already uploaded image are reachable from text", async ({ page }) => {
  await send(page, "Open command palette"); await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape"); await undo(page);
  await send(page, "Show approvals");
  await send(page, "Close this sheet"); expect(page.url()).toContain("#/map");
  await send(page, "Hide the rail");
  await expect(page.locator(".rail")).toBeHidden();
  await expect(page.locator("[data-new-floating]")).toContainText("Changed the rail.");
  await undo(page); await expect(page.locator(".rail")).toBeVisible();
  await send(page, "Show the rail"); await undo(page);
  fs.writeFileSync(path.join(home, "data", "captain.md"), "# Private test preferences\nLocal delivery only.\n");
  await send(page, "Open Firstmate captain.md file");
  const image = await call("POST", "/api/uploads", { name: "freeform.png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=" });
  expect(image.status).toBe(200);
  const r = await send(page, `Reply to worker ${W.codex} with image ${image.body.path}: Inspect this saved image`);
  expect(r.route).toBe("deterministic"); expect(r.undoLimit).toContain("cannot be undone");
});

test("words typed during a submission survive its response and become their own request", async ({ page }) => {
  await page.route("**/api/new", async (route) => { const response = await route.fetch(); await new Promise((r) => setTimeout(r, 800)); await route.fulfill({ response }); });
  await page.goto("/#/compose?idea=csv-export");
  const input = box(page).getByRole("textbox", { name: "New", exact: true });
  await expect(input).toBeFocused(); await input.fill("Task: draft before model reply");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await input.press("Enter"); await expect(box(page).getByRole("button", { name: "Understanding…" })).toBeDisabled();
  await input.fill("Note: next words remain intact!");
  expect((await (await response).json()).route).toBe("firstmate");
  await expect(input).toHaveValue("Note: next words remain intact!");
  await expect(box(page).getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  const next = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
  await input.press("Enter"); const r = await (await next).json(); expect(r.route).toBe("deterministic");
  expect((await notes()).find((n) => n.id === r.landing.id)?.bullets).toEqual(["next words remain intact!"]);
  await shot(page, cp, "draft-preserved-during-submission");
});

test("repo and Unfiled renames, return home, textual Undo, open cards and fleet retirement proposal", async ({ page }) => {
  await send(page, "Rename alpha to Product repo"); await undo(page); await page.waitForTimeout(350);
  const moved = await send(page, "Move Make the nightly sync idempotent to New Core");
  await page.waitForTimeout(350);
  await send(page, "Move Make the nightly sync idempotent back to its repo"); await undo(page); await page.waitForTimeout(350);
  const unfiled = await send(page, "Move Idempotent sync job to Unfiled"); await page.waitForTimeout(350);
  await send(page, "Rename beta to Sandbox loose sessions"); await undo(page);
  expect((await call("POST", `/api/new/${unfiled.id}/undo`, {})).status).toBe(200);
  expect((await call("POST", `/api/new/${moved.id}/undo`, {})).status).toBe(200); await page.waitForTimeout(350);
  await send(page, "Move group New Core to 1400 50");
  await send(page, "Undo the last change");
  const n = (await call("POST", "/api/notes", { title: "Openable canvas note", bullets: ["Read this"], global: true })).body;
  await send(page, "Open Openable canvas note"); await expect(page.locator(`[data-board-item="${n.id}"]`).first()).toBeVisible(); await undo(page);
  await send(page, "Edit note Openable canvas note: Read the export totals");
  expect((await call("GET", `/api/notes/${n.id}`)).body.bullets).toEqual(["Read the export totals"]); await undo(page);
  expect((await call("GET", `/api/notes/${n.id}`)).body.bullets).toEqual(["Read this"]);
  for (const text of [`Open worker ${W.codex}`, `Open task ${FIXTURE_TASKS.ship}`, `Hand back ${W.codex}`, `Save and close ${W.codex}`]) await send(page, text);
  const proposal = (await call("GET", "/api/fleet/prunes")).body.find((p: { worker: string; status: string }) => p.worker === W.codex && p.status === "pending");
  expect(proposal).toBeTruthy(); await send(page, `Answer ${proposal.id}: B`);
  expect((await call("GET", "/api/fleet/prunes")).body.find((p: { id: string }) => p.id === proposal.id).status).toBe("rejected");
  const refused = await send(page, `Move to Herdr ${W.codex}`, undefined, true);
  expect(refused.message).toContain("already runs in Herdr");
});

test("a private idle terminal process moves into the sandbox Herdr through New", async ({ page }) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (!child.pid) throw new Error("Private dummy process did not start.");
  const registry = path.join(env.JOYRIDE_CLAUDE_DIR, "sessions", `${child.pid}.json`);
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ pid: child.pid, sessionId: "11111111-2222-4333-8444-555555555555", cwd: env.JOYRIDE_HOME, name: "Private terminal proof", status: "idle", updatedAt: Date.now() }));
  try {
    const worker = `local:pid:${child.pid}`;
    await waitUntil(async () => (await call("GET", "/api/workers")).body.some((w: { id: string }) => w.id === worker));
    const r = await send(page, `Move to Herdr ${worker}`);
    expect(r.route).toBe("deterministic"); expect(r.undoLimit).toContain("started processes");
    const sent = (await call("GET", "/api/intents?kind=move_to_herdr&limit=1")).body[0];
    expect(sent.result.moved_from_pid).toBe(child.pid);
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally { child.kill("SIGTERM"); fs.rmSync(registry, { force: true }); }
});

test("this resolves the selected idea and the agent receives actual map, hover and visible context", async ({ page }) => {
  await page.goto("/#/map"); await openIdea(page, "oauth-login");
  const input = box(page).getByRole("textbox", { name: "New", exact: true });
  for (const text of ["Move this idea to New Core", "Summarize the selected idea and its visible work"]) {
    await input.fill(text);
    const pending = page.waitForResponse((r) => r.url().endsWith("/api/new") && r.request().method() === "POST");
    await input.press("Enter"); const response = await pending;
    const r: NewReceipt = await response.json(); const context = response.request().postDataJSON().context;
    expect(context.selected).toMatchObject({ kind: "idea", id: "oauth-login" });
    expect(context.hovered).toBeTruthy(); expect(context.view.s).toBeGreaterThan(0); expect(context.visible.length).toBeGreaterThan(0);
    expect(r.state, r.message).not.toBe("failed"); await recordProof(page, text, r, context);
    if (r.route === "deterministic") {
      expect((await call("GET", "/api/missions/map")).body.ideas.find((i: { id: string }) => i.id === "oauth-login").group).toBe("new-core");
    } else {
      expect(r.route).toBe("agent");
      const launch = (await call("GET", "/api/intents?kind=launch_session&limit=10")).body.find((i: { payload: { env?: { JOYRIDE_NEW_JOB?: string } } }) => i.payload.env?.JOYRIDE_NEW_JOB === r.id);
      expect(launch.payload.prompt).toContain(JSON.stringify(context, null, 2));
      await call("POST", `/api/new/jobs/${r.id}/complete`, { message: "Context bundle received." });
      await expect(outcome(page)).toHaveAttribute("data-state", "done"); await resolvedProof(page, r.id);
    }
    await undo(page); await page.waitForTimeout(350);
  }
});

test("judgement jobs apply structured fields, batch grouping, list ordering, artifact filing, settings and quota reads", async ({ page }) => {
  test.setTimeout(90000);
  const list = (await call("POST", "/api/notes", { title: "Agent priority list", bullets: ["[ ] docs", "[ ] test"], mission: "report-scaffold" })).body;
  const artifact = (await call("POST", "/api/artifacts", { title: "Agent filed report", url: "https://example.com/agent-filed" })).body;
  const cases = [
    { text: "Choose clearer evidence criteria and repositories for this idea", action: { kind: "resource", action: "edit-idea", target: "report-scaffold", payload: { done_when: [{ id: "new-proof", text: "Export test passes", kind: "test" }], repos: ["/tmp/joyride-fixture-repos/beta"] } } },
    { text: "Reorder Agent priority list by risk", action: { kind: "map", action: "edit-list", args: { note: list.id, items: ["[ ] test", "[ ] docs"] } } },
    { text: "Group related sessions based on their goals", action: { kind: "map", action: "new-session-group", args: { title: "Agent grouped sessions", session: `codex:${FAKE_SESSIONS.codexIdle}` } } },
    { text: "File this report under the login idea", action: { kind: "resource", action: "edit-artifact", target: artifact.id, payload: { mission: "oauth-login" } } },
    { text: "Choose a better default model effort for this UI", action: { kind: "resource", action: "settings", target: "", payload: { llm: { default: { effort: "low" } } } } },
    { text: "Open the evidence for this task", action: { kind: "ui", command: { action: "navigate", path: "evidence" } } },
    { text: "Refresh my usage", action: { kind: "ui", command: { action: "navigate", path: "usage" } } },
  ];
  for (const [i, example] of cases.entries()) {
    const r = await send(page, example.text, "report-scaffold"); expect(r.route, example.text).toBe("agent");
    expect((await call("POST", `/api/new/jobs/${r.id}/actions`, { request: `structured-${i}`, action: example.action })).status).toBe(200);
    if (i === 0) expect((await call("GET", "/api/missions/report-scaffold")).body.done_when).toContainEqual({ id: "new-proof", text: "Export test passes", kind: "test" });
    if (i === 0) expect((await call("GET", "/api/missions/report-scaffold")).body.repos).toEqual(["/tmp/joyride-fixture-repos/beta"]);
    if (i === 1) expect((await call("GET", `/api/notes/${list.id}`)).body.bullets).toEqual(["[ ] test", "[ ] docs"]);
    if (i === 2) expect((await call("GET", "/api/missions/map")).body.groups.find((g: { title: string }) => g.title === "Agent grouped sessions").sessions).toContain(`codex:${FAKE_SESSIONS.codexIdle}`);
    if (i === 3) expect((await call("GET", `/api/artifacts/${artifact.id}`)).body.mission).toBe("oauth-login");
    if (i === 4) expect((await call("GET", "/api/system/config")).body.config.llm.default.effort).toBe("low");
    if (example.text === "Refresh my usage") await call("GET", "/api/usage?fresh=1");
    await call("POST", `/api/new/jobs/${r.id}/complete`, { message: `Completed: ${example.text}` });
    await expect(outcome(page)).toHaveAttribute("data-state", "done");
    await resolvedProof(page, r.id);
    await shot(page, cp, `judgement-result-${i}`); await undo(page); await page.waitForTimeout(350);
  }
});

test("worker reply, offered permission, fleet membership, focus, hidden work and a new contextual session", async ({ page }) => {
  const workers = (await call("GET", "/api/workers")).body as { id: string; title: string; session: string }[];
  const codex = workers.find((w) => w.id === W.codex)!;
  const blocked = workers.find((w) => w.id === W.blocked)!;
  for (const text of [`Reply to worker ${W.codex}: Continue carefully`, `Allow prompt ${W.blocked}`, `Exclude ${W.codex}`, `Include ${W.codex}`, `Focus pane ${W.codex}`, `Hide ${codex.title}`]) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); if (r.undo) await undo(page);
  }
  await call("POST", "/api/missions/hide", { key: codex.session });
  const r = await send(page, `Unhide ${codex.title}`); expect(r.undo).toBe(true); await undo(page); await call("POST", "/api/missions/unhide", { key: codex.session });
  const launched = await send(page, "Start a session here", "report-scaffold");
  expect(launched.session).toMatch(/^claude:/); expect(launched.worker).toBeTruthy();
  expect((await call("GET", "/api/missions/report-scaffold")).body.sessions.some((s: { id: string }) => launched.session === `claude:${s.id}`)).toBe(true);
  await shot(page, cp, "contextual-session-start");
});

test("attention acknowledgement, Undo, snooze, and captain guard answer", async ({ page }) => {
  const a = await raise({ level: "L2", kind: "review", title: "Freeform review", why: "Review the result" });
  const r = await send(page, "Acknowledge Freeform review"); expect(r.undo).toBe(true); await undo(page);
  expect((await call("GET", `/api/attention/${a.id}`)).body.acknowledged).not.toBe(true);
  await send(page, "Snooze Freeform review for 10 minutes");
  await undo(page); expect(Date.parse((await call("GET", `/api/attention/${a.id}`)).body.snoozed_until)).toBeLessThan(Date.now());
  await call("POST", `/api/attention/${a.id}/label`, { label: "ack" });
  await send(page, "Undo acknowledgement Freeform review");
  expect((await call("GET", `/api/attention/${a.id}`)).body.resolution).not.toBe("acknowledged"); await undo(page);
  const g = await guardRequest("Freeform guard", "git push local-test");
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `guard:${g.id}`));
  await send(page, `Deny approval guard:${g.id}`);
  expect((await call("GET", `/api/guard/requests/${g.id}`)).body.decision).toBe("deny");
  await shot(page, cp, "attention-answer");
});

test("Firstmate receives the original task once, with its mission marker, in the private home", async ({ page }) => {
  const text = "Task: implement accessible export totals\njoyride-mission: csv-export";
  const before = (await call("GET", "/api/system/status")).body.models.llm.calls;
  const r = await send(page, text, "csv-export"); expect(r.route).toBe("firstmate"); expect(r.request).toBeTruthy();
  expect((await call("GET", "/api/system/status")).body.models.llm.calls).toBe(before);
  const intents = (await call("GET", `/api/intents/${r.request}`)).body;
  expect(intents).toMatchObject({ kind: "create_task", target: "csv-export", payload: { brief: text }, status: "sent" });
  const dir = path.join(home, "state", "inbox");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".note"));
  const matches = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).filter((s) => s.includes(`joyride-request: ${r.request}`));
  expect(matches).toHaveLength(1); expect(matches[0]).toContain(text); expect(matches[0]).toContain(`joyride-mission: csv-export`);
  await shot(page, cp, "firstmate-flight");
  const multiline = "Task:\nImplement multiline task delivery without a naming model";
  const count = (await call("GET", "/api/system/status")).body.models.llm.calls;
  const next = await send(page, multiline);
  expect(next.route).toBe("firstmate");
  expect((await call("GET", `/api/intents/${next.request}`)).body.payload).toMatchObject({ brief: multiline, title: "Implement multiline task delivery without a naming model" });
  expect((await call("GET", "/api/system/status")).body.models.llm.calls).toBe(count);
});

test("ordinary agent CLI edits are recorded automatically; an ended job becomes visibly failed and undoable", async ({ page }) => {
  const r = await send(page, "Find the newest export report here", "report-scaffold");
  const jobEnv = { ...process.env, ...env, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, JOYRIDE_NEW_JOB: r.id };
  const cli = (args: string[]) => JSON.parse(execFileSync(path.resolve("bin/joyride"), args, { env: jobEnv, encoding: "utf8" }));
  expect(() => execFileSync(path.resolve("bin/joyride"), ["restart"], { env: jobEnv, stdio: "pipe" })).toThrow();
  const note = cli(["map", "note", "Ordinary CLI result", "--idea", "report-scaffold", "--agent", "export-job"]);
  expect(note.provenance).toEqual({ type: "agent", ref: "cli:export-job" });
  const other = cli(["notes", "add", "--json", "--idea", "report-scaffold", "Notes CLI result"]);
  expect(other.provenance).toEqual({ type: "agent", ref: `cli:${r.session}` });
  cli(["api", "PUT", `/api/missions/report-scaffold`, JSON.stringify({ goal: "Recorded API goal" })]);
  const worker = (await call("GET", `/api/workers/${encodeURIComponent(r.worker!)}`)).body;
  await page.waitForTimeout(3100);
  await herdr("fake.set_status", { pane_id: worker.pane, status: "done" });
  await expect(outcome(page)).toHaveAttribute("data-state", "failed");
  await expect(outcome(page)).toContainText("ended before reporting");
  await resolvedProof(page, r.id);
  await shot(page, cp, "agent-failed-with-recorded-outcome");
  await undo(page);
  expect((await notes()).some((n) => n.id === note.id || n.id === other.id)).toBe(false);
  await expect.poll(async () => (await call("GET", "/api/missions/report-scaffold")).body.goal).not.toBe("Recorded API goal");
});

test("agent route carries screen context, records result on canvas and supports Undo", async ({ page }) => {
  const r = await send(page, "Link the artifact about exports here", "report-scaffold");
  expect(r.route).toBe("agent"); expect(r.state).toBe("running"); expect(r.session).toMatch(/^codex:/);
  await shot(page, cp, "agent-spinning-up");
  const action = { request: "link-found-report", action: { kind: "map", action: "link", args: { links: ["https://example.com/export-report"], title: "Export research", scope: "mission:report-scaffold" } } };
  const applied = await call("POST", `/api/new/jobs/${r.id}/actions`, action); expect(applied.status).toBe(200);
  expect((await call("POST", `/api/new/jobs/${r.id}/actions`, action)).body.id).toBe(applied.body.id);
  expect((await call("POST", `/api/new/jobs/${r.id}/actions`, { request: "permission", action: { kind: "intent", intent: "approve", target: "guard", payload: {} } })).status).toBe(400);
  await call("POST", `/api/new/jobs/${r.id}/complete`, { message: "Linked Export research in this idea." });
  await expect(outcome(page)).toHaveAttribute("data-state", "done");
  await resolvedProof(page, r.id);
  expect((await notes()).some((n) => n.id === applied.body.id && n.scope === "mission:report-scaffold")).toBe(true);
  await outcome(page).getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(`[data-board-item="${applied.body.id}"]`).first()).toBeVisible(); await shot(page, cp, "agent-result-on-canvas");
  await undo(page); expect((await notes()).some((n) => n.id === applied.body.id)).toBe(false);
});

test("reduced motion disables action animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await send(page, "note: reduced motion check", "report-scaffold");
  expect(await outcome(page).evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
  await shot(page, cp, "reduced-motion"); await undo(page);
});

test("receipt history survives reload and a previous agent finishes after a newer note", async ({ page }) => {
  const job = await send(page, "Find the newest export artifact and attach it here", "report-scaffold");
  expect(job.route).toBe("agent");
  const note = await send(page, "Note: newer request while research runs", "report-scaffold");
  await page.reload();
  await expect(outcome(page)).toHaveAttribute("data-state", "done");
  await expect(outcome(page)).toContainText(note.message);
  await box(page).locator(".nb-history summary").click();
  const older = box(page).locator(`[data-new-history="${job.id}"]`);
  await expect(older.getByRole("button", { name: "Undo" })).toBeDisabled();
  await call("POST", `/api/new/jobs/${job.id}/complete`, { message: "Older research completed." });
  await expect(older).toContainText("Older research completed.");
  await resolvedProof(page, job.id);
  await older.getByRole("button", { name: "Undo" }).click();
  await expect(outcome(page)).toHaveAttribute("data-state", "undone");
  expect((await call("GET", `/api/new/${note.id}`)).body.state).toBe("done");
  await shot(page, cp, "older-job-recovered-after-reload");
});

test("settings preserve nested values, artifacts register/edit/open/scan, and exact Undo restores authored data", async ({ page }) => {
  const config = (await call("GET", "/api/system/config")).body.config;
  for (const text of ["Disable notifications", "Enable notifications", "Set notification level L2", `Set Jev model ${config.jev.model}`, `Set default model ${config.llm.default.model}`]) {
    const r = await send(page, text); expect(r.route).toBe("deterministic");
    const changed = (await call("GET", "/api/system/config")).body.config;
    expect(changed.usage).toEqual(config.usage); expect(changed.workers).toEqual(config.workers);
    if (r.undo) await undo(page);
    expect((await call("GET", "/api/system/config")).body.config).toEqual(config);
  }
  const registered = await send(page, "Register artifact: https://example.com/freeform-proof");
  expect(registered.undo).toBe(true); await undo(page);
  const artifact = await call("POST", "/api/artifacts", { id: "new-report", title: "New report", url: "https://example.com/new-report", summary: "Original" });
  expect(artifact.status).toBe(201);
  await send(page, "Edit artifact New report summary: Reviewed export totals");
  expect((await call("GET", `/api/artifacts/${artifact.body.id}`)).body.summary).toBe("Reviewed export totals");
  await undo(page); expect((await call("GET", `/api/artifacts/${artifact.body.id}`)).body.summary).toBe("Original");
  await send(page, "Open New report"); await expect(page).toHaveURL(new RegExp(`open=artifact%3A${artifact.body.id}`));
  await page.getByTestId("artifact-reader").getByRole("button", { name: "Close and return" }).click();
  await undo(page);
  await send(page, "Scan artifacts");
  await send(page, "Test notification");
});

test("proposal accept/reject/reopen/backfill use their owners and accepted canvas changes undo", async ({ page }) => {
  const dir = path.join(env.JOYRIDE_RUNTIME, "proposals", "missions"); fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const proposal = { id: "new-proposal", title: "Freeform proposed idea", goal: "Inspect exports", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["main"], sessions: [{ source: "claude", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }], first_ts: now, last_ts: now, status: "pending", reason: "New proof", merge_into: "csv-export", created: now };
  fs.writeFileSync(path.join(dir, "new-proposal.json"), JSON.stringify(proposal));
  for (const text of ["Accept proposal new-proposal", "Reject proposal new-proposal"]) {
    const r = await send(page, text); expect(r.route).toBe("deterministic"); expect(r.undo).toBe(true); await undo(page);
    expect((await call("GET", "/api/missions/proposals")).body.some((p: { id: string }) => p.id === proposal.id)).toBe(true);
  }
  await call("POST", "/api/missions/proposals/new-proposal/reject", { reason: "Fixture" });
  await send(page, "Reopen proposal new-proposal");
  expect((await call("GET", "/api/missions/proposals")).body.some((p: { id: string }) => p.id === proposal.id)).toBe(true);
  await send(page, "Scan for suggested ideas");
  await send(page, "Reverify OAuth login flow");
});

test("Firstmate updates, task steering, note relay, held decisions and receipt controls retain exact words", async ({ page }) => {
  await send(page, "Firstmate: What is blocking export totals?");
  const sent = (await call("GET", "/api/intents?kind=tell_firstmate&limit=1")).body[0];
  expect(sent.payload.text).toContain("What is blocking export totals?");
  await send(page, `Steer task ${FIXTURE_TASKS.ship}: preserve the totals row`);
  const n = await call("POST", "/api/notes", { title: "Freeform relay", bullets: ["Totals reviewed"], mission: "csv-export" });
  await send(page, "Tell Firstmate about Freeform relay");
  expect((await call("GET", `/api/notes/${n.body.id}`)).body).toBeTruthy();
  await send(page, `Nudge request ${sent.id}`);
  await send(page, `Dismiss request ${sent.id}`);
  addAskFixtures(home);
  await waitUntil(async () => (await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`));
  await send(page, `Answer hold:${ASK_TASKS.calls}: done: last row; CSV and XLSX`);
  expect((await call("GET", "/api/asks")).body.asks.some((a: { id: string }) => a.id === `hold:${ASK_TASKS.calls}`)).toBe(false);
  await send(page, `Answer hold:${FIXTURE_TASKS.queued}: release: button reviewed`);
  expect((await call("GET", `/api/firstmate/tasks/${FIXTURE_TASKS.queued}`)).body.hold_kind).toBeNull();
  await send(page, `Recheck ask decision:${FIXTURE_TASKS.scout}:flake-cause`);
  await send(page, `Answer decision:${FIXTURE_TASKS.scout}:flake-cause: fix the race first`);
});

test("private Firstmate primary starts and switches; resume and group/project session launches use isolated Herdr", async ({ page }) => {
  await call("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: liveStdout(Date.now()) } });
  await call("GET", "/api/usage?fresh=1");
  await waitUntil(async () => (await call("GET", "/api/usage")).body.providers.some((p: { provider: string; state: string }) => p.provider === "codex" && p.state === "live"));
  await send(page, "Start Firstmate");
  const status = (await call("GET", "/api/firstmate/status")).body;
  const next = status.primary.choices.find((p: { harness: string }) => p.harness === "codex");
  expect(next).toBeTruthy();
  await send(page, `Switch Firstmate to ${next.account}`);
  expect((await call("GET", "/api/firstmate/status")).body.primary.current.account).toBe(next.account);
  const resumed = await send(page, `Resume session codex:${FAKE_SESSIONS.codexIdle}`);
  expect(resumed.route).toBe("deterministic"); expect(resumed.worker).toBeTruthy();
  await send(page, "Start a session in New Core");
  await send(page, "Start a session in /tmp/joyride-fixture-repos/alpha");
  expect(fs.existsSync(path.join(home, "data", "backlog.md"))).toBe(true);
});

test("setup, login, terminal input, remembered rules and extended view controls have explicit owner routes", async ({ page }) => {
  await call("POST", "/api/system/setup/test-fakes", { tools: { gh: "/test/gh" } });
  for (const text of ["Mark setup claude-login done", "Mark setup claude-login incomplete", "Dismiss setup hints", "Install hooks", "Sign in to GitHub", "Focus GitHub login", "Remove remembered rule gar-nonexistent", `Type in worker ${W.codex}: pwd\n`, "Sort agents by recent", "Sort agents by ideas", "Show agents in OAuth login flow", "Pan map left 80", "Show needs you", "Show at my helm", "Show idle agents", "Show done agents", "Show yours agents"]) {
    const r = await send(page, text); expect(r.route, text).toBe("deterministic"); if (r.undo) await undo(page);
  }
  await page.goto(`/#/worker/${encodeURIComponent(W.codex)}`);
  for (const [text, tab] of [["Open terminal tab", "Terminal"], ["Open context tab", "Details"], ["Open chat tab", "Chat"]]) {
    const r = await sendHere(page, text); expect(r.route).toBe("deterministic");
    await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
    await undo(page); await expect(page.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
  }
});

test("agent jobs read proposal context, configure a Codex session, triage batches and inspect policy through their owners", async ({ page }) => {
  test.setTimeout(120000);
  const dir = path.join(env.JOYRIDE_RUNTIME, "proposals", "missions");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const proposal = (id: string) => ({ id, title: `Context proof ${id}`, goal: "Review the export work", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["main"], sessions: [{ source: "claude", id: FAKE_SESSIONS.claudeWorking }], first_ts: now, last_ts: now, status: "pending", reason: "New context proof", merge_into: null, created: now });
  for (const id of ["new-context-proposal", "new-batch-a", "new-batch-b"]) fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(proposal(id)));
  const cli = async (job: NewReceipt, args: string[]) => JSON.parse((await promisify(execFile)(path.resolve("bin/joyride"), args, { env: { ...process.env, ...env, JOYRIDE_URL: `http://127.0.0.1:${PORT}`, JOYRIDE_NEW_JOB: job.id }, encoding: "utf8" })).stdout);
  const complete = async (job: NewReceipt, message: string) => {
    await cli(job, ["api", "POST", `/api/new/jobs/${job.id}/complete`, JSON.stringify({ message })]);
    await expect(outcome(page)).toHaveAttribute("data-state", "done");
    await resolvedProof(page, job.id);
  };

  const contextJob = await send(page, "Summarize suggestion new-context-proposal and refresh its session summary", "report-scaffold");
  expect(contextJob.route).toBe("agent");
  const context = await cli(contextJob, ["api", "GET", "/api/missions/proposals/new-context-proposal/context?wait=1&retry=1"]);
  expect(context.id).toBe("new-context-proposal");
  expect(context.sessions).toContainEqual(expect.objectContaining({ key: `claude:${FAKE_SESSIONS.claudeWorking}`, missing: false }));
  expect(context.brief_status).toBe("ready");
  const summary = await cli(contextJob, ["map", "note", context.brief.summary, "--title", "Suggestion session summary", "--idea", "report-scaffold"]);
  await complete(contextJob, "Refreshed the suggestion's session summary and saved it in this idea.");
  await outcome(page).getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(`[data-board-item="${summary.id}"]`).first()).toBeVisible();
  await undo(page); expect((await notes()).some((n) => n.id === summary.id)).toBe(false);

  const configured = await send(page, "Start Codex with my Codex account in this project and the prompt: audit export totals", "report-scaffold");
  expect(configured.route).toBe("agent");
  const accounts = await cli(configured, ["api", "GET", "/api/usage/accounts"]);
  const account = accounts.find((a: { provider: string }) => a.provider === "codex");
  expect(account).toBeTruthy();
  const started = await cli(configured, ["api", "POST", "/api/intents", JSON.stringify({ kind: "launch_session", target: "/tmp/joyride-fixture-repos/alpha", payload: { cwd: "/tmp/joyride-fixture-repos/alpha", agent: "codex", account: account.id, prompt: "Audit export totals", args: ["--model", "gpt-6-luna"], label: "Configured export audit" } })]);
  expect(started).toMatchObject({ status: "sent", result: { account: account.id, prompt_sent: true } });
  const child = await waitUntil(async () => {
    const worker = (await call("GET", `/api/workers/${encodeURIComponent(started.result.worker)}`)).body;
    return worker.session ? worker : null;
  });
  expect(child).toMatchObject({ agent: "codex", cwd: "/tmp/joyride-fixture-repos/alpha" });
  await cli(configured, ["map", "file-session", child.session, "--to-idea", "report-scaffold"]);
  expect((await call("GET", `/api/new/${configured.id}`)).body).toMatchObject({ worker: configured.worker, session: configured.session, state: "running" });
  const childRef = { source: "codex", id: child.session.slice("codex:".length) };
  expect((await call("GET", "/api/missions/map")).body.ideas.find((i: { id: string }) => i.id === "report-scaffold").sessions).toContainEqual(childRef);
  await complete(configured, "Started the configured Codex export audit and filed its session in this idea.");
  await undo(page);
  expect((await call("GET", "/api/missions/map")).body.ideas.find((i: { id: string }) => i.id === "report-scaffold").sessions).not.toContainEqual(childRef);

  const batch = await send(page, "Triage suggestions new-batch-a and new-batch-b together, accepting both", "report-scaffold");
  expect(batch.route).toBe("agent");
  for (const id of ["new-batch-a", "new-batch-b"]) await cli(batch, ["api", "POST", `/api/missions/proposals/${id}/accept`, "{}"]);
  const remaining = (await call("GET", "/api/missions/proposals")).body;
  expect(remaining.some((p: { id: string }) => ["new-batch-a", "new-batch-b"].includes(p.id))).toBe(false);
  await complete(batch, "Accepted both suggestions as ideas on the canvas.");
  await undo(page);
  for (const id of ["new-batch-a", "new-batch-b"]) expect((await call("GET", "/api/missions/proposals")).body.some((p: { id: string }) => p.id === id)).toBe(true);

  const settings = await send(page, "Use Codex with my Codex account for session intention summaries and low effort", "report-scaffold");
  expect(settings.route).toBe("agent");
  const before = (await call("GET", "/api/system/config")).body.config;
  const override = { backend: "codex", model: "gpt-6-luna", effort: "low", account: account.id };
  expect((await call("POST", `/api/new/jobs/${settings.id}/actions`, { request: "task-account-model", action: { kind: "resource", action: "settings", target: "", payload: { llm: { tasks: { session_intent: override } } } } })).status).toBe(200);
  expect((await call("GET", "/api/system/config")).body.config.llm.tasks.session_intent).toEqual(override);
  await complete(settings, "Saved the task model, effort and account settings."); await undo(page);
  expect((await call("GET", "/api/system/config")).body.config).toEqual(before);

  const policy = await send(page, "Inspect guard policy and remembered rules, and leave a summary here", "report-scaffold");
  expect(policy.route).toBe("agent");
  const guard = await cli(policy, ["api", "GET", "/api/guard/policy"]);
  const rules = await cli(policy, ["api", "GET", "/api/guard/rules"]);
  expect(guard.yaml).toContain("rules:"); expect(Array.isArray(rules)).toBe(true);
  const note = await cli(policy, ["map", "note", `Guard policy inspected; ${rules.length} remembered rules.`, "--title", "Guard policy summary", "--idea", "report-scaffold"]);
  await complete(policy, "Read guard policy and remembered rules; saved the result here.");
  expect((await notes()).find((n) => n.id === note.id)?.scope).toBe("mission:report-scaffold"); await undo(page);
  expect((await notes()).some((n) => n.id === note.id)).toBe(false);
});

test("review report registers as a self-contained sandbox artifact and its filter and animation replay work", async ({ page }) => {
  const report = path.resolve("docs/reports/new-freeform.html");
  test.skip(!fs.existsSync(report), "needs the local proof report; docs/reports is gitignored");
  const r = (await call("POST", "/api/artifacts", { local_source: report, title: "Freeform New — review report", mission: "report-scaffold" })).body;
  expect(r.snapshot_blob).toMatch(/^[a-f0-9]{64}$/);
  await page.goto(`/#/artifacts/${r.id}`);
  const expanded = page.getByTestId("artifact-reader");
  await expect(expanded).toBeVisible();
  const frame = page.frameLocator('[data-testid="artifact-reader-frame"]');
  await expect(frame.getByRole("heading", { name: "What you can do", exact: true })).toBeVisible();
  await frame.getByRole("searchbox").fill("Firstmate");
  await expect(frame.locator("tbody").first().locator("tr:visible")).not.toHaveCount(0);
  await frame.getByRole("searchbox").fill("");
  await frame.locator('.demo[data-animation="note"]').click();
  await expect(frame.locator('.demo[data-animation="note"]')).toHaveClass(/play/);
  await frame.locator('.demo[data-animation="note"] span').evaluate(async (el) => { await Promise.all(el.getAnimations().map(a => a.finished)); });
  await expect(frame.locator('.demo[data-animation="note"] span')).toHaveCSS("opacity", "1");
  await expect(frame.locator('.demo[data-animation="note"]')).toHaveCSS("color", "rgb(21, 35, 62)");
  await shot(page, cp, "review-artifact-preview");
  await expanded.getByRole("button", { name: "Back to details" }).click();
  await expect(expanded).toHaveCount(0);
  await expect(page.getByTestId("artifact-detail")).toBeVisible();
});
