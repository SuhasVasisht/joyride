// A relayed reply arrives as exactly what was written: Joyride reads the agent's
// input box off its screen and empties it before agent.prompt, which pastes at
// the input's cursor. The screens in tests/fixtures/composer are real captures
// (Claude Code 2.1.289, Codex 0.160) from an isolated Herdr lab session.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { attachImages, clearKeys, composerAgents, emptyComposer, imageCount, imagePaste, keepComposer, readComposer, ComposerError } from "../../src/modules/live/composer.ts";
import { PNG_1PX, pngDataUrl } from "../fixtures/images.ts";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, CLAUDE_PERMISSION_MENU, type FakeHerdr } from "../fixtures/fake-herdr.ts";

const screen = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "composer", `${name}.ansi`), "utf8");
const LAUNCH = "Ahoy. I am the captain. Please run your first-time setup and tell me what you need from me. All projects are local-only: never push, never open PRs. My work happens through Joyride (http://127.0.0.1:4317), which will relay your questions to me.";

describe("reading the input box", () => {
  it("reads Claude Code's input: empty, a recalled prompt, a draft, a paste token", () => {
    expect(readComposer(screen("claude-empty"), "claude")).toEqual({ found: true, text: "", rows: 1 });
    expect(readComposer(screen("claude-cleared"), "claude")).toEqual({ found: true, text: "", rows: 1 });
    // Up in an empty input recalls the launch prompt (the rule above reads "History 1/1"), wrapped over three rows.
    const recalled = readComposer(screen("claude-history-recalled"), "claude");
    expect(recalled.rows).toBe(3);
    expect(recalled.text.replace(/\n/g, " ").replace(/ +/g, " ")).toBe(LAUNCH);
    expect(readComposer(screen("claude-multiline"), "claude")).toEqual({ found: true, text: "line one\nline two is here\nline three", rows: 3 });
    expect(readComposer(screen("claude-paste-token"), "claude").text).toBe("[Pasted text #1]");
  });

  it("ignores the echoed prompt above the box and the dim placeholder in it", () => {
    // Mid-turn: "❯ first prompt…" (a plain space) is the transcript; the box holds a draft.
    expect(readComposer(screen("claude-working-draft"), "claude")).toEqual({ found: true, text: "typed while working", rows: 1 });
    // "Press up to edit queued messages" is a hint, drawn dim with the cursor on its first letter.
    expect(readComposer(screen("claude-queued-placeholder"), "claude")).toEqual({ found: true, text: "", rows: 1 });
  });

  it("reads Codex's input: the dim placeholder is empty, drafts span rows", () => {
    expect(readComposer(screen("codex-empty"), "codex")).toEqual({ found: true, text: "", rows: 1 });
    expect(readComposer(screen("codex-multiline"), "codex")).toEqual({ found: true, text: "line one\nline two is here\nline three", rows: 3 });
    const long = readComposer(screen("codex-long"), "codex");
    expect(long.rows).toBe(3);
    expect(long.text.split(/\s+/)).toEqual(Array(60).fill("word"));
  });
  it("reads Cursor's native input and preserves a draft during guarded steering", async () => {
    expect(composerAgents.has("cursor")).toBe(true);
    expect(readComposer(screen("cursor-empty"), "cursor")).toEqual({ found: true, text: "", rows: 1 });
    expect(readComposer(screen("cursor-working"), "cursor")).toEqual({ found: true, text: "", rows: 1 });
    const draft = "  → keep the pending decision\x1b[7m \x1b[0m\n\n  Grok 4.7 · Run Everything\n";
    expect(readComposer(draft, "cursor")).toEqual({ found: true, text: "keep the pending decision", rows: 1 });
    await expect(keepComposer({ agent: "cursor", where: "lab pane", read: async () => draft })).rejects.toMatchObject({ code: "composer_draft", leftover: "keep the pending decision" });
  });

  it("relays into Cursor's interrupted input without merging a native draft", async () => {
    const interrupted = screen("cursor-interrupted");
    const recalled = "Read state/original-context.md in full, then briefly describe the preserved promise.";
    expect(readComposer(interrupted, "cursor")).toEqual({ found: true, text: recalled, rows: 1 });
    await expect(keepComposer({ agent: "cursor", where: "lab pane", read: async () => interrupted })).rejects.toMatchObject({ code: "composer_draft", leftover: recalled });
    const draft = screen("cursor-draft");
    expect(readComposer(draft, "cursor").text).toBe("preserve this native draft");
    await expect(keepComposer({ agent: "cursor", where: "lab pane", read: async () => draft })).rejects.toMatchObject({ code: "composer_draft", leftover: "preserve this native draft" });
    expect(readComposer("  → echoed text without a native footer\n", "cursor").found).toBe(false);
  });

  it("does not take a menu, a shell prompt or an unknown agent for an input box", () => {
    expect(readComposer(CLAUDE_PERMISSION_MENU.join("\n"), "claude").found).toBe(false);
    expect(readComposer("\x1b[1m❯\x1b[0m claude\n", "claude").found).toBe(false);
    expect(readComposer(screen("claude-empty"), "gemini").found).toBe(false);
    expect(readComposer(screen("claude-empty"), "codex").found).toBe(false);
  });

  it("clears with kill-line keys only: never Ctrl+C or Esc", () => {
    expect(clearKeys(1)).toEqual(["ctrl+k", "ctrl+k", "ctrl+k", "ctrl+u", "backspace", "ctrl+u", "backspace"]);
    expect(clearKeys(3).filter((k) => k === "ctrl+k")).toHaveLength(7);
    expect(clearKeys(3).some((k) => k === "ctrl+c" || k === "esc")).toBe(false);
  });
});

