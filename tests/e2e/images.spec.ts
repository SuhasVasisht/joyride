// Images on a message, end to end against the sandbox daemon and the fake Herdr: attach by file
// picker, paste and drag-and-drop, see thumbnails before sending, the relay attaches each one in
// the agent's input box, and the sent message shows them (intent status and the chat history).
// An agent that can't load images says so instead of offering to send them.
import fs from "node:fs";
import path from "node:path";
import { test, expect, type Locator } from "@playwright/test";
import { shot } from "./shot";
import { call, FAKE_SESSIONS, herdr, seedWorld, W, waitUntil } from "./map-seed";
import { PNG_1PX, writePng } from "../fixtures/images";

const port = Number(process.env.E2E_PORT ?? 4399);
const env = JSON.parse(fs.readFileSync(`/tmp/joyride-e2e-${port}/env.json`, "utf8")) as Record<string, string>;
const files = path.join(env.JOYRIDE_RUNTIME, "e2e-images");
const CP = "chat-images";

/** A small, visibly distinct PNG made in the page's canvas (so thumbnails show something). */
async function makePng(box: Locator, label: string, color: string): Promise<number[]> {
  return box.evaluate(async (_el, [text, fill]) => {
    const c = document.createElement("canvas");
    c.width = 240; c.height = 150;
    const g = c.getContext("2d")!;
    g.fillStyle = fill; g.fillRect(0, 0, 240, 150);
    g.fillStyle = "#fff"; g.font = "bold 30px sans-serif"; g.fillText(text, 20, 88);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, [label, color] as const);
}

/** Paste an image file into a textarea the way a screenshot paste arrives. */
async function pasteImage(target: Locator, bytes: number[], name: string) {
  await target.evaluate((el, [b, n]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b as number[])], n as string, { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [bytes, name] as const);
}

/** Drop an image file onto a drop zone. */
async function dropImage(target: Locator, bytes: number[], name: string, opts: { hover?: boolean } = {}) {
  await target.evaluate((el, [b, n, hoverOnly]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b as number[])], n as string, { type: "image/png" }));
    el.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    if (!hoverOnly) el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [bytes, name, Boolean(opts.hover)] as const);
}

test.describe.configure({ mode: "serial" });
let unsupportedPane = "";
let originalTranscript: { file: string; text: string } | undefined;
test.beforeAll(async () => {
  await seedWorld();
  const session = (await call("GET", `/api/sessions/${encodeURIComponent(`claude:${FAKE_SESSIONS.claudeWorking}`)}`)).body;
  expect(session.transcript.startsWith(env.JOYRIDE_CLAUDE_DIR)).toBe(true);
  originalTranscript = { file: session.transcript, text: fs.readFileSync(session.transcript, "utf8") };
});
test.afterAll(async () => {
  if (unsupportedPane) await herdr("fake.close_pane", { pane_id: unsupportedPane });
  if (originalTranscript) {
    fs.writeFileSync(originalTranscript.file, originalTranscript.text);
    await call("POST", "/api/sessions/reindex");
  }
});

