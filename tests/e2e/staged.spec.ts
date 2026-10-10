// Replies sent from the chat view that the agent hasn't taken yet. The chat log is read from the
// agent's transcript, and a reply sent while the agent works has no transcript entry until the agent
// takes it, so it used to vanish from the chat. It now shows as a staged message (queued, refused,
// never taken) that survives a reload, until the transcript shows it as an ordinary prompt, once.
// scripts/lab-staged.sh runs the same story against a real Claude Code and Codex.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { shot } from "./shot";
import { call, herdr, PORT, waitUntil } from "./map-seed";

const SID = "5a6ed000-1111-4c11-8c11-5a6ed0005a6e";
const KEY = `claude:${SID}`;
const REPO = "/tmp/joyride-fixture-repos/alpha";
const FILE = path.join(`/tmp/joyride-e2e-${PORT}`, "claude", "projects", "-tmp-joyride-fixture-repos-alpha", `${SID}.jsonl`);
const CP = "staged-chat";
let worker = "", pane = "";

let seq = 0;
const base = (ts = new Date().toISOString()) => ({ parentUuid: null, isSidechain: false, userType: "external", cwd: REPO, sessionId: SID, version: "2.1.289", gitBranch: "main", timestamp: ts, uuid: `5a6ed000-0000-4000-8000-${String(++seq).padStart(12, "0")}` });
const user = (text: string, ts?: string) => JSON.stringify({ ...base(ts), type: "user", message: { role: "user", content: text }, origin: { kind: "human" } });
const said = (text: string, ts?: string) => JSON.stringify({ ...base(ts), type: "assistant", message: { id: `msg_${seq}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } } });
const queueOp = (operation: string, content?: string) => JSON.stringify({ type: "queue-operation", operation, timestamp: new Date().toISOString(), sessionId: SID, ...(content ? { content } : {}) });
const append = (...lines: string[]) => fs.appendFileSync(FILE, lines.join("\n") + "\n");
const ago = (min: number) => new Date(Date.now() - min * 60e3).toISOString();

test.beforeAll(async () => {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, [user("Make the export totals use net amounts.", ago(5)), said("On it. Running the export tests now.", ago(4)),
    JSON.stringify({ type: "ai-title", aiTitle: "Net export totals", sessionId: SID })].join("\n") + "\n");
  await waitUntil(async () => { await call("POST", "/api/sessions/reindex"); return (await call("GET", `/api/sessions/${encodeURIComponent(KEY)}`)).status === 200; }, 15000);
  pane = (await herdr("fake.add_pane", {
    workspace_id: "w1", cwd: REPO, agent: "claude", agent_status: "working", title: "Net export totals", cols: 92, rows: 20,
    agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: SID }, screen: ["● Running the export tests…"],
  })).pane.pane_id;
  worker = `local:${pane}`;
  await waitUntil(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.id === worker && w.session === KEY && w.controllable), 10000);
});

test.afterAll(async () => {
  if (pane) await herdr("fake.close_pane", { pane_id: pane });
});

async function openChat(page: Page) {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/sessions/${encodeURIComponent(KEY)}/transcript?`) && r.ok()),
    page.goto(`/#/worker/${encodeURIComponent(worker)}`),
  ]);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.locator(".chat .msg.r-assistant").first()).toContainText("Running the export tests now");
  return sheet;
}
const working = () => herdr("fake.set_status", { pane_id: pane, status: "working" });