describe("emptying the input box", () => {
  const box = (text: string) => `${"─".repeat(20)}\n❯\u00a0${text}\x1b[7m \x1b[0m\n${"─".repeat(20)}\n`;

  it("leaves an empty box alone", async () => {
    const sent: string[][] = [];
    expect(await emptyComposer({ agent: "claude", where: "pane w1:p1 (local)", read: async () => box(""), send: async (k) => { sent.push(k); } })).toBeNull();
    expect(sent).toEqual([]);
  });

  it("clears leftover text, checks the screen again and returns what it cleared", async () => {
    let text = LAUNCH;
    const sent: string[][] = [];
    const cleared = await emptyComposer({ agent: "claude", where: "pane w1:p1 (local)", stepMs: 5, read: async () => box(text), send: async (k) => { sent.push(k); text = ""; } });
    expect(cleared).toBe(LAUNCH);
    expect(sent).toHaveLength(1);
  });

  it("refuses when the box can't be seen or won't clear, and says how to fix it", async () => {
    await expect(emptyComposer({ agent: "claude", where: "pane w1:p1 (local)", read: async () => CLAUDE_PERMISSION_MENU.join("\n"), send: async () => {} }))
      .rejects.toMatchObject({ code: "composer_not_found", message: expect.stringMatching(/can't see the input box.*did not send your reply.*Open the agent's terminal/) });
    const sent: string[][] = [];
    const err = await emptyComposer({ agent: "claude", where: "pane w1:p1 (local)", settleMs: 30, stepMs: 5, read: async () => box("stuck draft"), send: async (k) => { sent.push(k); } }).catch((e) => e);
    expect(err).toBeInstanceOf(ComposerError);
    expect(err).toMatchObject({ code: "composer_not_cleared", leftover: "stuck draft" });
    expect(err.message).toMatch(/already holds text that Joyride could not clear \("stuck draft"\)\. Your reply was not sent.*Clear the input box/);
    expect(sent).toHaveLength(3);
  });
});

