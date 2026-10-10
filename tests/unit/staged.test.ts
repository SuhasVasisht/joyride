// Replies sent from the chat view while the agent works. The agent holds them in its queue, and
// they reach its transcript only when it takes them, so the chat shows them as staged messages
// until then. tests/fixtures/staged/claude-queue.jsonl is a real Claude Code 2.1.289 transcript
// from an isolated Herdr lab session (scripts/lab-staged.sh), cut to its prompts, replies and
// queue records: messages queued and taken at the end of a turn, three popped back into the input
// box with Up and sent again, one popped back and then lost, and one taken between tool calls.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claudeTranscriptState } from "../../src/modules/sessions/claude.ts";
import { consumedReplies, normText, stagedReplies, UNCLAIMED_MS } from "../../src/modules/live/staged.ts";
import type { IntentRecord } from "../../src/modules/live/intents.ts";
import type { WorkerView } from "../../src/shared/schema.ts";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, FAKE_SESSIONS, type FakeHerdr } from "../fixtures/fake-herdr.ts";

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "staged", "claude-queue.jsonl");

describe("reading Claude Code's queue from its transcript", () => {
  it("shows a message taken between tool calls as your prompt, where it landed in the turn", async () => {
    const { turns } = await claudeTranscriptState(FIXTURE, 200);
    const users = turns.filter((t) => t.role === "user").map((t) => t.text);
    expect(users).toContain("mid tool queued Z");
    const at = turns.findIndex((t) => t.role === "user" && t.text === "mid tool queued Z");
    expect(turns[at - 1]).toMatchObject({ role: "assistant" });
    expect(turns[at - 1].tools.map((t) => t.name)).toEqual(["Read"]);
    expect(turns[at + 1].text).toMatch(/^Lab model: the tool ran/);
    // Messages taken at the end of a turn are ordinary prompts, each once.
    expect(users.filter((t) => t === "natural queued A")).toHaveLength(1);
    expect(users).toContain("queued while busy one\nqueued while busy two\nqueued while busy three");
  });

  it("knows what is still queued, and what Up popped back into the input box and never sent", async () => {
    const all = await claudeTranscriptState(FIXTURE, 200);
    expect(all.queue).toEqual([]);
    // "risk queued X" was popped into the box, and the old relay then cleared the box: it never went out.
    expect(all.pulled.map((q) => q.text)).toEqual(["risk queued X"]);
    // Cut the file just after the three messages were queued, then after Up popped them.
    const lines = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
    const upTo = (pred: (r: any) => boolean) => {
      const n = lines.findIndex((l) => pred(JSON.parse(l)));
      const f = path.join(fs.mkdtempSync("/tmp/joyride-staged-"), "t.jsonl");
      fs.writeFileSync(f, lines.slice(0, n + 1).join("\n") + "\n");
      return claudeTranscriptState(f, 200);
    };
    const queued = await upTo((r) => r.operation === "enqueue" && r.content === "queued while busy three");
    expect(queued.queue.map((q) => q.text)).toEqual(["queued while busy one", "queued while busy two", "queued while busy three"]);
    expect(queued.pulled).toEqual([]);
    const popped = await upTo((r) => r.operation === "popAll" && r.content === "queued while busy three");
    expect(popped.queue).toEqual([]);
    expect(popped.pulled.map((q) => q.text)).toEqual(["queued while busy one", "queued while busy two", "queued while busy three"]);
    const twoQueued = await upTo((r) => r.operation === "enqueue" && r.content === "natural queued B");
    expect(twoQueued.queue.map((q) => q.text)).toEqual(["natural queued A", "natural queued B"]);
    expect(twoQueued.pulled).toEqual([]); // sent again as one prompt, so no longer stranded
    const midTool = await upTo((r) => r.operation === "enqueue" && r.content === "mid tool queued Z");
    expect(midTool.queue.map((q) => q.text)).toEqual(["mid tool queued Z"]);
  });

  it("leaves out queued notifications and messages from other sessions", async () => {
    const f = path.join(fs.mkdtempSync("/tmp/joyride-staged-"), "t.jsonl");
    const att = (a: Record<string, unknown>) => JSON.stringify({ type: "attachment", timestamp: "2026-10-05T07:16:26.636Z", attachment: { type: "queued_command", timestamp: "2026-10-05T07:16:26.636Z", ...a } });
    fs.writeFileSync(f, [
      JSON.stringify({ type: "user", timestamp: "2026-10-05T07:16:00.000Z", message: { role: "user", content: "start" } }),
      att({ prompt: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>", commandMode: "task-notification" }),
      att({ prompt: "from a peer session", commandMode: "prompt", origin: { kind: "peer", from: "uds:/tmp/x.sock" } }),
      att({ prompt: [{ type: "text", text: "with a picture\n\n[Image #2]" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "" } }], commandMode: "prompt", origin: { kind: "human" } }),
      att({ prompt: "older record without an origin", commandMode: "prompt" }),
    ].join("\n") + "\n");
    const { turns } = await claudeTranscriptState(f, 50);
    expect(turns.map((t) => t.text)).toEqual(["start", "with a picture\n\n[Image #2]", "older record without an origin"]);
  });
});

const T0 = Date.parse("2026-10-05T07:10:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const reply = (o: Partial<IntentRecord> & { text?: string; at?: number; images?: string[] }): IntentRecord => ({
  id: `int_${++n}`, kind: "reply", target: "local:w1:p1", status: "sent", error: null,
  created: iso(o.at ?? 0), updated: iso(o.at ?? 0),
  payload: { text: o.text ?? "", ...(o.images ? { images: o.images } : {}) },
  result: { worker: "local:w1:p1", session: "claude:s1" },
  ...o,
} as IntentRecord);
const worker = (status: WorkerView["status"], since = 0): WorkerView => ({
  id: "local:w1:p1", machine: "local", agent: "claude", status, pane: "w1:p1", pid: null, cwd: "/tmp/x", repo: null, session: "claude:s1",
  title: "lab", current_action: "", last_message: "", controllable: true, updated: iso(since), mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, helm: null,
});
const user = (text: string, at: number) => ({ role: "user" as const, ts: iso(at), text, tools: [] });