test("attach by picker, paste and drop, see thumbnails, send: the agent gets each image attached", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(W.codex)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const box = sheet.locator(".wp-reply .reply-box");
  const input = box.getByLabel(/Reply to Idempotent sync job/);
  await expect(input).toBeVisible();

  // File picker.
  const picked = writePng(files, "picked.png");
  await box.locator("[data-attach-input]").setInputFiles(picked);
  // Paste (a screenshot on the clipboard).
  await pasteImage(input, await makePng(box, "PASTED", "#2B5B84"), "pasted.png");
  // Drag and drop: the box highlights while a file is over it.
  await dropImage(box, await makePng(box, "DROPPED", "#2E7D6B"), "dropped.png", { hover: true });
  await expect(box.locator(".drop-hint")).toHaveText("Drop images to attach them");
  await shot(page, CP, "attach-drag-over");
  await dropImage(box, await makePng(box, "DROPPED", "#2E7D6B"), "dropped.png");
  await expect(box.locator(".drop-hint")).toHaveCount(0);

  const thumbs = box.locator(".attach-list .attach-item");
  await expect(thumbs).toHaveCount(3);
  await expect(box.locator('[data-attachment="ready"]')).toHaveCount(3);
  await input.fill("The sync chart is cut off on the right. These three screenshots show it.");
  await shot(page, CP, "attach-compose");

  // Remove one before sending.
  await box.getByRole("button", { name: "Remove picked.png" }).click();
  await expect(thumbs).toHaveCount(2);

  const before = (await herdr("fake.state")).prompts.length;
  await box.getByRole("button", { name: "Send" }).click();
  const prompt = await waitUntil(async () => (await herdr("fake.state")).prompts.slice(before).find((p: any) => p.target === "w2:p1"));
  expect(prompt.text).toBe("[Image #1] [Image #2] The sync chart is cut off on the right. These three screenshots show it.");
  expect(prompt.images).toHaveLength(2);
  for (const p of prompt.images) {
    expect(p).toMatch(new RegExp(`^${fs.realpathSync(env.JOYRIDE_RUNTIME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/uploads/\\d{4}-\\d{2}-\\d{2}/[a-z0-9]+\\.png$`));
    expect(fs.existsSync(p)).toBe(true);
  }
  // Each path went in as its own paste, never inside the prompt text.
  const pastes = (await herdr("fake.state")).inputs.filter((x: any) => x.target === "w2:p1" && x.text?.startsWith("\x1b[200~")).slice(-2).map((x: any) => x.text);
  expect(pastes).toEqual(prompt.images.map((p: string) => `\x1b[200~${p}\x1b[201~`));

  await expect(box.locator("[data-intent-status]")).toContainText(/Delivered|picked up/);
  const sent = box.locator(".intent-status .sent-images img");
  await expect(sent).toHaveCount(2);
  await expect(thumbs).toHaveCount(0);
  await expect.poll(() => sent.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
  await shot(page, CP, "attach-sent");

  // The conversation shows them too: the agent's transcript records the attached images.
  const rollout = path.join(env.JOYRIDE_CODEX_DIR, "sessions", "rollout-x2.jsonl");
  const ts = new Date().toISOString();
  const content = [
    ...prompt.images.flatMap((p: string, i: number) => [
      { type: "input_text", text: `<image name=[Image #${i + 1}] path="${p}">` }, { type: "input_image", image_url: `data:image/png;base64,${PNG_1PX.toString("base64")}` }, { type: "input_text", text: "</image>" },
    ]),
    { type: "input_text", text: prompt.text },
  ];
  // This fixture session is an older Codex rollout: the human turn is a user_message event too.
  const answer = "I see it: the right edge of the chart is clipped. Fixing the container width.";
  fs.appendFileSync(rollout, [
    { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: prompt.text, images: [], local_images: prompt.images } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content } },
    { timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: answer } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await page.reload();
  const chat = page.getByRole("dialog", { name: /Worker/ }).locator(`[data-chat="codex:${FAKE_SESSIONS.codexIdle}"]`);
  const mine = chat.locator(".msg.r-user").last();
  await expect(mine).toContainText("The sync chart is cut off on the right.");
  await expect(mine).not.toContainText("[Image #1]");
  await expect(mine.locator(".sent-images img")).toHaveCount(2);
  await expect.poll(() => mine.locator(".sent-images img").first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
  await mine.scrollIntoViewIfNeeded();
  await shot(page, CP, "chat-history");
});

test("the same screenshot pasted again and again stays separate images at every hop, through a reload", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(W.codex)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const box = sheet.locator(".wp-reply .reply-box");
  const input = box.getByLabel(/Reply to Idempotent sync job/);
  await expect(input).toBeVisible();

  // Clipboard screenshots arrive with the same default name; these also have identical bytes.
  const same = await makePng(box, "SAME", "#7A4E9C");
  for (let i = 0; i < 4; i++) await pasteImage(input, same, "image.png");
  const thumbs = box.locator(".attach-list .attach-item");
  await expect(thumbs).toHaveCount(4);
  await expect(box.locator('[data-attachment="ready"]')).toHaveCount(4);
  for (let i = 1; i <= 4; i++) await expect(box.getByRole("button", { name: `Remove image.png (${i} of 4)`, exact: true })).toHaveCount(1);
  await shot(page, CP, "same-name-pasted");

  // Each is removable on its own: taking out one leaves the other three.
  await box.getByRole("button", { name: "Remove image.png (2 of 4)", exact: true }).click();
  await expect(thumbs).toHaveCount(3);
  await expect(box.getByRole("button", { name: /^Remove image\.png \(\d of 3\)$/ })).toHaveCount(3);

  await input.fill("Same screenshot, three times.");
  const before = (await herdr("fake.state")).prompts.length;
  await box.getByRole("button", { name: "Send" }).click();
  const prompt = await waitUntil(async () => (await herdr("fake.state")).prompts.slice(before).find((p: any) => p.target === "w2:p1"));
  // The relay: three attachments, three distinct stored files, each with the pasted bytes.
  expect(prompt.text).toBe("[Image #1] [Image #2] [Image #3] Same screenshot, three times.");
  expect(prompt.images).toHaveLength(3);
  expect(new Set(prompt.images).size).toBe(3);
  for (const p of prompt.images) expect([...fs.readFileSync(p)]).toEqual(same);
  // The intent record keeps the three paths in the order they were pasted.
  const list: any[] = (await call("GET", `/api/intents?target=${encodeURIComponent(W.codex)}&kind=reply`)).body;
  const rec = list.find((it: any) => it.kind === "reply" && it.payload?.text === "Same screenshot, three times.");
  expect(rec?.payload.images).toEqual(prompt.images);

  await expect(box.locator("[data-intent-status]")).toContainText(/Delivered|picked up/);
  await expect(box.locator(".intent-status .sent-images img")).toHaveCount(3);
  await expect(thumbs).toHaveCount(0);

  // The agent's transcript records the three attachments; after a reload the history shows all three.
  const rollout = path.join(env.JOYRIDE_CODEX_DIR, "sessions", "rollout-x2.jsonl");
  const ts = new Date().toISOString();
  const content = [
    ...prompt.images.flatMap((p: string, i: number) => [
      { type: "input_text", text: `<image name=[Image #${i + 1}] path="${p}">` }, { type: "input_image", image_url: `data:image/png;base64,${PNG_1PX.toString("base64")}` }, { type: "input_text", text: "</image>" },
    ]),
    { type: "input_text", text: prompt.text },
  ];
  const answer = "Three copies of the same screenshot; looking at the chart now.";
  fs.appendFileSync(rollout, [
    { timestamp: ts, type: "event_msg", payload: { type: "user_message", message: prompt.text, images: [], local_images: prompt.images } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content } },
    { timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: answer } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await page.reload();
  const chat = page.getByRole("dialog", { name: /Worker/ }).locator(`[data-chat="codex:${FAKE_SESSIONS.codexIdle}"]`);
  const mine = chat.locator(".msg.r-user").last();
  await expect(mine).toContainText("Same screenshot, three times.");
  const shown = mine.locator(".sent-images img");
  await expect(shown).toHaveCount(3);
  const srcs = await shown.evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src")));
  expect(new Set(srcs).size).toBe(3);
  for (let i = 0; i < 3; i++) await expect.poll(() => shown.nth(i).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(240);
  await mine.scrollIntoViewIfNeeded();
  await shot(page, CP, "same-name-history");
});

test("wrong type and oversized files get a clear error and are not attached", async ({ page }) => {
  await page.goto(`/#/worker/${encodeURIComponent(W.codex)}`);
  const box = page.getByRole("dialog", { name: /Worker/ }).locator(".wp-reply .reply-box");
  fs.mkdirSync(files, { recursive: true });
  const pdf = path.join(files, "notes.pdf");
  fs.writeFileSync(pdf, "%PDF-1.7 not an image");
  await box.locator("[data-attach-input]").setInputFiles(pdf);
  await expect(box.locator(".attach-note")).toContainText("notes.pdf is not a PNG, JPEG, GIF or WebP image.");
  const big = path.join(files, "huge.png");
  fs.writeFileSync(big, Buffer.concat([PNG_1PX, Buffer.alloc(11 * 1024 * 1024)]));
  await box.locator("[data-attach-input]").setInputFiles(big);
  await expect(box.locator(".attach-note")).toContainText("huge.png is 11.0 MB; the limit is 10.0 MB. Shrink or crop it first.");
  await expect(box.locator(".attach-item")).toHaveCount(0);
  await shot(page, CP, "attach-errors");
  // The daemon enforces the same rules if a page skips them.
  const r = await call("POST", "/api/uploads", { name: "notes.pdf", data: Buffer.from("%PDF-1.7").toString("base64") });
  expect(r.status).toBe(415);
});

test("an agent that can't load images from a path says so instead of offering to send them", async ({ page }) => {
  const pane = (await herdr("fake.add_pane", { cwd: "/tmp/joyride-fixture-repos/beta", agent: "pi", agent_status: "idle", title: "Pi helper", label: "beta" })).pane;
  unsupportedPane = pane.pane_id;
  const worker = `local:${pane.pane_id}`;
  await waitUntil(async () => (await call("GET", `/api/workers/${encodeURIComponent(worker)}`)).status === 200);
  await page.goto(`/#/worker/${encodeURIComponent(worker)}`);
  const box = page.getByRole("dialog", { name: /Worker/ }).locator(".wp-reply .reply-box");
  const clip = box.getByRole("button", { name: "Attach images" });
  await expect(clip).toHaveAttribute("aria-disabled", "true");
  await clip.click({ force: true });
  await expect(box.locator(".attach-note")).toContainText("This agent (pi) can't load images from a file path, so Joyride won't send it images.");
  await dropImage(box, [...PNG_1PX], "dropped.png", { hover: true });
  await expect(box.locator(".drop-hint")).toContainText("can't load images from a file path");
  await shot(page, CP, "agent-without-images");
  await dropImage(box, [...PNG_1PX], "dropped.png");
  await expect(box.locator(".attach-item")).toHaveCount(0);
  await expect(box.locator(".attach-note")).toContainText("(pi) can't load images from a file path");
  await shot(page, CP, "agent-without-images-note");
  // And the relay refuses it too.
  const img = (await call("POST", "/api/uploads", { name: "x.png", data: PNG_1PX.toString("base64") })).body.path;
  const it = (await call("POST", "/api/intents", { kind: "reply", target: worker, payload: { text: "look", images: [img] } })).body;
  expect(it.status).toBe("failed");
  expect(it.error).toMatch(/\(pi\) can't load images from a file path/);
});

test("image-only staged and taken Claude replies stay inline; the lightbox returns to the chat", async ({ page, context }) => {
  await herdr("fake.set_status", { pane_id: "w1:p1", status: "working" });
  await page.goto(`/#/worker/${encodeURIComponent(W.working)}`);
  const sheet = page.getByRole("dialog", { name: /Worker/ });
  const box = sheet.locator(".wp-reply .reply-box");
  const route = page.url();
  const pngs = ["PURPLE-42", "TEAL-17"].map((label) => writePng(files, `${label}.png`));
  await box.locator("[data-attach-input]").setInputFiles(pngs);
  await expect(box.locator('[data-attachment="ready"]')).toHaveCount(2);
  // Composer previews use the same lightbox before the images go out.
  await box.locator(".attach-item .image-preview").first().click();
  let viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "Close image viewer" }).click();
  await expect(viewer).toHaveCount(0);
  await box.getByRole("button", { name: "Send", exact: true }).click();
  const staged = sheet.locator('.chat [data-staged="queued"]').last();
  await expect(staged.locator(".sent-images img")).toHaveCount(2);
  await staged.locator(".image-preview").first().click();
  viewer = page.getByRole("dialog", { name: "Image viewer" });
  await expect(viewer).toContainText("1 of 2");
  const first = await viewer.locator("img").getAttribute("src");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("2 of 2");
  await expect(viewer.locator("img")).not.toHaveAttribute("src", first!);
  await page.keyboard.press("ArrowLeft");
  await expect(viewer.locator("img")).toHaveAttribute("src", first!);
  await expect(viewer.getByRole("link", { name: "Open original" })).toHaveAttribute("target", "_blank");
  await shot(page, CP, "image-lightbox");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(sheet).toBeVisible();
  expect(page.url()).toBe(route);
  expect(context.pages()).toHaveLength(1);
  await expect(staged.locator(".image-preview").first()).toBeFocused();

  // A real queued-command shape has image blocks but no source metadata. The session intent
  // recovers the paths, even for a prompt that carries no text.
  const it = (await call<any[]>("GET", `/api/intents?target=${encodeURIComponent(W.working)}&kind=reply&limit=1`)).body[0];
  const session = (await call("GET", `/api/sessions/${encodeURIComponent(`claude:${FAKE_SESSIONS.claudeWorking}`)}`)).body;
  expect(session.transcript.startsWith(env.JOYRIDE_CLAUDE_DIR)).toBe(true);
  const ts = new Date().toISOString();
  fs.appendFileSync(session.transcript, JSON.stringify({ type: "attachment", timestamp: ts, attachment: {
    type: "queued_command", commandMode: "prompt", origin: { kind: "human" },
    prompt: [{ type: "text", text: "[Image #1] [Image #2]" }, ...it.payload.images.map(() => ({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX.toString("base64") } }))],
  } }) + "\n");
  await page.reload();
  const mine = page.getByRole("dialog", { name: /Worker/ }).locator(".chat .msg.r-user").last();
  await expect(mine.locator(".sent-images img")).toHaveCount(2);
  await expect(mine).not.toContainText("[Image");
  await expect(page.locator(".chat [data-staged]")).toHaveCount(0);
  await mine.scrollIntoViewIfNeeded();
  await shot(page, CP, "claude-inline-recovered");
  await mine.locator(".image-preview").first().click();
  await viewer.click({ position: { x: 3, y: 3 } });
  await expect(viewer).toHaveCount(0);
  expect(page.url()).toBe(route);

  // Received screenshots in markdown open over the same sheet and navigate within the message.
  const urls = it.payload.images.map((p: string) => `/api/uploads/${p.split("/uploads/")[1]}`);
  fs.appendFileSync(session.transcript, JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [
    { type: "text", text: `Here are the screenshots.\n\n![First screenshot](${urls[0]})\n\n![Second screenshot](${urls[1]})` },
  ] } }) + "\n");
  await page.reload();
  const received = page.locator(".chat .msg.r-assistant").last();
  await expect(received.locator(".image-preview")).toHaveCount(2);
  await received.locator(".image-preview").first().click();
  await expect(viewer).toContainText("First screenshot");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("Second screenshot");
  await shot(page, CP, "received-image-lightbox");
  await viewer.getByRole("button", { name: "Close image viewer" }).click();

  // Removed files fall back to a neutral chip while the rest of the message stays visible.
  fs.unlinkSync(it.payload.images[0]);
  // Upload URLs are immutable, so a fresh context ensures the server's 404 reaches the UI.
  const fresh = await context.browser()!.newContext();
  try {
    const freshPage = await fresh.newPage();
    await freshPage.goto(route);
    const last = freshPage.locator(".chat .msg.r-user").last();
    await expect(last.locator(".image-missing")).toHaveText("Image");
    await expect(last.locator(".sent-images img")).toHaveCount(1);
    await last.scrollIntoViewIfNeeded();
    await shot(freshPage, CP, "missing-image-chip");
  } finally { await fresh.close(); }
});

