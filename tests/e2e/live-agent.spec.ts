// C11: see and steer an agent without a terminal app. The worker pane opens on
// the live chat (markdown messages, folded tool chips, reply pinned at the
// bottom), the Terminal tab mirrors the Herdr pane and takes typing, and each
// agent carries a one-line intent on the pane, the map and the rail.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, herdr, PORT, raise, seedWorld, waitUntil } from "./map-seed";

const SID = "c11c11c1-1111-4c11-8c11-c11c11c11c11";
const KEY = `claude:${SID}`;
const REPO = "/tmp/joyride-fixture-repos/alpha";
const FILE = path.join(`/tmp/joyride-e2e-${PORT}`, "claude", "projects", "-tmp-joyride-fixture-repos-alpha", `${SID}.jsonl`);
let worker = "";

const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();
let seq = 0;
const base = (ts: string) => ({ parentUuid: null, isSidechain: false, userType: "external", cwd: REPO, sessionId: SID, version: "2.1.0", gitBranch: "main", timestamp: ts, uuid: `c1100000-0000-4000-8000-${String(++seq).padStart(12, "0")}` });
const user = (min: number, text: string) => JSON.stringify({ ...base(ago(min)), type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
const result = (min: number, id: string, out: string) => JSON.stringify({ ...base(ago(min)), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] }, toolUseResult: { stdout: out } });
const said = (min: number, blocks: any[]) => JSON.stringify({ ...base(ago(min)), type: "assistant", message: { id: `msg_${seq}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: blocks, usage: { input_tokens: 100, output_tokens: 40 } } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

function transcript() {
  return [
    user(40, "Fix the CSV export totals for months with refunds. They count refunds as sales; find out why, fix it, and make sure the export tests cover refunds."),
    said(39, [text("I'll start by finding where the totals row is built."), tool("t1", "Grep", { pattern: "buildTotals", path: "src/export" })]),
    result(39, "t1", "src/export/csv.ts:42"),
    said(38, [tool("t2", "Read", { file_path: `${REPO}/src/export/csv.ts` })]),
    result(38, "t2", "..."),
    said(37, [text([
      "Found it. `buildTotals()` sums **gross** amounts, so refunds are counted as sales:",
      "",
      "```ts",
      "const total = rows.reduce((sum, r) => sum + r.gross, 0);",
      "```",
      "",
      "The fix is to sum `net`, which already subtracts refunds. Plan:",
      "",
      "1. Change `buildTotals()` to use `r.net`",
      "2. Add a refund month to `csv.test.ts`",
      "3. Run the export tests",
    ].join("\n")), tool("t3", "Edit", { file_path: `${REPO}/src/export/csv.ts`, old_string: "r.gross", new_string: "r.net" }), tool("t4", "Edit", { file_path: `${REPO}/src/export/csv.test.ts` }), tool("t5", "Bash", { command: "npm test -- export", description: "Run the export tests" })]),
    result(36, "t5", "18 passing"),
    said(35, [text("All **18** export tests pass, including the new refund month.")]),
    user(12, "Great. Does the PDF export have the same bug?"),
    said(11, [tool("t6", "Grep", { pattern: "gross", path: "src/export" }), tool("t7", "Read", { file_path: `${REPO}/src/export/pdf.ts` }), tool("t8", "Read", { file_path: `${REPO}/src/export/shared.ts` }), tool("t9", "Grep", { pattern: "buildTotals", path: "src" })]),
    result(11, "t9", "src/export/pdf.ts:17"),
    said(10, [text([
      "Yes. The PDF export calls the same helper, so it was wrong too, and the fix covers both:",
      "",
      "| Export | Before | After |",
      "|---|---|---|",
      "| CSV | gross | net |",
      "| PDF | gross | net |",
      "",
      "> The dashboard totals use a different query and were already right.",
      "",
      "Want me to add a PDF test for refunds as well?",
    ].join("\n"))]),
    JSON.stringify({ type: "ai-title", aiTitle: "Refunds in the export totals", sessionId: SID }),
  ].join("\n") + "\n";
}