describe("where a reply stands", () => {
  it("is consumed once a later prompt holds its text, even joined with others; each copy needs its own occurrence", () => {
    const a = reply({ text: "queued while busy one", at: 10 }), b = reply({ text: "queued while busy two", at: 12 });
    const yes1 = reply({ text: "yes", at: 20 }), yes2 = reply({ text: "yes", at: 21 });
    const turns = [user("yes", 5), user("queued while busy one\nqueued while busy two", 30), user("yes", 40)];
    const got = consumedReplies([a, b, yes1, yes2], turns);
    expect([...got].sort()).toEqual([a.id, b.id, yes1.id].sort());
    // An image the agent shows as "[Image #1]" matches on the text around it.
    const img = reply({ text: "what is this", images: ["/u/a.png"], at: 50 });
    expect(consumedReplies([img], [user("[Image #1] what is this", 51)]).has(img.id)).toBe(true);
    const alone = reply({ text: "", images: ["/u/a.png"], at: 60 });
    expect(consumedReplies([alone], [{ ...user("[Image #1]", 61), images: ["/u/a.png"] }]).has(alone.id)).toBe(true);
    expect(normText(" [Image #3]  a\n b ")).toBe("a b");
  });

  it("names each state: sending, refused, queued, popped back, delivered, never taken", () => {
    const now = T0 + 60_000;
    const transcript = { turns: [user("taken already", 30)], queue: [{ text: "in the queue", ts: iso(20) }], pulled: [{ text: "popped back", ts: iso(25) }] };
    const replies = [
      reply({ text: "being typed", status: "pending", at: 59 }),
      reply({ text: "refused", status: "failed", error: "The agent in pane w1:p1 is working, and its input box holds text…", at: 40, result: { session: "claude:s1", code: "composer_busy" } }),
      reply({ text: "in the queue", at: 20, result: { session: "claude:s1", queued: true } }),
      reply({ text: "popped back", at: 21, result: { session: "claude:s1", queued: true } }),
      reply({ text: "taken already", at: 29 }),
      reply({ text: "for another conversation in this pane", at: 50, result: { session: "claude:other" } }),
      { ...reply({ text: "dismissed", status: "failed", at: 45 }), dismissed: iso(46) },
    ];
    const out = stagedReplies({ replies, worker: worker("working", 0), transcript, now });
    expect(out.staged.map((r) => [r.text, r.state])).toEqual([
      ["in the queue", "queued"], ["popped back", "pulled"], ["refused", "failed"], ["being typed", "sending"],
    ]);
    expect(out.staged.find((r) => r.state === "failed")!.error).toMatch(/is working/);
    expect(out.consumed).toEqual([replies[4].id]);
  });

  it("Codex keeps no queue file: a reply sent mid-turn stays queued while it works", () => {
    const codex = { turns: [], queue: null, pulled: null };
    const r = reply({ text: "steer", at: 10, result: { session: "claude:s1", queued: true } });
    expect(stagedReplies({ replies: [r], worker: worker("working", 0), transcript: codex, now: T0 + 30_000 }).staged[0].state).toBe("queued");
  });

  it("says when an idle agent never took a reply, and lets an acked one go after a grace period", () => {
    const r = reply({ text: "hello?", at: 0 });
    const idle = worker("idle", 5);
    const t = { turns: [], queue: [], pulled: [] };
    expect(stagedReplies({ replies: [r], worker: idle, transcript: t, now: T0 + 5_000 + UNCLAIMED_MS - 1000 }).staged[0].state).toBe("delivered");
    expect(stagedReplies({ replies: [r], worker: idle, transcript: t, now: T0 + 5_000 + UNCLAIMED_MS + 1000 }).staged[0].state).toBe("unclaimed");
    expect(stagedReplies({ replies: [r], worker: null, transcript: null, now: T0 + 1000 }).staged[0].state).toBe("unclaimed");
    // No session linked, so no transcript: once the agent has been idle a while it can't be confirmed, and goes quietly.
    expect(stagedReplies({ replies: [r], worker: idle, transcript: null, now: T0 + 5_000 + UNCLAIMED_MS + 1000 }).staged).toEqual([]);
    // Herdr's "it started working" acked it, but with a transcript only the transcript can say it was taken.
    const acked = reply({ text: "seen", status: "acked", at: 0 });
    expect(stagedReplies({ replies: [acked], worker: idle, transcript: t, now: T0 + 60_000 }).staged[0].state).toBe("unclaimed");
    expect(stagedReplies({ replies: [acked], worker: idle, transcript: { ...t, turns: [user("seen", 1)] }, now: T0 + 60_000 }).staged).toEqual([]);
    // Without one, an acked reply lingers briefly, then goes.
    expect(stagedReplies({ replies: [acked], worker: idle, transcript: null, now: T0 + 10_000 }).staged[0].state).toBe("delivered");
    expect(stagedReplies({ replies: [acked], worker: idle, transcript: null, now: T0 + 60_000 }).staged).toEqual([]);
    // A long reply is matched on its start: transcript turns are clipped.
    const long = reply({ text: "word ".repeat(600).trim(), at: 0 });
    expect(consumedReplies([long], [user("word ".repeat(400) + "…", 2)]).has(long.id)).toBe(true);
  });
});