test("a late image intent refreshes the inline bubble without a transcript write or page reload", async ({ page }) => {
  await herdr("fake.set_status", { pane_id: "w1:p1", status: "working" });
  await page.goto(`/#/worker/${encodeURIComponent(W.working)}`);
  const box = page.getByRole("dialog", { name: /Worker/ }).locator(".wp-reply .reply-box");
  await box.locator("[data-attach-input]").setInputFiles(writePng(files, "late-image.png"));
  await expect(box.locator('[data-attachment="ready"]')).toHaveCount(1);
  const session = (await call("GET", `/api/sessions/${encodeURIComponent(`claude:${FAKE_SESSIONS.claudeWorking}`)}`)).body;
  expect(session.transcript.startsWith(env.JOYRIDE_CLAUDE_DIR)).toBe(true);
  const text = "Recover this image after the relay finishes.";
  fs.appendFileSync(session.transcript, JSON.stringify({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: [
    { type: "text", text: `[Image #1] ${text}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX.toString("base64") } },
  ] } }) + "\n");
  await page.reload();
  const bubble = page.locator(".chat .msg.r-user").filter({ hasText: text });
  await expect(bubble.locator(".image-missing")).toBeVisible();
  const size = fs.statSync(session.transcript).size;
  const reply = page.getByRole("dialog", { name: /Worker/ }).locator(".wp-reply .reply-box");
  await reply.getByLabel(/^Reply to /).fill(text);
  await reply.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bubble.locator(".sent-images img")).toHaveCount(1, { timeout: 15000 });
  await expect(bubble.locator(".image-missing")).toHaveCount(0);
  expect(fs.statSync(session.transcript).size).toBe(size);
  await bubble.scrollIntoViewIfNeeded();
  await shot(page, CP, "late-image-recovered");
});