test.beforeAll(async () => {
  await seedWorld();
  if (!fs.existsSync(FILE)) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, transcript()); }
  await waitUntil(async () => { await call("POST", "/api/sessions/reindex"); return (await call("GET", `/api/sessions/${encodeURIComponent(KEY)}`)).status === 200; }, 15000);
  const st = await herdr("fake.state");
  let pane = st.panes.find((p: any) => p.agent_session?.value === SID)?.pane_id;
  if (!pane) {
    pane = (await herdr("fake.add_pane", {
      workspace_id: "w1", cwd: REPO, agent: "claude", agent_status: "idle", title: "Refunds in the export totals", cols: 92, rows: 20,
      agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: SID },
      screen: [
        "> Great. Does the PDF export have the same bug?",
        "",
        "● Search(pattern: \"gross\", path: \"src/export\")",
        "  ⎿  Found 3 files",
        "● Read(src/export/pdf.ts)",
        "  ⎿  Read 88 lines",
        "",
        "● Yes. The PDF export calls the same helper, so it was wrong too,",
        "  and the fix covers both. The dashboard totals use a different",
        "  query and were already right.",
        "",
        "  Want me to add a PDF test for refunds as well?",
      ],
    })).pane.pane_id;
  }
  worker = `local:${pane}`;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.id === worker && w.session === KEY && w.controllable), 10000);
});

test.afterAll(async () => {
  if (worker) await herdr("fake.close_pane", { pane_id: worker.replace(/^local:/, "") });
});

test("chat: the conversation as messages, tool calls folded, live, with the reply box pinned under it", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  const chat = sheet.locator(`[data-chat="${KEY}"]`);
  await expect(chat.locator(".msg.r-user").first()).toContainText("Fix the CSV export totals for months with refunds");
  await expect(chat.locator(".msg.r-user").last()).toContainText("Does the PDF export have the same bug?");
  // Markdown: inline code, bold, a fenced block, a numbered list, a table and a quote.
  const found = chat.locator(".msg.r-assistant").nth(0);
  await expect(found.locator("code.md-code").first()).toHaveText("buildTotals()");
  await expect(found.locator("strong").first()).toHaveText("gross");
  await expect(found.locator("pre.md-pre")).toContainText("rows.reduce((sum, r) => sum + r.gross, 0)");
  await expect(found.locator("ol > li")).toHaveCount(3);
  const pdf = chat.locator(".msg.r-assistant").last();
  await expect(pdf.locator("table.md-table tbody tr")).toHaveCount(2);
  await expect(pdf.locator("blockquote")).toContainText("dashboard totals");
  // Tools sit between the words, as one-line chips; a long run folds into one line.
  await expect(found.locator(".tool-chip")).toHaveCount(5); // Grep, Read before the findings; Edit, Edit, Bash after them
  // What it is trying to do, above the tabs.
  const intent = sheet.locator(`[data-intent="${KEY}"]`);
  await expect(intent.locator(".intent-goal")).toHaveText("Fix the CSV export totals for months with refunds");
  await expect(intent.locator(".intent-waiting")).toContainText("Want me to add a PDF test for refunds as well?");
  await expect(pdf).toBeInViewport();
  await shot(page, "C11", "chat");
  const bash = found.locator('.tool-chip[data-tool="Bash"]');
  await expect(bash.locator(".tc-sum")).toHaveText("npm test -- export");
  await expect(found.locator('.tool-chip[data-tool="Edit"] .tc-sum').first()).toHaveText("src/export/csv.ts"); // paths relative to the agent's folder
  await expect(bash.locator(".tc-full")).toHaveCount(0);
  await bash.locator(".tc").click();
  await expect(bash.locator(".tc-full")).toHaveText("npm test -- export");
  const run = pdf.locator("details.tool-run");
  await expect(run.locator("summary")).toContainText("4 tool calls");
  await expect(run.locator("summary")).toContainText("Grep, Read");

  // Reply from the pinned box: it reaches the Herdr pane as a prompt.
  await sheet.getByLabel(/Reply to Refunds in the export totals/).fill("Yes, add the PDF refund test too.");
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  await waitUntil(async () => (await herdr("fake.state")).prompts.some((p: any) => p.text === "Yes, add the PDF refund test too."));
  await expect(sheet.locator("[data-intent-status]")).toContainText(/Delivered|picked up/);

  // Scroll after sending: focusing the pinned reply box may have returned the log to the bottom.
  const log = chat.locator(".chat-log");
  await log.hover();
  await page.mouse.wheel(0, -10000);
  await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(64);
  await expect(pdf).not.toBeInViewport();
  // Live: new turns in the transcript show up without a reload.
  fs.appendFileSync(FILE, [user(0, "Yes, add the PDF refund test too."), said(0, [tool("t10", "Edit", { file_path: `${REPO}/src/export/pdf.test.ts` }), text("Added `pdf.test.ts` with a refund month; **19** tests pass.")])].join("\n") + "\n");
  await expect(chat.locator(".msg.r-assistant").last()).toContainText("19 tests pass", { timeout: 15000 });
  // The reader scrolled up, so the new turn offers a way back down without jumping.
  await chat.getByRole("button", { name: "New messages below" }).click();
  await expect(chat.locator(".msg.r-assistant").last()).toBeInViewport();
  await expect(chat.getByRole("button", { name: "New messages below" })).toHaveCount(0);
});

