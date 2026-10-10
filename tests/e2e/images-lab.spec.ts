// Images through the relay to real agents, against a Herdr lab session (scripts/lab-images.sh
// provisions it and runs this spec through scripts/e2e.sh). The captain attaches images in the
// worker's reply box and sends; then:
//   Claude Code: its transcript holds the images as image blocks, and the model request it made
//                (to the lab's fake Messages API) carried exactly those bytes; the lab model's
//                answer, naming each image's size and hash, shows in the agent's terminal.
//   Codex:       its rollout holds the images as input_image items with exactly those bytes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { call } from "./map-seed";
import { shot } from "./shot";
import { writePng } from "../fixtures/images";
import { readComposer } from "../../src/modules/live/composer";

test.skip(!process.env.E2E_LAB_HERDR_SOCKET, "Needs a Herdr lab session: run scripts/lab-images.sh");
test.setTimeout(150000);

const port = Number(process.env.E2E_PORT ?? 4404);
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${port}/env.json`, "utf8")) as Record<string, string>;
const CP = "chat-images";
const enc = encodeURIComponent;
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** "w1:p1=/path/to/config" from the lab script. */
function lab(name: string) {
  const [pane, dir] = String(process.env[name] ?? "").split("=");
  return { worker: `local:${pane}`, dir };
}
const jsonl = (file: string): any[] => { try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function files(dir: string, ext = ".jsonl"): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
}

const frame = async (worker: string) => String((await call<any>("GET", `/api/workers/${enc(worker)}/terminal/frame`)).body.text ?? "");

/** Wait until find() returns something, then return it. */
async function found<T>(find: () => T | undefined, timeout = 30000): Promise<T> {
  await expect.poll(() => Boolean(find()), { timeout }).toBe(true);
  return find()!;
}

/** Attach the images in the worker's reply box, type the text, send; returns the stored paths. */
async function sendWithImages(page: Page, name: string, worker: string, text: string, pngs: string[]) {
  let seen: any[] = [];
  await expect.poll(async () => { seen = (await call<any[]>("GET", "/api/workers")).body; return seen.some((w) => w.id === worker && w.controllable); },
    { timeout: 60000, message: () => `worker ${worker} not controllable; workers: ${JSON.stringify(seen.map((w) => ({ id: w.id, agent: w.agent, controllable: w.controllable, status: w.status })))}` } as any).toBe(true);
  // A freshly started agent redraws for a while; wait until its empty input box holds still.
  let steady = 0;
  await expect.poll(async () => { const c = readComposer(await frame(worker), name); steady = c.found && !c.text ? steady + 1 : 0; return steady >= 4; }, { timeout: 45000, intervals: [500] }).toBe(true);
  await page.goto(`/#/worker/${enc(worker)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const box = sheet.locator(".wp-reply .reply-box");
  await box.locator("[data-attach-input]").setInputFiles(pngs);
  await expect(box.locator('[data-attachment="ready"]')).toHaveCount(pngs.length);
  await box.getByLabel(/^Reply to /).fill(text);
  await shot(page, CP, `lab-${name}-compose`);
  await box.getByRole("button", { name: "Send", exact: true }).click();
  await expect(box.locator("[data-intent-status]")).toHaveAttribute("data-intent-status", /sent|acked|failed/, { timeout: 30000 });
  const it = (await call<any[]>("GET", `/api/intents?target=${enc(worker)}&kind=reply&limit=1`)).body[0];
  if (it.status === "failed") {
    const screen = (await call<any>("GET", `/api/workers/${enc(worker)}/screen`)).body;
    fs.writeFileSync(test.info().outputPath("agent-screen.txt"), `${it.error}\n--- screen ---\n${screen.screen ?? JSON.stringify(screen)}\n--- frame ---\n${await frame(worker)}`);
  }
  expect(it.status, it.error).not.toBe("failed");
  await expect(box.locator(".intent-status .sent-images img")).toHaveCount(pngs.length);
  return { sheet, stored: it.payload.images as string[] };
}

async function terminalShows(sheet: ReturnType<Page["getByRole"]>, worker: string, text: string | RegExp) {
  await sheet.getByRole("tab", { name: "Terminal" }).click();
  const term = sheet.locator(`[data-terminal="${worker}"]`);
  await expect(term).toHaveAttribute("data-terminal-state", "live", { timeout: 15000 });
  await expect(term.locator(".xterm-rows")).toContainText(text, { timeout: 30000 });
}

/** Distinctive pixels, with readable text, so exact-byte assertions prove which image arrived. */
async function distinctivePng(page: Page, name: string, label: string, color: string) {
  const bytes = await page.evaluate(async ({ label, color }) => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 200);
    ctx.fillStyle = "white"; ctx.font = "bold 38px sans-serif"; ctx.fillText(label, 24, 115);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, { label, color });
  return writePng(path.join(env.JOYRIDE_RUNTIME, "lab"), name, Buffer.from(bytes));
}

