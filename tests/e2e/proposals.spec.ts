import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { PORT, call, seedWorld } from "./map-seed";

test.beforeAll(async () => { await seedWorld(); });

type Summary = { items: { id: string; noise: boolean; noise_reason: string; recommended: boolean | null; brief_status: string }[] };
const summary = async () => (await call<Summary>("GET", "/api/missions/proposals/summary")).body;

test("triage proposals: grouped by repo, edit and accept, reject by keyboard, bulk reject, backfill", async ({ page }) => {
  const before = (await call<any[]>("GET", "/api/missions/proposals")).body;
  expect(before.length).toBeGreaterThanOrEqual(4);
  await page.goto("/#/map");
  await expect(page.locator(".nav .nav-badge")).toHaveText(String(before.length));
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Agents/ }).click();
  await page.getByTestId("agents-page").locator('[data-seg="show"] [data-filter="suggested"]').click();
  await expect(page).toHaveURL(/#\/agents\?show=suggested$/);
  await expect(page.getByRole("heading", { level: 2, name: "Suggested ideas" })).toBeVisible();
  // Show everything, grouped by repo, for this walk through the classic flow.
  await expect(page.locator(".pp-tally")).toContainText("to decide");
  const hide = page.getByRole("checkbox", { name: /Hide noise/ });
  if (await hide.isChecked()) await hide.uncheck();
  await page.getByRole("radio", { name: "By repo" }).click();
  await expect(page.locator(".pp-group-head h3", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".pp-group-head h3", { hasText: "No repo" })).toBeVisible();
  await expect(page.locator("li.prop")).toHaveCount(before.length);
  await shot(page, "C1", "proposals", { fullPage: true });

  // Edit and accept: the scratch proposal becomes a renamed mission.
  const scratch = before.find((p) => p.title.startsWith("scratch"))!;
  const row = page.locator(`[data-proposal="${scratch.id}"]`);
  await row.getByRole("button", { name: "Edit" }).click();
  await row.getByLabel("Idea title").fill("Log line regex");
  await row.getByLabel("Idea goal").fill("A tested regex that parses our structured log lines.");
  await row.getByRole("button", { name: "Accept as idea" }).click();
  await expect(page.locator(".pp-note")).toContainText("Accepted as “Log line regex”");
  await expect(row).toHaveCount(0);
  const missions = (await call<any[]>("GET", "/api/missions")).body;
  expect(missions.some((m) => m.title === "Log line regex" && m.goal.startsWith("A tested regex"))).toBe(true);

  // Keyboard: focus a row, r rejects.
  const scaffold = before.find((p) => p.title.includes("Scaffold"))!;
  await page.locator(`[data-proposal="${scaffold.id}"]`).focus();
  await page.keyboard.press("r");
  await expect(page.locator(`[data-proposal="${scaffold.id}"]`)).toHaveCount(0);
  expect((await call<any[]>("GET", "/api/missions/proposals?status=rejected")).body.some((p) => p.id === scaffold.id)).toBe(true);

  // Bulk: select two, reject selected.
  const rest = before.filter((p) => p.id !== scratch.id && p.id !== scaffold.id).slice(0, 2);
  for (const p of rest) await page.getByLabel(`Select ${p.title}`).check();
  await expect(page.locator(".pp-all")).toContainText("2 selected");
  await page.getByRole("button", { name: "Reject selected" }).click();
  await expect(page.locator(".pp-note")).toContainText("Rejected 2 proposals");
  for (const p of rest) await expect(page.locator(`[data-proposal="${p.id}"]`)).toHaveCount(0);

  // Run backfill again reports what it found.
  await page.getByRole("button", { name: "Run backfill again" }).click();
  await expect(page.locator(".pp-note")).toContainText("Backfill read");
  console.log("backfill note:", await page.locator(".pp-note").textContent());
  // The nav badge follows the pending count live.
  const pending = (await call<any[]>("GET", "/api/missions/proposals")).body.length;
  await expect(page.locator(".nav .nav-badge")).toHaveText(String(pending));
  await expect(page.locator("li.prop")).toHaveCount(pending);

  // Back to the defaults for the next test.
  await page.getByRole("radio", { name: "Recommended first" }).click();
  await page.getByRole("checkbox", { name: /Hide noise/ }).check();

  // The accepted mission is on the map.
  await page.getByRole("link", { name: "Map", exact: true }).click();
  await expect(page.locator(".mission-node", { hasText: "Log line regex" })).toBeVisible();
  await shot(page, "C1", "map");
});

