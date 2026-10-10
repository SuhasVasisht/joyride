import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, PORT, seedWorld } from "./map-seed";

/** Append hook events to the sandbox event log, the way the hooks write them. */
function appendHookEvents(evs: { type: string; data: Record<string, unknown>; agoMs: number }[], session: string) {
  const sandbox = `/tmp/joyride-e2e-${PORT}`;
  const env = JSON.parse(fs.readFileSync(path.join(sandbox, "env.json"), "utf8"));
  const dir = path.join(env.JOYRIDE_RUNTIME, "events");
  if (!dir.startsWith(sandbox)) throw new Error("refusing: event log is not in the sandbox");
  fs.mkdirSync(dir, { recursive: true });
  const lines = evs.map((e, i) => JSON.stringify({ ts: new Date(Date.now() - e.agoMs).toISOString(), id: `ev_e2e_tl_${PORT}_${i}_${e.type}`, source: "hook.claude", type: e.type, session, agent: "claude", cwd: "/tmp/joyride-fixture-repos/alpha", data: e.data }));
  fs.appendFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), lines.join("\n") + "\n");
}

test.beforeAll(async () => { await seedWorld(); });

test("palette jumps to a mission; the pane shows header and panels in spec order", async ({ page }) => {
  await page.goto("/#/map");
  await expect(page.locator('[data-mission="csv-export"]')).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill("CSV export for");
  await palette.getByRole("option", { name: /CSV export for the report page/ }).click();
  await expect(page).toHaveURL(/#\/mission\/csv-export/);
  const sheet = page.getByRole("dialog", { name: /Idea: CSV export/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("CSV export for the report page");
  await expect(sheet.locator(".mp-health")).toContainText("Blocked");
  // Panels render in the default order (no workspace spec served in the sandbox).
  const ids = await sheet.locator("section.mpanel").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panel));
  const core = ids.filter((i) => ["done_when", "workers", "sessions", "timeline", "dependencies"].includes(i!));
  expect(core).toEqual(["done_when", "workers", "sessions", "timeline", "dependencies"]);
  await expect(sheet.locator(".crit")).toHaveCount(3);
  await expect(sheet.locator("[data-worker-row]")).toHaveCount(2);
  await expect(sheet.locator('[data-worker-row="local:w1:p2"]')).toHaveClass(/s-blocked/);
  await expect(sheet.locator("[data-session-row]")).toHaveCount(2);
  await expect(sheet.locator(".timeline .tl").first()).toBeVisible();
  await shot(page, "C2", "mission-pane");
  await sheet.locator('[data-panel="workers"] h2').evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "C2", "mission-pane-workers");
  await sheet.locator('[data-panel="timeline"] h2').evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "C2", "mission-pane-timeline");
});