async function inlineImages(page: Page, worker: string, count: number, sessionKey?: string) {
  await call("POST", "/api/sessions/reindex");
  const w = (await call<any>("GET", `/api/workers/${enc(worker)}`)).body;
  // A fresh Codex lab has no hooks or Herdr session ref. Read its actual indexed
  // session chat instead of manufacturing a hook to associate it with the pane.
  const route = w.session ? `worker/${enc(worker)}` : `session/${enc(sessionKey ?? "")}`;
  console.log(`Checking inline images in ${route}`);
  await page.goto(`/#/${route}`);
  const sheet = page.getByRole("dialog", { name: /Worker|Session/ });
  if (w.session) await sheet.getByRole("tab", { name: "Chat", exact: true }).click();
  const chat = sheet.locator(".chat");
  const bubble = chat.locator(".msg.r-user").last();
  await expect(bubble.locator(".sent-images img")).toHaveCount(count, { timeout: 45000 });
  await expect(bubble).not.toContainText("[Image #");
  await bubble.scrollIntoViewIfNeeded();
  await shot(page, CP, `lab-${count === 2 ? "claude" : "codex"}-inline`);
}

test("Claude Code attaches each image and sends its bytes to the model", async ({ page }) => {
  const { worker, dir } = lab("E2E_LAB_CLAUDE");
  const pngs = [await distinctivePng(page, "purple.png", "PURPLE-42", "#7A4E9C"), await distinctivePng(page, "teal.png", "TEAL-17", "#2E7D6B")];
  const hashes = pngs.map((p) => sha(fs.readFileSync(p)));
  const { sheet, stored } = await sendWithImages(page, "claude", worker, "What do these two screenshots show?", pngs);
  expect(stored.map((p) => sha(fs.readFileSync(p)))).toEqual(hashes);

  // The model request carried both images, byte for byte.
  const log = process.env.E2E_LAB_MODEL_LOG!;
  const req = await found(() => jsonl(log).find((r) => r.stream && r.images?.length === 2 && r.text.includes("What do these two screenshots show?")));
  expect(req.images.map((i: any) => [i.type, i.source_type])).toEqual([["image", "base64"], ["image", "base64"]]);
  console.log(`Claude model received: ${JSON.stringify(req.images)}`);
  fs.writeFileSync(test.info().outputPath("agent-received.json"), JSON.stringify(req.images, null, 2));
  expect(req.images.map((i: any) => i.media_type)).toEqual(["image/png", "image/png"]);
  expect(req.images.map((i: any) => i.sha256)).toEqual(hashes);

  // Claude Code's transcript: one prompt with two image blocks, and the paths they came from.
  const prompt = await found(() => files(path.join(dir, "projects")).flatMap(jsonl).find((r) => r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((b: any) => b.type === "image")));
  expect(prompt.message.content.filter((b: any) => b.type === "image").map((b: any) => sha(Buffer.from(b.source.data, "base64")))).toEqual(hashes);
  // Claude Code drops the space between its last placeholder and the pasted text.
  expect(prompt.message.content.find((b: any) => b.type === "text").text).toMatch(/^\[Image #1\] \[Image #2\] ?What do these two screenshots show\?$/);
  const meta = await found(() => files(path.join(dir, "projects")).flatMap(jsonl).find((r) => r.isMeta && JSON.stringify(r.message?.content ?? "").includes("[Image: source:")));
  expect(meta.message.content.map((b: any) => b.text)).toEqual(stored.map((p) => `[Image: source: ${p}]`));

  // The lab model's answer, naming both images, shows in the agent's own terminal.
  await terminalShows(sheet, worker, "Lab model: I received 2 images");
  await shot(page, CP, "lab-claude-answer");
  await inlineImages(page, worker, 2);
});

test("Codex attaches each image to the turn", async ({ page }) => {
  const { worker, dir } = lab("E2E_LAB_CODEX");
  const png = await distinctivePng(page, "codex-purple.png", "PURPLE-42", "#7A4E9C");
  const { sheet, stored } = await sendWithImages(page, "codex", worker, "What does this screenshot show?", [png]);
  const want = sha(fs.readFileSync(png));
  // The rollout: the image as a local_image (the stored path) and as input_image data with the same bytes.
  const turn = await found(() => files(path.join(dir, "sessions")).flatMap(jsonl).find((r) => r.type === "response_item" && r.payload?.role === "user" && r.payload.content?.some((b: any) => b.type === "input_image")));
  const img = turn.payload.content.find((b: any) => b.type === "input_image");
  const received = Buffer.from(String(img.image_url).replace(/^data:[^,]*;base64,/, ""), "base64");
  expect(img.image_url).toMatch(/^data:image\/png;base64,/);
  expect(sha(received)).toBe(want);
  const receipt = { type: img.type, encoding: "data:image/png;base64", bytes: received.length, sha256: sha(received) };
  console.log(`Codex rollout received: ${JSON.stringify(receipt)}`);
  fs.writeFileSync(test.info().outputPath("agent-received.json"), JSON.stringify(receipt, null, 2));
  expect(turn.payload.content.some((b: any) => typeof b.text === "string" && b.text.includes(`path="${stored[0]}"`))).toBe(true);
  expect(turn.payload.content.at(-1).text).toBe("[Image #1] What does this screenshot show?");
  await terminalShows(sheet, worker, "[Image #1] What does this screenshot show?");
  await shot(page, CP, "lab-codex-sent");
  const meta = files(path.join(dir, "sessions")).flatMap(jsonl).find((r) => r.type === "session_meta");
  expect(meta?.payload.id).toBeTruthy();
  await inlineImages(page, worker, 1, `codex:${meta.payload.id}`);
});