describe("attaching images", () => {
  const box = (text: string) => `${"─".repeat(20)}\n❯\u00a0${text}\x1b[7m \x1b[0m\n${"─".repeat(20)}\n`;

  it("reads the real attachments: two images in Claude Code and Codex, and a path Codex kept as text", () => {
    expect(readComposer(screen("claude-images"), "claude")).toEqual({ found: true, text: "[Image #1] [Image #2]", rows: 1 });
    expect(readComposer(screen("codex-images"), "codex")).toEqual({ found: true, text: "[Image #1] [Image #2]", rows: 1 });
    const asText = readComposer(screen("codex-image-as-text"), "codex");
    expect(imageCount(asText.text)).toBe(0);
    expect(asText.text).toMatch(/^look at \/private\/tmp\/.*probe\.png$/s);
  });

  it("pastes each path on its own, quoted only when it has to be", () => {
    expect(imagePaste("/data/.joyride/uploads/2026-10-04/abc123.png")).toBe("\x1b[200~/data/.joyride/uploads/2026-10-04/abc123.png\x1b[201~");
    expect(imagePaste("/My Drive/joyride/uploads/a.png")).toBe("\x1b[200~'/My Drive/joyride/uploads/a.png'\x1b[201~");
    expect(imageCount("[Image #3] [Image #4] text")).toBe(2);
  });

  it("waits for each [Image #N] before the next paste", async () => {
    let text = "";
    const pasted: string[] = [];
    await attachImages({
      agent: "claude", where: "pane w1:p1 (local)", paths: ["/u/a.png", "/u/b.gif"], stepMs: 5, settleMs: 500,
      read: async () => box(text), send: async () => {},
      paste: async (t) => { pasted.push(t); setTimeout(() => { text += `[Image #${pasted.length}] `; }, 20); },
    });
    expect(pasted).toEqual([imagePaste("/u/a.png"), imagePaste("/u/b.gif")]);
    expect(text.trim()).toBe("[Image #1] [Image #2]");
  });

  it("clears the box and sends nothing when the agent keeps the path as text", async () => {
    let text = "";
    const sent: string[][] = [];
    const err = await attachImages({
      agent: "claude", where: "pane w1:p1 (local)", paths: ["/u/a.png"], stepMs: 5, settleMs: 60,
      read: async () => box(text), send: async (k) => { sent.push(k); text = ""; }, paste: async () => { text = "/u/a.png"; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ComposerError);
    expect(err.code).toBe("image_not_attached");
    expect(err.message).toMatch(/did not take a\.png as an image \(its input box shows "\/u\/a\.png" instead of an \[Image #1\] attachment\), so Joyride sent nothing and cleared the box again/);
    expect(sent).toHaveLength(1);
    expect(text).toBe("");
  });
});

process.env.JOYRIDE_HERDR_POLL_MS = "400";

describe("a reply through the daemon", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let fake: FakeHerdr;
  const reply = async (worker: string, text: string) => (await d.req("POST", "/api/intents", { kind: "reply", target: worker, payload: { text } })).body;
  const reply2 = async (worker: string, text: string, images: string[]) => (await d.req("POST", "/api/intents", { kind: "reply", target: worker, payload: { text, images } })).body;
  const ANSWERS = "1. I don't even know what you mean by my copy of Joyride\n\n2. I recommend A, cleanly\n\n3. Did that";

  beforeAll(async () => {
    d = await sandboxDaemon("composer", ["live", "uploads"]);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default", promptFlipMs: 100 });
    await assertSandboxed(d.sb.env);
    await d.start();
    await waitFor(async () => (await d.req("GET", "/api/workers")).body.length >= 3, 5000);
  });
  afterAll(async () => { await d?.stop(); await fake?.stop(); });

  it("without the guard, the fake merges a prompt into leftover text like the real input does", async () => {
    fake.panes.get("w2:p1")!.input = "leftover ";
    await d.ctx.service<any>("herdr").call("agent.prompt", { target: "w2:p1", text: "reply" });
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "leftover reply" });
  });

  it("a Claude Code input holding the recalled launch prompt is cleared first: the reply arrives exactly as written", async () => {
    fake.setStatus("w1:p1", "idle");
    fake.panes.get("w1:p1")!.input = `${LAUNCH}\nand a second line`;
    const keysBefore = fake.keys.length;
    const it = await reply("local:w1:p1", ANSWERS);
    expect(it).toMatchObject({ status: "sent", error: null, result: { worker: "local:w1:p1", cleared: `${LAUNCH}\nand a second line` } });
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w1:p1", text: ANSWERS });
    const keys = fake.keys.slice(keysBefore).flatMap((k) => k.keys);
    expect(keys).toContain("ctrl+u");
    expect(keys.some((k) => k === "ctrl+c" || k === "esc")).toBe(false);
  });

  it("a Codex draft is cleared the same way; an empty input is sent straight away with no keys", async () => {
    await waitFor(() => fake.panes.get("w2:p1")!.agent_status === "idle", 3000);
    fake.panes.get("w2:p1")!.input = "half-typed";
    expect((await reply("local:w2:p1", "yes")).result.cleared).toBe("half-typed");
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "yes" });
    await waitFor(() => fake.panes.get("w2:p1")!.agent_status === "idle", 3000);
    const keysBefore = fake.keys.length;
    const it = await reply("local:w2:p1", "and a short follow-up");
    expect(it.status).toBe("sent");
    expect(it.result.cleared).toBeUndefined();
    expect(fake.keys.length).toBe(keysBefore);
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "and a short follow-up" });
  });

  it("refuses and reports when the input won't clear, and sends nothing", { timeout: 15000 }, async () => {
    const p = fake.panes.get("w2:p1")!;
    await waitFor(() => p.agent_status === "idle", 3000);
    p.input = "a draft the captain typed";
    p.inputLocked = true;
    const prompts = fake.prompts.length;
    const it = await reply("local:w2:p1", "the reply");
    expect(it.status).toBe("failed");
    expect(it.error).toMatch(/already holds text that Joyride could not clear \("a draft the captain typed"\)\. Your reply was not sent/);
    expect(fake.prompts.length).toBe(prompts);
    p.inputLocked = false;
    p.input = "";
  });

  it("while the agent works, text in its input box is left alone: it may be queued messages pulled back to edit", async () => {
    // Claude Code mid-turn: Up pops the messages queued for the end of the turn back into the box.
    const p = fake.panes.get("w1:p1")!;
    fake.setStatus("w1:p1", "working");
    p.input = "queued while busy one\nqueued while busy two";
    const keys = fake.keys.length, prompts = fake.prompts.length;
    const it = await reply("local:w1:p1", "a reply mid-turn");
    expect(it.status).toBe("failed");
    expect(it.error).toMatch(/is working, and its input box holds text \("queued while busy one\nqueued while busy two"\).*did not send your reply and left that text alone.*press Enter to queue that text again/);
    expect(it.result).toMatchObject({ worker: "local:w1:p1", code: "composer_busy" });
    expect(fake.keys.length).toBe(keys);
    expect(fake.prompts.length).toBe(prompts);
    expect(p.input).toBe("queued while busy one\nqueued while busy two");
    // An empty box mid-turn is fine: the reply goes in, and the agent queues it.
    p.input = "";
    const queued = await reply("local:w1:p1", "a reply mid-turn");
    expect(queued).toMatchObject({ status: "sent", result: { queued: true } });
    expect(fake.keys.length).toBe(keys);
    fake.setStatus("w1:p1", "idle");
  });

  const upload = async () => (await d.req("POST", "/api/uploads", { name: "image.png", data: pngDataUrl() })).body.path as string;

  it("a reply with images: each image is attached on its own, then the text goes in and is submitted", async () => {
    const p = fake.panes.get("w2:p1")!;
    await waitFor(() => p.agent_status === "idle", 3000);
    const [a, b] = [await upload(), await upload()];
    const inputs = fake.inputs.length;
    const it = await reply2("local:w2:p1", "What do these show?", [a, b]);
    expect(it).toMatchObject({ status: "sent", error: null, result: { worker: "local:w2:p1", images: [a, b] } });
    // Two pastes of a lone path each, never the path inside the prompt text.
    const pastes = fake.inputs.slice(inputs).filter((x) => x.target === "w2:p1" && x.text).map((x) => x.text);
    expect(pastes).toEqual([`\x1b[200~${a}\x1b[201~`, `\x1b[200~${b}\x1b[201~`]);
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "[Image #1] [Image #2] What do these show?", images: [a, b] });
  });

  it("the same screenshot pasted three times (all image.png, same bytes) goes in as three attachments, in order", async () => {
    const p = fake.panes.get("w2:p1")!;
    await waitFor(() => p.agent_status === "idle", 3000);
    const imgs = [await upload(), await upload(), await upload()];
    expect(new Set(imgs).size).toBe(3);
    for (const i of imgs) expect(fs.readFileSync(i).equals(PNG_1PX)).toBe(true);
    const inputs = fake.inputs.length;
    const it = await reply2("local:w2:p1", "Same bug, three times.", imgs);
    expect(it).toMatchObject({ status: "sent", payload: { images: imgs }, result: { images: imgs } });
    const pastes = fake.inputs.slice(inputs).filter((x) => x.target === "w2:p1" && x.text).map((x) => x.text);
    expect(pastes).toEqual(imgs.map((i) => `\x1b[200~${i}\x1b[201~`));
    expect(fake.prompts.at(-1)).toMatchObject({ target: "w2:p1", text: "[Image #1] [Image #2] [Image #3] Same bug, three times.", images: imgs });
  });

  it("an image alone is submitted with Enter", async () => {
    const p = fake.panes.get("w1:p1")!;
    await waitFor(() => p.agent_status !== "blocked", 3000);
    const a = await upload();
    const typed = fake.typed.length;
    const it = await reply2("local:w1:p1", "", [a]);
    expect(it.status).toBe("sent");
    expect(fake.typed.slice(typed).at(-1)).toMatchObject({ target: "w1:p1", text: "[Image #1] ", images: [a] });
  });

  it("refuses images the agent didn't take, and paths Joyride didn't store, sending nothing", { timeout: 15000 }, async () => {
    const p = fake.panes.get("w2:p1")!;
    await waitFor(() => p.agent_status === "idle", 3000);
    const a = await upload();
    p.noImages = true;
    const prompts = fake.prompts.length;
    const it = await reply2("local:w2:p1", "look", [a]);
    expect(it.status).toBe("failed");
    expect(it.error).toMatch(/did not take .*\.png as an image .*so Joyride sent nothing and cleared the box again/);
    expect(fake.prompts.length).toBe(prompts);
    expect(p.input).toBe("");
    p.noImages = false;
    const stray = path.join(process.env.JOYRIDE_RUNTIME!, "stray.png");
    fs.writeFileSync(stray, PNG_1PX);
    const it2 = await reply2("local:w2:p1", "look", [stray]);
    expect(it2.status).toBe("failed");
    expect(it2.error).toMatch(/is not an image uploaded to Joyride/);
    expect(fake.prompts.length).toBe(prompts);
  });

  it("says so instead of sending images to an agent that can't load them, before typing anything", async () => {
    const a = await upload();
    const p = fake.panes.get("w2:p1")!;
    const was = p.agent;
    p.agent = "gemini";
    const inputs = fake.inputs.length, prompts = fake.prompts.length;
    const err = await d.ctx.service<any>("herdr").prompt("w2:p1", "look", { images: [a] }).catch((e: any) => e);
    p.agent = was;
    expect(err).toBeInstanceOf(ComposerError);
    expect(err.code).toBe("images_unsupported");
    expect(err.message).toMatch(/\(gemini\) can't load images from a file path, so Joyride won't send it images\. Images work with Claude Code and Codex/);
    expect(fake.inputs.length).toBe(inputs);
    expect(fake.prompts.length).toBe(prompts);
  });
});

describe("keepComposer (a steer from Firstmate never types over a draft)", () => {
  const box = (text: string) => `${"─".repeat(20)}\n❯ ${text}\x1b[7m \x1b[0m\n${"─".repeat(20)}\n`;
  it("passes an empty input box, and refuses a draft or an input box it can't see, leaving it alone", async () => {
    const { keepComposer, ComposerError } = await import("../../src/modules/live/composer.ts");
    await expect(keepComposer({ agent: "claude", where: "pane p", read: async () => box("") })).resolves.toBeUndefined();
    const draft = keepComposer({ agent: "claude", where: "pane p", read: async () => box("half a thought") });
    await expect(draft).rejects.toBeInstanceOf(ComposerError);
    await expect(draft).rejects.toMatchObject({ code: "composer_draft", leftover: "half a thought" });
    await expect(keepComposer({ agent: "claude", where: "pane p", read: async () => "Compiling…" })).rejects.toMatchObject({ code: "composer_not_found" });
  });
});