test("terminal: the Herdr pane in the browser, and typing reaches it", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await sheet.getByRole("tab", { name: "Terminal" }).click();
  const term = sheet.locator(`[data-terminal="${worker}"]`);
  await expect(term).toHaveAttribute("data-terminal-state", "live", { timeout: 10000 });
  const rows = term.locator(".xterm-rows");
  await expect(rows).toContainText("Does the PDF export have the same bug?");
  await expect(rows).toContainText("Want me to add a PDF test for refunds as well?");
  await expect(term.locator(".term-size")).toHaveText("92 × 20");
  // ANSI colour comes through (the orange tool bullet).
  await expect(rows.locator("span", { hasText: "●" }).first()).toHaveAttribute("style", /color/);

  await term.locator(".term-screen").click();
  await page.keyboard.type("add the PDF refund tset");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("est");
  await page.keyboard.press("Enter");
  const typed = await waitUntil(async () => (await herdr("fake.state")).typed.find((t: any) => t.text === "add the PDF refund test"));
  expect(typed.target).toBe(worker.replace(/^local:/, ""));
  await expect(rows).toContainText("> add the PDF refund test");

  // Keys a browser would otherwise keep: Shift+Tab and Esc go to the agent, and the sheet stays open.
  const before = (await herdr("fake.state")).inputs.length;
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Escape");
  const keys = await waitUntil(async () => { const k = (await herdr("fake.state")).inputs.slice(before).flatMap((x: any) => x.keys ?? []); return k.length >= 2 ? k : null; });
  expect(keys).toEqual(["shift+tab", "esc"]);
  await expect(sheet).toBeVisible();
  // The quick-key row sends named keys too.
  await term.getByRole("button", { name: "Ctrl+C" }).click();
  await waitUntil(async () => (await herdr("fake.state")).inputs.some((x: any) => x.keys?.includes("ctrl+c")));
  await page.keyboard.type("then run the whole suite");
  await expect(rows).toContainText("then run the whole suite");
  await shot(page, "C11", "terminal");
});