test("a reply sent while the agent works shows as queued, survives a reload, then becomes the prompt once", async ({ page }) => {
  await working();
  let sheet = await openChat(page);
  const TEXT = "Also add a PDF refund test.";
  const prompts = (await herdr("fake.state")).prompts.length;
  await sheet.getByLabel(/^Reply to /).fill(TEXT);
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  // Claude Code queues it until its turn ends, and records that in its transcript.
  await waitUntil(async () => (await herdr("fake.state")).prompts.slice(prompts).some((p: any) => p.text === TEXT));
  append(queueOp("enqueue", TEXT));
  const bubble = sheet.locator(`.chat [data-staged]`).filter({ hasText: TEXT });
  await expect(bubble).toHaveAttribute("data-staged", "queued");
  await expect(bubble).toContainText("Queued. Claude takes it when its current turn ends.");
  await expect(sheet.locator("[data-intent-status]")).toContainText("Queued.");
  await expect(sheet.locator(".chat .msg.r-user").filter({ hasText: TEXT })).toHaveCount(0);
  await shot(page, CP, "queued");
  await page.reload();
  sheet = await openChat(page);
  await expect(sheet.locator(`.chat [data-staged="queued"]`).filter({ hasText: TEXT })).toBeVisible();
  // The turn ends: the queue hands it over, and it is an ordinary prompt in the transcript.
  append(said("Export tests pass with net totals."), queueOp("dequeue"), user(TEXT), said("Added `pdf-refund.test.ts`."));
  await expect(sheet.locator(".chat .msg.r-user").filter({ hasText: TEXT })).toHaveCount(1, { timeout: 15000 });
  await expect(sheet.locator(".chat [data-staged]")).toHaveCount(0);
  await expect(sheet.locator(".chat .msg.r-assistant").last()).toContainText("pdf-refund.test.ts");
  await shot(page, CP, "taken");
  // The chat can render the transcript before the staged refresh or sweep acknowledges the intent.
  await expect.poll(async () => (await call<any[]>("GET", `/api/intents?target=${encodeURIComponent(worker)}&kind=reply&limit=1`)).body[0],
    { timeout: 15000 }).toMatchObject({ status: "acked", result: { queued: true } });
});

test("a reply the relay refused stays in the chat with the reason, and Send again delivers it", async ({ page }) => {
  await working();
  // Mid-turn, the input box holds text (a draft, or queued messages Up pulled back): Joyride won't clear it.
  await herdr("fake.set_screen", { pane_id: pane, input: "a draft typed in the terminal" });
  const sheet = await openChat(page);
  const TEXT = "Use the shared totals helper.";
  await sheet.getByLabel(/^Reply to /).fill(TEXT);
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  const bubble = sheet.locator(`.chat [data-staged]`).filter({ has: page.locator(".msg-bubble", { hasText: TEXT }) });
  await expect(bubble).toHaveAttribute("data-staged", "failed");
  await expect(bubble).toContainText("Not sent.");
  await expect(bubble).toContainText("left that text alone");
  await expect(sheet.locator("[data-intent-status]")).toContainText("The message above says why");
  await expect(sheet.getByLabel(/^Reply to /)).toHaveValue("");
  expect((await herdr("fake.state")).panes.find((p: any) => p.pane_id === pane).input).toBe("a draft typed in the terminal");
  await shot(page, CP, "refused");
  // The captain clears the box in the terminal, then sends it again from the chat.
  await herdr("fake.set_screen", { pane_id: pane, input: "" });
  const prompts = (await herdr("fake.state")).prompts.length;
  await bubble.getByRole("button", { name: "Send again" }).click();
  await waitUntil(async () => (await herdr("fake.state")).prompts.slice(prompts).some((p: any) => p.text === TEXT));
  await expect(sheet.locator(`.chat [data-staged="failed"]`)).toHaveCount(0);
  await expect(sheet.locator(`.chat [data-staged]`).filter({ hasText: TEXT })).toHaveAttribute("data-staged", /queued|delivered/);
  append(user(TEXT), said("Switched to the shared helper."));
  await expect(sheet.locator(".chat .msg.r-user").filter({ hasText: TEXT })).toHaveCount(1, { timeout: 15000 });
  await expect(sheet.locator(".chat [data-staged]")).toHaveCount(0);
});

test("a reply the agent never takes says so, and can be dismissed", async ({ page }) => {
  test.setTimeout(90000);
  await herdr("fake.set_status", { pane_id: pane, status: "idle" });
  const sheet = await openChat(page);
  const TEXT = "Ping: are you still there?";
  await sheet.getByLabel(/^Reply to /).fill(TEXT);
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  // The fake takes the keystrokes, but nothing reaches the transcript (an agent whose input was lost).
  const bubble = sheet.locator(`.chat [data-staged]`).filter({ hasText: TEXT });
  await expect(bubble).toHaveAttribute("data-staged", "delivered");
  await expect(bubble).toHaveAttribute("data-staged", "unclaimed", { timeout: 45000 });
  await expect(bubble).toContainText("Claude never took this message");
  await shot(page, CP, "unclaimed");
  await bubble.getByRole("button", { name: "Dismiss" }).click();
  await expect(bubble).toHaveCount(0);
  await page.reload();
  await openChat(page);
  await expect(page.locator(`.chat [data-staged]`)).toHaveCount(0);
});