describe("staged replies through the daemon", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let fake: FakeHerdr;
  let file: string;
  const W = "local:w1:p1";
  const KEY = `claude:${FAKE_SESSIONS.claudeWorking}`;
  const staged = async () => (await d.req("GET", `/api/workers/${encodeURIComponent(W)}/staged`)).body;
  const append = (...recs: Record<string, unknown>[]) => fs.appendFileSync(file, recs.map((r) => JSON.stringify({ sessionId: FAKE_SESSIONS.claudeWorking, ...r })).join("\n") + "\n");

  beforeAll(async () => {
    d = await sandboxDaemon("staged", ["live", "sessions", "uploads"]);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default", promptFlipMs: 60_000 });
    await assertSandboxed(d.sb.env);
    await d.start();
    await waitFor(async () => (await d.req("GET", "/api/workers")).body.some((w: any) => w.id === W && w.session === KEY), 5000);
    const s = (await d.req("GET", `/api/sessions/${encodeURIComponent(KEY)}`)).body;
    file = s.transcript;
    expect(file.startsWith(d.sb.dir)).toBe(true);
  });
  afterAll(async () => { await d?.stop(); await fake?.stop(); });

  it("a reply sent mid-turn shows as queued, survives a reload, then becomes the transcript's prompt with no duplicate", async () => {
    fake.setStatus("w1:p1", "working");
    const it = (await d.req("POST", "/api/intents", { kind: "reply", target: W, payload: { text: "Also check the PDF export." } })).body;
    expect(it).toMatchObject({ status: "sent", result: { queued: true, session: KEY } });
    // Claude Code queues it and says so in its transcript.
    append({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), content: "Also check the PDF export." });
    await waitFor(async () => (await staged()).staged.length === 1, 5000);
    expect((await staged()).staged[0]).toMatchObject({ id: it.id, text: "Also check the PDF export.", state: "queued" });
    // A herdr "working" event or a prompt-submit hook (fired when the message is queued) is not a pickup.
    d.ctx.bus.emitEvent({ id: "e1", ts: new Date().toISOString(), source: "hook.claude", type: "prompt.submit", session: FAKE_SESSIONS.claudeWorking, agent: "claude", data: {} } as any);
    expect((await d.req("GET", `/api/intents/${it.id}`)).body.status).toBe("sent");
    // The turn ends: Claude Code dequeues it and it becomes an ordinary prompt.
    append(
      { type: "queue-operation", operation: "dequeue", timestamp: new Date().toISOString() },
      { type: "user", uuid: "u-staged-1", timestamp: new Date().toISOString(), message: { role: "user", content: "Also check the PDF export." } },
    );
    await waitFor(async () => (await d.req("GET", `/api/intents/${it.id}`)).body.status === "acked", 8000);
    expect((await staged()).staged).toEqual([]);
    const turns = (await d.req("GET", `/api/sessions/${encodeURIComponent(KEY)}/transcript?limit=50`)).body.turns;
    expect(turns.filter((t: any) => t.role === "user" && t.text === "Also check the PDF export.")).toHaveLength(1);
  });

  it("a refused reply stays in the chat with the reason until dismissed", async () => {
    fake.setStatus("w1:p1", "working");
    fake.panes.get("w1:p1")!.input = "queued while busy one";
    const it = (await d.req("POST", "/api/intents", { kind: "reply", target: W, payload: { text: "this one is refused" } })).body;
    expect(it.status).toBe("failed");
    expect(fake.panes.get("w1:p1")!.input).toBe("queued while busy one");
    const s = (await staged()).staged;
    expect(s.at(-1)).toMatchObject({ id: it.id, state: "failed", text: "this one is refused", error: expect.stringMatching(/left that text alone/) });
    expect((await d.req("POST", `/api/intents/${it.id}/dismiss`, {})).body.dismissed).toBeTruthy();
    expect((await staged()).staged.some((r: any) => r.id === it.id)).toBe(false);
    fake.panes.get("w1:p1")!.input = "";
  });

  it("recovers queued images from session intents when Claude omits source metadata", async () => {
    const { pngDataUrl } = await import("../fixtures/images.ts");
    const images = [];
    for (let i = 0; i < 2; i++) images.push((await d.req("POST", "/api/uploads", { name: "screenshot.png", data: pngDataUrl() })).body.path);
    fake.setStatus("w1:p1", "working");
    const reply = (await d.req("POST", "/api/intents", { kind: "reply", target: W, payload: { text: "", images } })).body;
    expect(reply.status).toBe("sent");
    // A mid-turn pickup is an attachment, without the ordinary image-source meta record.
    append({ type: "attachment", timestamp: new Date().toISOString(), attachment: {
      type: "queued_command", commandMode: "prompt", origin: { kind: "human" },
      prompt: [{ type: "text", text: "[Image #1] [Image #2]" }, ...images.map(() => ({ type: "image", source: { type: "base64", data: "iVBO", media_type: "image/png" } }))],
    } });
    const url = `/api/sessions/${encodeURIComponent(KEY)}/transcript?limit=50`;
    expect((await d.req("GET", url)).body.turns.at(-1).images).toEqual(images);
    expect((await d.req("GET", url)).body.turns.at(-1).images).toEqual(images); // cached parse also recovers them
    expect((await staged()).staged).toEqual([]);
    expect((await d.req("GET", `/api/intents/${reply.id}`)).body.status).toBe("acked");

    // Limit the view to the later of two identical prompts. Recovery must still match
    // against the full history, rather than assigning the earlier reply's image to it.
    const laterImages = [];
    for (let i = 0; i < 2; i++) laterImages.push((await d.req("POST", "/api/uploads", { name: "screenshot.png", data: pngDataUrl() })).body.path);
    append({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "[Image #1] [Image #2]" } });
    expect((await d.req("GET", `/api/sessions/${encodeURIComponent(KEY)}/transcript?limit=1`)).body.turns[0].images).toBeUndefined();
    // A late relay result invalidates the cached transcript even without another file write.
    await d.req("POST", "/api/intents", { kind: "reply", target: W, payload: { text: "", images: laterImages } });
    expect((await d.req("GET", `/api/sessions/${encodeURIComponent(KEY)}/transcript?limit=1`)).body.turns[0].images).toEqual(laterImages);
  });
});
