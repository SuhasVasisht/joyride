// The captain's staged-reply bug end to end, against a Herdr lab session with a real Claude Code and
// a real Codex (scripts/lab-staged.sh provisions them and runs this spec through scripts/e2e.sh).
// A reply sent from the chat view while the agent works reaches its terminal and waits in its queue;
// the chat used to drop it, because the chat log is read from the transcript, which has no entry
// until the agent takes the message. Now the chat shows it as queued right away (and after a
// reload), then as the ordinary prompt the transcript records, once.
import fs from "node:fs";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { call } from "./map-seed";
import { shot } from "./shot";
import { writePng, solidPng } from "../fixtures/images";
import { readComposer } from "../../src/modules/live/composer";

test.skip(!process.env.E2E_LAB_HERDR_SOCKET, "Needs a Herdr lab session: run scripts/lab-staged.sh");
test.setTimeout(240000);

const CP = "staged-chat";
const enc = encodeURIComponent;
const lab = (name: string) => `local:${String(process.env[name] ?? "").split("=")[0]}`;
const CLAUDE = lab("E2E_LAB_CLAUDE"), CODEX = lab("E2E_LAB_CODEX");
const jsonl = (file: string | undefined): any[] => { try { return fs.readFileSync(file!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const frame = async (worker: string) => String((await call<any>("GET", `/api/workers/${enc(worker)}/terminal/frame`)).body.text ?? "");
const workerOf = async (id: string) => (await call<any[]>("GET", "/api/workers")).body.find((w) => w.id === id);
const staged = async (id: string) => (await call<any>("GET", `/api/workers/${enc(id)}/staged`)).body.staged as any[];

/** Until the agent sits idle at an empty input box (a fresh agent redraws for a while). */
async function settled(worker: string, agent: "claude" | "codex") {
  let steady = 0;
  await expect.poll(async () => {
    const w = await workerOf(worker);
    const c = readComposer(await frame(worker), agent);
    steady = w?.controllable && w.status !== "working" && c.found && !c.text ? steady + 1 : 0;
    return steady >= 3;
  }, { timeout: 90000, intervals: [500] }).toBe(true);
}
const working = (worker: string) => expect.poll(async () => (await workerOf(worker))?.status, { timeout: 30000 }).toBe("working");

async function openChat(page: Page, worker: string) {
  await page.goto(`/#/worker/${enc(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await expect(sheet.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  return sheet;
}
async function send(sheet: Locator, text: string, files: string[] = []) {
  const box = sheet.locator(".wp-reply .reply-box");
  if (files.length) {
    await box.locator("[data-attach-input]").setInputFiles(files);
    await expect(box.locator('[data-attachment="ready"]')).toHaveCount(files.length);
  }
  await box.getByLabel(/^Reply to /).fill(text);
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box.locator("[data-intent-status]")).toHaveAttribute("data-intent-status", /sent|acked|failed/, { timeout: 30000 });
}
const userMsgs = (sheet: Locator, text: string) => sheet.locator(".chat .msg.r-user").filter({ hasText: text });
const stagedMsg = (sheet: Locator, text: string) => sheet.locator(".chat [data-staged]").filter({ has: sheet.page().locator(".msg-bubble", { hasText: text }) });
async function quickKey(sheet: Locator, worker: string, label: string) {
  await sheet.getByRole("tab", { name: "Terminal" }).click();
  const term = sheet.locator(`[data-terminal="${worker}"]`);
  await expect(term).toHaveAttribute("data-terminal-state", "live", { timeout: 15000 });
  await term.getByRole("button", { name: label, exact: true }).click();
  await sheet.getByRole("tab", { name: "Chat" }).click();
}

test("Claude Code: a reply sent mid-turn shows as queued with its image, survives a reload, then becomes the prompt once", async ({ page }) => {
  await settled(CLAUDE, "claude");
  let sheet = await openChat(page, CLAUDE);
  // The proven path: sent while idle, it is the transcript's prompt straight away.
  await send(sheet, "lab: slow 30s start a long task");
  await expect(userMsgs(sheet, "start a long task")).toHaveCount(1, { timeout: 20000 });
  await working(CLAUDE);
  const png = writePng(test.info().outputPath("."), "export.png", solidPng(160, 100, [24, 90, 180]));
  const TEXT = "Queued reply: also check the PDF export.";
  await send(sheet, TEXT, [png]);
  const bubble = stagedMsg(sheet, TEXT);
  await expect(bubble).toHaveAttribute("data-staged", "queued", { timeout: 5000 });
  await expect(bubble).toContainText("takes it when its current turn ends");
  await expect(bubble.locator(".sent-images img")).toHaveCount(1);
  await expect(sheet.locator("[data-intent-status]")).toContainText("Queued.");
  // It really is waiting in Claude Code's queue, not lost.
  expect(await frame(CLAUDE)).toContain(TEXT);
  await shot(page, CP, "lab-claude-queued");
  // A reload keeps it: the chat reads it from the reply's record, not from the page.
  await page.reload();
  sheet = await openChat(page, CLAUDE);
  await expect(stagedMsg(sheet, TEXT)).toHaveAttribute("data-staged", "queued");
  await shot(page, CP, "lab-claude-queued-after-reload");
  // The turn ends, Claude Code takes it, and the chat shows the transcript's prompt instead, once.
  await expect(userMsgs(sheet, TEXT)).toHaveCount(1, { timeout: 60000 });
  await expect(stagedMsg(sheet, TEXT)).toHaveCount(0);
  await expect(sheet.locator(".chat .msg.r-assistant").last()).toContainText("Lab model: I received 1 image", { timeout: 20000 });
  const it = (await call<any[]>("GET", `/api/intents?target=${enc(CLAUDE)}&kind=reply&limit=1`)).body[0];
  expect(it).toMatchObject({ status: "acked", result: { queued: true } });
  await shot(page, CP, "lab-claude-taken");
});

test("Claude Code: a reply taken between tool calls shows in the chat where the agent took it", async ({ page }) => {
  await settled(CLAUDE, "claude");
  const sheet = await openChat(page, CLAUDE);
  await send(sheet, "lab: tool 15s read the notes");
  await working(CLAUDE);
  const TEXT = "Mid-turn reply: the notes file is the one to read.";
  await send(sheet, TEXT);
  await expect(stagedMsg(sheet, TEXT)).toHaveAttribute("data-staged", "queued", { timeout: 5000 });
  // Claude Code hands it to the running turn as an attachment; before, the chat never showed it at all.
  await expect(userMsgs(sheet, TEXT)).toHaveCount(1, { timeout: 60000 });
  await expect(stagedMsg(sheet, TEXT)).toHaveCount(0);
  await expect(sheet.locator(".chat .msg.r-assistant").last()).toContainText("the tool ran", { timeout: 20000 });
  await shot(page, CP, "lab-claude-mid-turn");
});

test("Claude Code: messages Up pulled out of the queue are never cleared by a reply, and the chat says where they are", async ({ page }) => {
  await settled(CLAUDE, "claude");
  const sheet = await openChat(page, CLAUDE);
  await send(sheet, "lab: slow 45s another long task");
  await working(CLAUDE);
  const PULLED = "Queued, then pulled back to edit.";
  await send(sheet, PULLED);
  await expect(stagedMsg(sheet, PULLED)).toHaveAttribute("data-staged", "queued", { timeout: 5000 });
  // Up in the terminal pops the queue back into the input box.
  await quickKey(sheet, CLAUDE, "Up");
  await expect.poll(async () => readComposer(await frame(CLAUDE), "claude").text, { timeout: 10000 }).toBe(PULLED);
  await expect(stagedMsg(sheet, PULLED)).toHaveAttribute("data-staged", "pulled", { timeout: 10000 });
  await expect(stagedMsg(sheet, PULLED)).toContainText("Back in Claude's input box");
  // A reply now is refused, and the pulled-back text stays in the box (the old relay cleared it).
  const REFUSED = "A reply while the box holds them.";
  await send(sheet, REFUSED);
  await expect(stagedMsg(sheet, REFUSED)).toHaveAttribute("data-staged", "failed");
  await expect(stagedMsg(sheet, REFUSED)).toContainText("left that text alone");
  expect(readComposer(await frame(CLAUDE), "claude").text).toBe(PULLED);
  await shot(page, CP, "lab-claude-pulled-refused");
  // Enter in the terminal queues it again; the refused reply is dismissed.
  await quickKey(sheet, CLAUDE, "Enter");
  await expect(stagedMsg(sheet, PULLED)).toHaveAttribute("data-staged", "queued", { timeout: 10000 });
  await stagedMsg(sheet, REFUSED).getByRole("button", { name: "Dismiss" }).click();
  await expect(stagedMsg(sheet, REFUSED)).toHaveCount(0);
  await expect(userMsgs(sheet, PULLED)).toHaveCount(1, { timeout: 70000 });
  await expect(stagedMsg(sheet, PULLED)).toHaveCount(0);
  await shot(page, CP, "lab-claude-pulled-taken");
});

test("Codex: a reply sent mid-turn shows as queued and survives a reload until Codex takes it", async ({ page }) => {
  await settled(CODEX, "codex");
  let sheet = await openChat(page, CODEX);
  await send(sheet, "lab: slow 30s codex long task");
  await working(CODEX);
  const TEXT = "Codex queued reply: keep the sync idempotent.";
  await send(sheet, TEXT);
  await expect(stagedMsg(sheet, TEXT)).toHaveAttribute("data-staged", "queued", { timeout: 5000 });
  // Codex holds it as a message to submit after its next tool call, or at the end of the turn.
  await expect.poll(() => frame(CODEX), { timeout: 10000 }).toContain(TEXT);
  await shot(page, CP, "lab-codex-queued");
  await page.reload();
  sheet = await openChat(page, CODEX);
  await expect(stagedMsg(sheet, TEXT)).toHaveAttribute("data-staged", "queued");
  // The turn ends and Codex sends it on to the model.
  await expect.poll(() => jsonl(process.env.E2E_LAB_OPENAI_LOG).some((r) => r.text === TEXT), { timeout: 60000 }).toBe(true);
  await expect(stagedMsg(sheet, TEXT)).toHaveCount(0, { timeout: 60000 });
  expect((await staged(CODEX)).some((r) => r.state === "unclaimed")).toBe(false);
  await shot(page, CP, "lab-codex-taken");
});
