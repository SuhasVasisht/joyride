// The captain's relay bug end to end, against a real Herdr lab session and real Claude Code
// panes (scripts/lab-relay.sh provisions them and runs this spec through scripts/e2e.sh).
// Each pane's prompt history starts with the launch prompt; what Claude Code actually submitted
// is read back from its own history file, with paste tokens expanded.
import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { call } from "./map-seed";
import { readComposer } from "../../src/modules/live/composer";

const LAUNCH = "Ahoy. I am the captain. Please run your first-time setup and tell me what you need from me. All projects are local-only: never push, never open PRs. My work happens through Joyride (http://127.0.0.1:4317), which will relay your questions to me.";
// Shaped like the captain's two broken replies: one long dictated line, and numbered answers.
const DICTATED = "you should be allowed to install all of this so as part of this quota thing can I get that as a visual thing in my dashboard " +
  "somewhere of what usage I have across what service so I have one Claude Code and one Codex subscription right now so something over there " +
  "would be good to see you know the five hour limit weekly limit and reset and that kind of stuff and then the other thing I want to work on is " +
  "having the Joyride memory service and the First Mate memory service be the same I don't know how we're going to converge on it but I want to " +
  "be able to do that and then the other thing is potentially changing the way First Mate talks to me so let's think about that as well please";
const NUMBERED = "1. I should have only one version of Joyride sitting and working\n\n2. I recommend A in a clean way\n\n3. Did that\n\n4. Save that as a permanent preference";

test.skip(!process.env.E2E_LAB_HERDR_SOCKET, "Needs a Herdr lab session: run scripts/lab-relay.sh");

/** "w1:p1=/path/to/claude-config" from the lab script. */
function lab(name: string) {
  const [pane, dir] = String(process.env[name] ?? "").split("=");
  return { worker: `local:${pane}`, history: `${dir}/history.jsonl` };
}
const entries = (file: string): any[] => { try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const expand = (e: any): string => String(e.display).replace(/\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g, (m, n) => e.pastedContents?.[n]?.content ?? m);
const enc = encodeURIComponent;
const inputBox = async (worker: string) => readComposer((await call<any>("GET", `/api/workers/${enc(worker)}/terminal/frame`)).body.text ?? "", "claude");

async function openTerminal(page: Page, worker: string) {
  await expect.poll(async () => (await call<any[]>("GET", "/api/workers")).body.some((w) => w.id === worker && w.controllable), { timeout: 30000 }).toBe(true);
  await page.goto(`/#/worker/${enc(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  await sheet.getByRole("tab", { name: "Terminal" }).click();
  const term = sheet.locator(`[data-terminal="${worker}"]`);
  await expect(term).toHaveAttribute("data-terminal-state", "live", { timeout: 15000 });
  await expect(term.locator(".xterm-rows")).toContainText("Claude Code", { timeout: 15000 });
  return { sheet, term };
}

/** Send from the worker's reply box; resolves to what Claude Code submitted. */
async function replyAndRead(page: Page, sheet: ReturnType<Page["getByRole"]>, history: string, text: string): Promise<string> {
  const before = entries(history).length;
  await sheet.getByRole("tab", { name: "Chat" }).click();
  await sheet.getByLabel(/^Reply to /).fill(text);
  await sheet.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => entries(history).length, { timeout: 20000 }).toBeGreaterThan(before);
  return expand(entries(history).at(-1));
}

test("scrolling over the browser terminal types nothing, so the next reply arrives exactly as written", async ({ page }, info) => {
  const { worker, history } = lab("E2E_LAB_SCROLL");
  const { sheet, term } = await openTerminal(page, worker);
  const box = (await term.locator(".term-screen").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(60); }
  for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(60); }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("after-scroll.png") });
  expect.soft((await inputBox(worker)).text, "scrolling recalled an old prompt into the input box").toBe("");
  const sent = await replyAndRead(page, sheet, history, DICTATED);
  await page.screenshot({ path: info.outputPath("after-reply.png") });
  expect(sent).toBe(DICTATED);
});

test("after an Up key recalls the launch prompt into the input box, a reply still goes in alone", async ({ page }, info) => {
  const { worker, history } = lab("E2E_LAB_UP");
  const { sheet, term } = await openTerminal(page, worker);
  // Up from the quick-key row (an arrow typed in the terminal does the same): Claude Code puts its last prompt back in the box.
  await term.getByRole("button", { name: "Up", exact: true }).click();
  await expect.poll(async () => (await inputBox(worker)).text.replace(/\s+/g, " "), { timeout: 10000 }).toBe(LAUNCH);
  await page.screenshot({ path: info.outputPath("recalled.png") });
  const sent = await replyAndRead(page, sheet, history, NUMBERED);
  await page.screenshot({ path: info.outputPath("after-reply.png") });
  expect(sent).toBe(NUMBERED);
  await expect(sheet.locator("[data-intent-status]")).toContainText("Joyride cleared it first");
});