// ---------- context ----------

const REPO = "/tmp/joyride-fixture-repos/delta-e2e";
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
function transcript(id: string, branch: string) {
  const lines: string[] = [];
  let n = 0;
  const base = (o: object) => JSON.stringify({ sessionId: id, cwd: REPO, gitBranch: branch, isSidechain: false, uuid: `${id}-${n++}`, ...o });
  const t = {
    user: (text: string, min: number) => { lines.push(base({ type: "user", timestamp: ago(min), origin: { kind: "human" }, message: { role: "user", content: text } })); return t; },
    say: (text: string, min: number) => { lines.push(base({ type: "assistant", timestamp: ago(min), message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 4000, output_tokens: 900 } } })); return t; },
    tool: (tid: string, name: string, input: object, min: number) => { lines.push(base({ type: "assistant", timestamp: ago(min), message: { id: `m${n}`, role: "assistant", content: [{ type: "tool_use", id: tid, name, input }], usage: { input_tokens: 4000, output_tokens: 300 } } })); return t; },
    result: (tid: string, text: string, min: number) => { lines.push(base({ type: "user", timestamp: ago(min), message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: text }] }, toolUseResult: { stdout: text } })); return t; },
    write: () => {
      const dir = `/tmp/joyride-e2e-${PORT}/claude/projects/${REPO.replace(/[^A-Za-z0-9]/g, "-")}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
    },
  };
  return t;
}
const ID = { a: "e2e00001-0000-4000-8000-00000000000a", b: "e2e00002-0000-4000-8000-00000000000b", smoke: "e2e00003-0000-4000-8000-00000000000c", quick: "e2e00004-0000-4000-8000-00000000000d" };

test("a proposal opens into a brief with sessions, files and commits; noise is hidden and rejected in one go", async ({ page }) => {
  fs.mkdirSync(REPO, { recursive: true });
  if (!fs.existsSync(path.join(REPO, ".git"))) execFileSync("git", ["init", "-q", REPO]);
  transcript(ID.a, "main")
    .user("Add a CSV export to the monthly report, totals row included", 400)
    .say("I'll start from the report page and its PDF export.", 398)
    .tool("t1", "Edit", { file_path: `${REPO}/src/report/export.ts` }, 396)
    .tool("t2", "Write", { file_path: `${REPO}/src/report/export.test.ts` }, 390)
    .tool("t3", "Edit", { file_path: `${REPO}/src/report/export.ts` }, 380)
    .tool("t4", "Bash", { command: 'git add -A && git commit -m "feat(report): CSV export with a totals row"' }, 370)
    .result("t4", "[main 3f9a1c2] feat(report): CSV export with a totals row\n 2 files changed", 370)
    .user("Non-ASCII names come out garbled in Excel, fix that", 360)
    .tool("t5", "Edit", { file_path: `${REPO}/src/report/encoding.ts` }, 355)
    .say("Fixed: the CSV now starts with a UTF-8 byte order mark, so Excel reads accented names correctly. Tests pass.", 350)
    .write();
  transcript(ID.b, "main")
    .user("Put the export button next to the date filter", 200)
    .tool("t1", "Edit", { file_path: `${REPO}/src/report/Toolbar.tsx` }, 195)
    .tool("t2", "Bash", { command: "git commit -am 'feat(report): export button by the date filter'" }, 190)
    .result("t2", "[main 8b04d7e] feat(report): export button by the date filter\n 1 file changed", 190)
    .say("The export button sits next to the date filter now.", 188)
    .write();
  transcript(ID.smoke, "smoke").user("reply with the word ok", 120).say("ok", 120).write();
  transcript(ID.quick, "check").user("which branch is this?", 100).say("You're on check.", 99).write();
  await call("POST", "/api/sessions/reindex");
  await call("POST", "/api/missions/backfill");

  const props = (await call<any[]>("GET", "/api/missions/proposals")).body;
  const work = props.find((p) => p.sessions.some((s: any) => s.id === ID.a))!;
  const smoke = props.find((p) => p.sessions.some((s: any) => s.id === ID.smoke))!;
  const quick = props.find((p) => p.sessions.some((s: any) => s.id === ID.quick))!;
  expect(work.sessions).toHaveLength(2);
  await expect.poll(async () => (await summary()).items.find((i) => i.id === work.id)?.brief_status, { timeout: 15000 }).toBe("ready");

  await page.goto("/#/proposals");
  // Recommended first: the two-session export work leads, with its verdict on the row.
  const yes = page.locator(".pp-group-yes");
  await expect(yes.locator(".pp-group-head h3")).toHaveText("Worth tracking");
  const row = page.locator(`[data-proposal="${work.id}"]`);
  await expect(yes.locator(`[data-proposal="${work.id}"]`)).toBeVisible();
  await expect(row.locator(".prop-verdict")).toContainText("Worth tracking");
  await expect(row.locator(".prop-verdict [data-outcome='shipped']")).toHaveText("Shipped");
  await expect(row.locator(".prop-meta")).toContainText("4 files changed");
  await expect(row.locator(".prop-meta")).toContainText("2 commits");

  // Noise is hidden by default, with a count.
  const s = await summary();
  const noiseIds = s.items.filter((i) => i.noise).map((i) => i.id);
  expect(noiseIds).toEqual(expect.arrayContaining([smoke.id, quick.id]));
  await expect(page.locator(".pp-hide .pp-count")).toHaveText(String(noiseIds.length));
  await expect(page.locator(`[data-proposal="${smoke.id}"]`)).toHaveCount(0);

  // Open the brief with the keyboard (o), then read it.
  await row.focus();
  await page.keyboard.press("o");
  const ctx = row.locator(".pc");
  await expect(row.locator(".prop-goal")).toContainText("Add a CSV export to the monthly report");
  await expect(ctx.locator(".pc-wait, .inline-error")).toHaveCount(0);
  await expect(ctx.locator(".pc-why")).toContainText("Both sessions ran in delta-e2e, on branch main.");
  await expect(ctx.locator(".pc-sessions > li")).toHaveCount(2);
  await expect(ctx.locator(".pc-sessions a.pc-s-title").first()).toHaveAttribute("href", `#/session/${encodeURIComponent(`claude:${ID.a}`)}`);
  await expect(ctx.locator(".pc-prompt").first()).toContainText("Add a CSV export to the monthly report");
  await expect(ctx.locator(".pc-later").first()).toContainText("Non-ASCII names come out garbled");
  await expect(ctx.locator(".pc-final")).toContainText("The export button sits next to the date filter now.");
  await expect(ctx.locator(".pc-files li").first()).toContainText("export.ts");
  await expect(ctx.locator(".pc-files li").first()).toContainText("2 edits");
  await expect(ctx.locator(".pc-files li")).toHaveCount(4);
  await expect(ctx.locator(".pc-commits li")).toHaveCount(2);
  await expect(ctx.locator(".pc-commits")).toContainText("3f9a1c2");
  await expect(ctx.locator(".pc-commits")).toContainText("feat(report): CSV export with a totals row");
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const el = document.querySelector<HTMLElement>(".pp-group-yes");
    el?.scrollIntoView({ block: "start" });
    let sc = el?.parentElement ?? null;
    while (sc && sc.scrollHeight <= sc.clientHeight) sc = sc.parentElement;
    (sc ?? document.scrollingElement)?.scrollBy(0, -64);
  });
  await shot(page, "C11", "proposals-context");
  await row.focus();

  // o closes it again; j/k still move between rows; x selects.
  await page.keyboard.press("o");
  await expect(row.locator(".pc")).toHaveCount(0);
  // Earlier specs in the run can leave proposals above or below this row, and j/k
  // stop at the ends, so step toward whichever neighbour exists and back.
  const isLast = await row.evaluate((el) => { const all = [...document.querySelectorAll("li.prop")]; return all.indexOf(el) === all.length - 1; });
  await page.keyboard.press(isLast ? "k" : "j");
  await expect(page.locator("li.prop:focus")).toHaveCount(1);
  await expect(row).not.toBeFocused();
  await page.keyboard.press(isLast ? "j" : "k");
  await expect(row).toBeFocused();
  await page.keyboard.press("x");
  await expect(page.locator(".pp-all")).toContainText("1 selected");
  await page.keyboard.press("x");

  // The session link opens the session pane.
  await row.getByRole("button", { name: "Show sessions, files and commits" }).click();
  await row.locator(".pc-sessions a.pc-s-title").first().click();
  await expect(page).toHaveURL(new RegExp(`#/session/${encodeURIComponent(`claude:${ID.a}`)}`));
  await page.goBack();

  // Show the noise: it reads as noise, with the reason.
  await page.getByRole("checkbox", { name: /Hide noise/ }).uncheck();
  const smokeRow = page.locator(`[data-proposal="${smoke.id}"]`);
  await expect(smokeRow.locator(".prop-verdict")).toContainText("Noise");
  await expect(smokeRow.locator(".prop-verdict")).toContainText("Smoke test: “reply with the word ok”");
  await expect(page.locator(`[data-proposal="${quick.id}"] .prop-verdict`)).toContainText("One quick exchange");
  await page.getByRole("checkbox", { name: /Hide noise/ }).check();
  await expect(smokeRow).toHaveCount(0);

  // Reject all noise, after a confirmation.
  await page.getByRole("button", { name: "Reject all noise" }).click();
  await page.getByRole("button", { name: `Reject ${noiseIds.length}`, exact: true }).click();
  await expect(page.locator(".pp-note")).toContainText(`Rejected ${noiseIds.length} proposal`);
  await expect(page.locator(".pp-hide .pp-count")).toHaveText("0");
  const rejected = (await call<any[]>("GET", "/api/missions/proposals?status=rejected")).body;
  const smokeDone = rejected.find((p) => p.id === smoke.id);
  expect(smokeDone.decision_reason).toBe("noise: Smoke test: “reply with the word ok”");
  expect(noiseIds.every((id) => rejected.some((p) => p.id === id))).toBe(true);
  await expect(row).toBeVisible();
});