test("terminal: the wheel scrolls without typing, and a reply goes in alone even when the input box holds text", async ({ page }) => {
  // The captain's bug: scrolling over this terminal sent Up/Down, Claude Code recalled its first prompt into
  // the input box, and the next relayed reply was pasted into the middle of it.
  const launch = "Ahoy. I am the captain. Please run your first-time setup and tell me what you need from me.";
  const answers = "1. One version of Joyride, in one place\n\n2. A, cleanly\n\n3. Did that";
  const pane = worker.replace(/^local:/, "");
  await page.goto(`/#/worker/${encodeURIComponent(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await sheet.getByRole("tab", { name: "Terminal" }).click();
  const term = sheet.locator(`[data-terminal="${worker}"]`);
  await expect(term).toHaveAttribute("data-terminal-state", "live", { timeout: 10000 });
  const before = (await herdr("fake.state")).inputs.length;
  const box = (await term.locator(".term-screen").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120);
  for (let i = 0; i < 2; i++) await page.mouse.wheel(0, 120);
  await page.waitForTimeout(800);
  expect((await herdr("fake.state")).inputs.slice(before)).toEqual([]);

  // Leftover text in the input box anyway (an arrow key, a half-typed draft): the reply clears it first.
  await herdr("fake.set_screen", { pane_id: pane, input: `${launch}\nnever push, never open PRs.` });
  await sheet.getByRole("tab", { name: "Chat" }).click();
  const prompts = (await herdr("fake.state")).prompts.length;
  await sheet.getByLabel(/Reply to Refunds in the export totals/).fill(answers);
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await waitUntil(async () => (await herdr("fake.state")).prompts.slice(prompts).find((p: any) => p.target === pane));
  expect(sent.text).toBe(answers);
  expect((await herdr("fake.state")).panes.find((p: any) => p.pane_id === pane).input).toBe("");
  await expect(sheet.locator("[data-intent-status]")).toContainText("Joyride cleared it first, so only your reply went in");
  await shot(page, "C11", "reply-clears-input");
});

test("intent: each agent's goal on the map and in the rail", async ({ page }) => {
  // A question from the new worker lands in Needs you; the rail shows what it is working toward.
  const item = await raise({ level: "L3", kind: "question", title: "Add a PDF refund test as well?", worker, session: KEY, why: "Want me to add a PDF test for refunds as well?" });
  // The map lists live workers by goal (idle ones fold into a count), so make sure the fixture's worker is working.
  await herdr("fake.set_status", { pane_id: "w1:p1", status: "working" });
  await page.goto("/#/map");
  const csv = page.locator('[data-mission="csv-export"]');
  await expect(csv).toBeVisible();
  await csv.locator(".mn-title").focus();
  await page.getByRole("radio", { name: "Near" }).click();
  const vp = page.locator(".map-viewport");
  await expect(vp).toHaveAttribute("data-zoom", "near");
  await expect(csv.locator(".wl-title.is-goal", { hasText: "Add a CSV export button to the report page" })).toBeVisible({ timeout: 10000 });
  const unsorted = page.locator(`[data-worker="${worker}"]`);
  await expect(unsorted.locator(".wn-title")).toHaveText("Fix the CSV export totals for months with refunds", { timeout: 10000 });
  await expect(unsorted.locator(".wn-link")).toHaveAttribute("title", /Refunds in the export totals: Fix the CSV export totals/);
  const li = page.locator(`[data-rail="attention"] [data-attention="${item.id}"]`);
  await expect(li.locator(".att-goal")).toContainText("Fix the CSV export totals for months with refunds");
  await page.getByRole("radio", { name: "Mid" }).click();
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  // Mid lists each live worker on one line, by its goal, under what it is doing (moving or stuck).
  await expect(csv.locator(".mn-sec .wl-title.is-goal").first()).toBeVisible();
  await csv.locator(".mn-title").focus(); // the Near preset centres the last focused mission
  await page.getByRole("radio", { name: "Near" }).click();
  await expect(csv.locator(".wl-title.is-goal").first()).toBeVisible();
  await shot(page, "C11", "intent-map");
  // Opening a worker from the map shows the same intent in its header.
  const blocked = (await call<any[]>("GET", "/api/workers")).body.find((w) => w.session === `claude:${FAKE_SESSIONS.claudeBlocked}`);
  await page.goto(`/#/worker/${encodeURIComponent(blocked.id)}`);
  await expect(page.getByRole("dialog", { name: /Worker/ }).locator(".intent-goal")).toHaveText(/\S/, { timeout: 10000 });
});