test("closing a mission without a passing verdict surfaces the gate, then closes with an override", async ({ page }) => {
  await page.goto("/#/mission/report-scaffold");
  const sheet = page.getByRole("dialog", { name: /Idea/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("Scaffold the report page");
  await sheet.getByRole("radio", { name: "Done" }).click();
  const gate = sheet.locator(".mp-gate");
  await expect(gate).toContainText("no passing verdict");
  await gate.getByLabel("Override reason").fill("Shipped behind a flag; checked by hand");
  await gate.getByRole("button", { name: "Close with this reason" }).click();
  await expect(sheet.getByRole("radio", { name: "Done" })).toHaveAttribute("aria-checked", "true");
  await expect(sheet.locator(".mp-override")).toContainText("Shipped behind a flag");
  const m = (await call("GET", "/api/missions/report-scaffold")).body;
  expect(m.state).toBe("done");
  expect(m.override.reason).toContain("Shipped behind a flag");
  // Re-open so later specs see it as open.
  await sheet.getByRole("radio", { name: "Open" }).click();
  await expect(sheet.getByRole("radio", { name: "Open" })).toHaveAttribute("aria-checked", "true");
});

test("done-when criteria can be added and removed", async ({ page }) => {
  await page.goto("/#/mission/oauth-login");
  const sheet = page.getByRole("dialog", { name: /Idea/ });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("OAuth login flow");
  await sheet.getByLabel("New criterion").fill("Login e2e test passes against the staging IdP");
  await sheet.getByLabel("Evidence kind").selectOption("e2e");
  await sheet.getByRole("button", { name: "Add", exact: true }).first().click();
  await expect(sheet.locator(".crit")).toHaveCount(1);
  await expect(sheet.locator(".crit .crit-kind")).toHaveText("e2e");
  await sheet.locator(".crit").hover();
  await sheet.getByRole("button", { name: /Remove criterion/ }).click();
  await expect(sheet.locator(".crit")).toHaveCount(0);
});

test("sessions panel links and unlinks a session; dependencies show both directions", async ({ page }) => {
  await page.goto("/#/mission/oauth-login");
  const sheet = page.getByRole("dialog", { name: /Idea/ });
  const panel = sheet.locator('[data-panel="sessions"]');
  await expect(panel.locator("[data-session-row]")).toHaveCount(1);
  await panel.getByLabel("Search sessions to link").fill("encoding");
  await panel.getByRole("button", { name: /Export CSV encoding fix/ }).click();
  await expect(panel.locator("[data-session-row]")).toHaveCount(2);
  await panel.getByRole("button", { name: /Unlink Export CSV encoding fix/ }).click();
  await expect(panel.locator("[data-session-row]")).toHaveCount(1);
  // idempotent-sync blocks oauth-login.
  const deps = sheet.locator('[data-panel="dependencies"]');
  await expect(deps.locator(".deps-col").first()).toContainText("Make the nightly sync idempotent");
  await deps.getByRole("link", { name: "Make the nightly sync idempotent" }).click();
  await expect(page).toHaveURL(/#\/mission\/idempotent-sync/);
  await expect(page.getByRole("dialog", { name: /Idea/ }).locator('[data-panel="dependencies"] .deps-col').nth(1)).toContainText("OAuth login flow");
  // Esc walks back to the previous pane, then to the map.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/mission\/oauth-login/);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/map$/);
});

test("a verdict marks each done-when criterion in the pane and on the map", async ({ page }) => {
  const ev = await call("POST", "/api/evidence", {
    name: "sync idempotency tests", mode: "attested", command: "pytest tests/test_sync.py", exit_code: 0, mission: "idempotent-sync",
    cwd: "/tmp/joyride-fixture-repos/beta", log_tail: "14 passed in 2.1s", assertions: { passed: 14, failed: 0, skipped: 0 }, claim: "Running the sync twice leaves the row count unchanged; retry test passes",
  });
  expect(ev.status).toBe(200);
  const v = await call("POST", "/api/evidence/verdict/idempotent-sync", {});
  expect(v.status).toBe(200);
  await page.goto("/#/mission/idempotent-sync");
  const sheet = page.getByRole("dialog", { name: /Idea/ });
  const panel = sheet.locator('[data-panel="done_when"]');
  await expect(panel.locator(".panel-meta")).toContainText("Last verdict");
  const states = await panel.locator(".crit").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.verdict));
  expect(states.length).toBe(2);
  for (const s of states) expect(["pass", "fail", "insufficient"]).toContain(s);
  expect(states).toEqual(v.body.per_criterion.map((c: any) => c.verdict));
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Mid" }).click();
  const ticks = page.locator('[data-mission="idempotent-sync"] .progress .ticks i');
  await expect(ticks).toHaveCount(2);
  await expect(ticks.first()).toHaveClass(new RegExp(`t-${states[0]}`));
});

test("the timeline reads the event log: prompts, folded runs of tool calls, and turns", async ({ page }) => {
  appendHookEvents([
    { type: "prompt.submit", data: { prompt: "Add a totals row to the CSV export and keep the PDF export as it is" }, agoMs: 9 * 60e3 },
    { type: "tool.pre", data: { tool: "Read", input: { file_path: "src/export/csv.ts" } }, agoMs: 8 * 60e3 },
    { type: "tool.pre", data: { tool: "Edit", input: { file_path: "src/export/csv.ts" } }, agoMs: 7 * 60e3 },
    { type: "tool.pre", data: { tool: "Bash", input: { command: "npm test -- csv" } }, agoMs: 6 * 60e3 },
    { type: "tool.pre", data: { tool: "Bash", input: { command: "npm test -- csv" } }, agoMs: 5 * 60e3 },
    { type: "turn.stop", data: { last: "The totals row is in and the CSV writer tests pass." }, agoMs: 4 * 60e3 },
  ], FAKE_SESSIONS.claudeWorking);
  await expect.poll(async () => (await call<any[]>("GET", "/api/events?mission=csv-export&type=prompt.*&limit=20")).body.some((e) => String(e.data?.prompt).startsWith("Add a totals row")), { timeout: 10000 }).toBe(true);
  await page.goto("/#/mission/csv-export");
  const panel = page.getByRole("dialog", { name: /Idea/ }).locator('[data-panel="timeline"]');
  await panel.locator("h2").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(panel.locator('.tl[data-kind="prompt"]').first()).toContainText("Prompt: “Add a totals row to the CSV export");
  const tools = panel.locator('.tl[data-kind="tools"]').first();
  await expect(tools).toContainText("4 tool calls");
  await expect(tools).toContainText("Bash 2, Edit 1, Read 1");
  await expect(panel.locator('.tl[data-kind="turn"]').first()).toContainText("The totals row is in");
  // Newest first: the turn, then the folded tool calls, then the prompt.
  const kinds = await panel.locator(".tl").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
  const at = (k: string) => kinds.indexOf(k);
  expect(at("turn")).toBeLessThan(at("tools"));
  expect(at("tools")).toBeLessThan(at("prompt"));
  await shot(page, "C2", "mission-timeline-events");
});

test("new mission from its link and the palette: title, goal, repo, done-when with kinds, then it opens", async ({ page }) => {
  await page.goto("/#/map");
  // The map's strip has no New idea button: ideas start in New, or here.
  await expect(page.locator(".map-strip").getByRole("link", { name: "New idea" })).toHaveCount(0);
  await page.goto("/#/new-mission");
  await expect(page).toHaveURL(/#\/new-mission/);
  const sheet = page.getByRole("dialog", { name: "New idea" });
  await expect(sheet.getByRole("heading", { level: 1 })).toHaveText("New idea");
  await expect(sheet.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Escape"); // leaves the field
  await page.keyboard.press("Escape"); // closes the sheet
  await expect(page).toHaveURL(/#\/map$/);

  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("textbox").fill("new idea");
  await palette.getByRole("option", { name: /^New idea/ }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Title").fill("Totals row in the PDF export");
  await sheet.getByLabel("Goal").fill("The PDF export shows the same totals row as the CSV export.");
  const repo = sheet.getByLabel("Repo");
  await expect(repo.locator("option", { hasText: "alpha" }).first()).toBeAttached();
  const alphaValue = await repo.locator("option", { hasText: "alpha" }).first().getAttribute("value");
  await repo.selectOption(alphaValue!);
  await sheet.getByLabel("Criterion 1", { exact: true }).fill("PDF export test checks the totals row");
  await sheet.getByRole("button", { name: "Add a criterion" }).click();
  await sheet.getByLabel("Criterion 2", { exact: true }).fill("Screenshot of the PDF with totals");
  await sheet.getByLabel("Evidence kind for criterion 2").selectOption("screenshot");
  await shot(page, "C10", "new-mission");
  await sheet.getByRole("button", { name: "Create idea" }).click();
  await expect(page).toHaveURL(/#\/mission\/totals-row-in-the-pdf-export/);
  const pane = page.getByRole("dialog", { name: /Idea: Totals row/ });
  await expect(pane.getByRole("heading", { level: 1 })).toHaveText("Totals row in the PDF export");
  await expect(pane.locator(".crit")).toHaveCount(2);
  await expect(pane.locator('.crit[data-criterion="c2"] .crit-kind')).toHaveText("screenshot");
  const m = (await call<any>("GET", "/api/missions/totals-row-in-the-pdf-export")).body;
  expect(m).toMatchObject({ title: "Totals row in the PDF export", repos: [alphaValue], goal: "The PDF export shows the same totals row as the CSV export." });
  expect(m.done_when.map((c: any) => c.kind)).toEqual(["test", "screenshot"]);
});