test("a merge suggestion links the proposal's sessions into the existing mission", async ({ page }) => {
  // Stage a proposal the way backfill stores one when Jev suggests a merge (sandbox runtime only).
  const dir = `/tmp/joyride-e2e-${PORT}/runtime/proposals/missions`;
  fs.mkdirSync(dir, { recursive: true });
  const t = new Date().toISOString();
  const session = { source: "claude", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  fs.writeFileSync(`${dir}/mp-e2e-merge.json`, JSON.stringify({
    id: "mp-e2e-merge", title: "alpha: Polish the CSV export", goal: "Tidy the export column names.", repos: ["/tmp/joyride-fixture-repos/alpha"], branches: ["main"],
    sessions: [session], first_ts: t, last_ts: t, status: "pending", reason: "1 session in alpha on main", merge_into: "csv-export", created: t,
  }));
  await page.goto("/#/proposals");
  // A one-line session reads as noise, so show noise to find it.
  const hide = page.getByRole("checkbox", { name: /Hide noise/ });
  await expect(page.locator(".pp-tally")).toContainText("to decide");
  if (await hide.isChecked()) await hide.uncheck();
  const row = page.locator('[data-proposal="mp-e2e-merge"]');
  await expect(row.locator(".prop-merge")).toContainText("Looks like part of CSV export for the report page");
  await expect(row.getByRole("button", { name: "Accept as new" })).toBeVisible();
  await row.getByRole("button", { name: "Merge into it" }).click();
  await expect(row).toHaveCount(0);
  const m = (await call("GET", "/api/missions/csv-export")).body;
  expect(m.sessions.some((s: any) => s.id === session.id)).toBe(true);
  await hide.check();
});
