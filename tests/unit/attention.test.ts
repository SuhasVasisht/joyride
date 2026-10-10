import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { AttentionService } from "../../src/modules/attention/index.ts";
import type { AttentionItem } from "../../src/shared/schema.ts";

// Only type imports above: src/shared/paths.ts reads JOYRIDE_HOME/JOYRIDE_RUNTIME at
// import time, so every src value import must happen after sandboxDaemon() sets the env.
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let att: AttentionService;
let C: typeof import("../../src/modules/attention/classify.ts");
let n = 0;
const sid = () => `s${++n}-${Math.random().toString(36).slice(2, 6)}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const flush = async () => { d.tailer.drain(); await att.settle(); d.tailer.drain(); };
const hook = (session: string, type: string, data: Record<string, unknown>, ts?: string) =>
  d.ctx.emit({ source: "hook.claude", type, session, agent: "claude", cwd: "/tmp/demo-repo", data, ...(ts ? { ts } : {}) });
const open = (session: string) => att.list({ open: true, session: `claude:${session}`, include_snoozed: true });
const all = (session: string) => att.list({ session: `claude:${session}` });

const QUESTION = "I refactored the parser. Should I also update the docs?";
const DONE = "Implemented the parser and all tests pass. The work is finished and ready to look over.";
const PROGRESS = "Progress update: finished a step and moved the helpers; keeps going with the next step.";

beforeAll(async () => {
  d = await sandboxDaemon("attention", ["attention", "evidence", "guard", "asks"]);
  const { paths } = await import("../../src/shared/paths.ts");
  if (!paths.runtime.startsWith(d.sb.dir)) throw new Error(`refusing to run: runtime ${paths.runtime} is outside the sandbox`);
  C = await import("../../src/modules/attention/classify.ts");
  att = d.ctx.service<AttentionService>("attention");
});
afterAll(async () => { await att?.settle(); });

describe("classification helpers", () => {
  it("never lets Jev lower the floor", () => {
    expect(C.finalLevel("L3", "L1")).toBe("L3");
    expect(C.finalLevel("L3", "L4")).toBe("L4");
    expect(C.finalLevel("L0", "L2")).toBe("L2");
    expect(C.finalLevel("L1", null)).toBe("L1");
  });
  it("falls back to: trailing question is L3, anything else L1", () => {
    expect(C.fallbackClassify("Which option do you want?")).toEqual({ level: "L3", kind: "question" });
    expect(C.fallbackClassify("Shall I continue?**")).toEqual({ level: "L3", kind: "question" });
    expect(C.fallbackClassify("Is this right? I went ahead anyway.")).toEqual({ level: "L1", kind: "progress" });
    expect(C.endsWithQuestion("")).toBe(false);
  });
  it("takes the why line from the payload's last question", () => {
    expect(C.whyFromMessage("Did a lot.\n\nTests pass. Should I commit now? Or wait")).toBe("Should I commit now?");
    expect(C.whyFromMessage("First para.\n\n- Final paragraph here.")).toBe("Final paragraph here.");
  });
  it("builds session keys from hook events", () => {
    expect(C.sessionKeyOf({ session: "abc", agent: "codex", source: "hook.codex" })).toBe("codex:abc");
    expect(C.sessionKeyOf({ session: "claude:abc", source: "x" })).toBe("claude:abc");
  });
});

describe("attention from events", () => {
  it("clears the reviewed-file question when the same session reports deletion", async () => {
    const session = sid();
    hook(session, "turn.stop", { last: "Do you want me to delete that file now that you're done reviewing?" }, ago(60_000));
    await flush();
    expect(open(session).some((a) => a.level === "L3")).toBe(true);
    hook(session, "turn.stop", { last: "I deleted the file. Finished." });
    await flush();
    expect(open(session).filter((a) => C.rank(a.level) >= 3)).toEqual([]);
  });

  it("clears a decision when the session starts another tool turn", async () => {
    const session = sid();
    hook(session, "turn.stop", { last: QUESTION }, ago(60_000));
    await flush();
    hook(session, "tool.pre", { tool: "Bash", input: { command: "pwd" } });
    await flush();
    expect(open(session).filter((a) => C.rank(a.level) >= 3)).toEqual([]);
  });

  it("never promotes progress reports even when raised at L4", () => {
    const a = att.raise({ session: `claude:${sid()}`, level: "L4", kind: "progress", title: "Made progress in orbit", why: "Tell me when Chrome's free." });
    expect(a).toMatchObject({ level: "L1", floor: "L1" });
    expect(att.raise({ session: `claude:${sid()}`, level: "L0", kind: "progress", title: "Routine turn" })).toBeNull();
  });

  it("does not raise questions from Firstmate's control pane replies", async () => {
    const session = sid();
    d.ctx.emit({ source: "hook.claude", type: "turn.stop", session, agent: "claude", pane: "wH:p1", data: { last: "Tell me when Chrome's free. Shall I continue?" } });
    await flush();
    expect(open(session)).toEqual([]);
  });

  it("keeps a real permission prompt until the session is no longer blocked", async () => {
    const session = sid();
    hook(session, "permission.request", { tool: "Bash", input: { command: "rm reviewed.txt" } });
    await flush();
    expect(open(session).some((a) => a.kind === "approval")).toBe(true);
    d.ctx.emit({ source: "herdr", type: "agent.status", agent: "claude", data: { status: "idle", session_ref: session } });
    await flush();
    expect(open(session)).toEqual([]);
  });

  it("classifies a question at L3 with Jev and keeps the why from the payload", async () => {
    const s = sid();
    hook(s, "turn.stop", { last: QUESTION });
    await flush();
    const [it] = open(s);
    expect(it.level).toBe("L3");
    expect(it.kind).toBe("question");
    expect(it.why).toBe("Should I also update the docs?");
    expect(it.jev?.level).toBe("L3");
    expect(it.jev?.p_needs_human).toBeGreaterThan(0.5);
    expect(it.ref.rule_fallback).toBe(false);
    expect(it.title).toContain("Asks a question");
  });

  it("holds the L3 floor for a permission request even when Jev answers lower", async () => {
    const s = sid();
    hook(s, "permission.request", { tool: "Bash", input: JSON.stringify({ command: "ls -la" }) });
    await flush();
    const [it] = open(s);
    expect(it.kind).toBe("approval");
    expect(it.floor).toBe("L3");
    expect(it.level).toBe("L3");
    expect(it.jev?.level).toBeDefined();
    expect(C.rank(it.jev!.level!)).toBeLessThan(3); // Jev said lower; the floor won
    expect(it.why).toBe("Bash: ls -la");
  });

  it("routes done reports to the L2 review queue and progress to the L1 digest", async () => {
    const a = sid(), b = sid();
    hook(a, "turn.stop", { last: DONE });
    hook(b, "turn.stop", { last: PROGRESS });
    await flush();
    expect(open(a).map((x) => [x.level, x.kind])).toEqual([["L2", "review"]]);
    expect(open(b).map((x) => [x.level, x.kind])).toEqual([["L1", "progress"]]);
    expect(att.list({ open: true, level: "L2", kind: "review" }).some((x) => x.session === `claude:${a}`)).toBe(true);
  });

  it("falls back to the rule when Jev is unavailable and records jev: null", async () => {
    const saved = { fake: process.env.JOYRIDE_FAKE_MODELS, key: process.env.JEV_API_KEY };
    process.env.JOYRIDE_FAKE_MODELS = "0";
    delete process.env.JEV_API_KEY;
    try {
      const a = sid(), b = sid();
      hook(a, "turn.stop", { last: "Two ways forward. Which one do you prefer?" });
      hook(b, "turn.stop", { last: "Renamed the module." });
      await flush();
      const [qa] = open(a), [pb] = open(b);
      expect([qa.level, qa.kind, qa.jev, qa.ref.rule_fallback]).toEqual(["L3", "question", null, true]);
      expect([pb.level, pb.kind, pb.jev]).toEqual(["L1", "progress", null]);
    } finally {
      process.env.JOYRIDE_FAKE_MODELS = saved.fake;
      if (saved.key) process.env.JEV_API_KEY = saved.key;
    }
  });

  it("dedupes one open item per session and kind", async () => {
    const s = sid();
    hook(s, "permission.request", { tool: "Bash", input: JSON.stringify({ command: "npm i" }) });
    hook(s, "notification", { kind: "permission_prompt", message: "Claude needs your permission to use Bash" });
    await flush();
    const items = open(s);
    expect(items).toHaveLength(1);
    expect(items[0].ref.updates).toBe(1);
  });

  it("supersedes the previous turn state when a new turn stops", async () => {
    const s = sid();
    hook(s, "turn.stop", { last: QUESTION }, ago(60_000));
    hook(s, "turn.stop", { last: DONE });
    await flush();
    const items = all(s);
    expect(items.find((x) => x.kind === "question")?.resolution).toBe("superseded");
    expect(open(s).map((x) => x.kind)).toEqual(["review"]);
  });

  it("resolves L3 items when the human replies, at the reply time", async () => {
    const s = sid();
    const replyTs = ago(2 * 60_000);
    hook(s, "turn.stop", { last: QUESTION }, ago(5 * 60_000));
    hook(s, "prompt.submit", { prompt: "yes, update the docs" }, replyTs);
    await flush();
    const [it] = all(s);
    expect(it.level).toBe("L3");
    expect(it.resolution).toBe("human replied");
    expect(it.resolved).toBe(replyTs);
    expect(open(s)).toHaveLength(0);
  });

  it("keeps the review item open when the human replies (only L3+ and idle resolve)", async () => {
    const s = sid();
    hook(s, "turn.stop", { last: DONE }, ago(60_000));
    await flush();
    hook(s, "prompt.submit", { prompt: "thanks" });
    await flush();
    expect(open(s).map((x) => x.kind)).toEqual(["review"]);
  });

  it("raises L3 for a stop failure and clears approvals when the agent resumes", async () => {
    const s = sid(), p = sid();
    hook(s, "turn.stop_failure", { error: "API error: overloaded" });
    hook(p, "permission.request", { tool: "Write", input: JSON.stringify({ file_path: "/tmp/x" }) }, ago(10_000));
    await flush();
    expect(open(s).map((x) => [x.level, x.kind, x.why])).toEqual([["L3", "error", "API error: overloaded"]]);
    hook(p, "tool.pre", { tool: "Read", input: "{}" });
    await flush();
    expect(all(p)[0].resolution).toBe("agent resumed");
  });

  it("opens an L3 item for herdr blocked and resolves it when the agent works again", async () => {
    const s = sid();
    d.ctx.emit({ source: "herdr", type: "agent.status", pane: "w1:p7", data: { status: "blocked", prev: "working", agent: "claude", session_ref: `claude:${s}`, machine: "local" } });
    await flush();
    const [it] = open(s);
    expect([it.level, it.floor, it.worker]).toEqual(["L3", "L3", "local:w1:p7"]);
    d.ctx.emit({ source: "herdr", type: "agent.status", pane: "w1:p7", data: { status: "working", prev: "blocked", agent: "claude", session_ref: `claude:${s}`, machine: "local" } });
    await flush();
    expect(all(s)[0].resolution).toBe("agent resumed");
  });

  it("runs the guard L4 lifecycle: request opens, decision resolves", async () => {
    const s = sid();
    const r = await d.req("POST", "/api/guard/requests", { rule: "git-push", title: "git push to a remote", tool: "Bash", input: { command: "git push origin main" }, session: s, agent: "claude", cwd: "/tmp/demo-repo" });
    await flush();
    const [it] = open(s);
    expect([it.level, it.floor, it.kind]).toEqual(["L4", "L4", "guard"]);
    expect(it.ref.request).toBe(r.body.id);
    expect(it.ref.deadline).toBe(r.body.deadline);
    expect(it.why).toBe("git push origin main");
    expect(att.notifications().find((x) => x.item === it.id)?.delivered).toBe(false); // JOYRIDE_TEST mutes osascript
    await d.req("POST", `/api/guard/requests/${r.body.id}/decide`, { decision: "allow" });
    await flush();
    expect(att.get(it.id)?.resolution).toBe("guard allow");
  });

  it("resolves on reply and approve intents", async () => {
    const a = sid(), b = sid();
    hook(a, "turn.stop", { last: QUESTION });
    hook(b, "permission.request", { tool: "Bash", input: JSON.stringify({ command: "make" }) });
    await flush();
    d.ctx.emit({ source: "intent", type: "intent.sent", data: { intent: { id: "in_1", kind: "reply", target: `claude:${a}`, payload: { text: "yes" } } } });
    d.ctx.emit({ source: "intent", type: "intent.acked", data: { id: "in_2", kind: "approve", target: `claude:${b}`, payload: {} } });
    await flush();
    expect(all(a)[0].resolution).toBe("human replied");
    expect(all(b)[0].resolution).toBe("approved");
  });

  it("flags two active sessions editing the same file within 2h as an L2 overlap", async () => {
    const a = sid(), b = sid(), c = sid();
    const file = `/tmp/demo-repo/src/${sid()}.ts`;
    hook(c, "tool.pre", { tool: "Edit", input: JSON.stringify({ file_path: file, old_string: "a" }) }, ago(30 * 60_000));
    hook(c, "session.end", {}, ago(20 * 60_000)); // ended sessions do not count
    hook(a, "tool.pre", { tool: "Edit", input: JSON.stringify({ file_path: file, old_string: "a" }) }, ago(10 * 60_000));
    await flush();
    expect(att.list({ open: true, kind: "overlap" }).filter((x) => x.ref.paths?.includes(file))).toHaveLength(0);
    hook(b, "tool.pre", { tool: "Write", input: JSON.stringify({ file_path: file, content: "x" }) });
    await flush();
    const ov = att.list({ open: true, kind: "overlap" }).filter((x) => x.ref.paths?.includes(file));
    expect(ov).toHaveLength(1);
    expect(ov[0].level).toBe("L2");
    expect(ov[0].ref.sessions.sort()).toEqual([`claude:${a}`, `claude:${b}`].sort());
  });

  it("does not open items for events older than a day and skips Jev for stale ones", async () => {
    const a = sid(), b = sid();
    hook(a, "turn.stop", { last: QUESTION }, ago(30 * 3600e3));
    hook(b, "turn.stop", { last: QUESTION }, ago(2 * 3600e3));
    await flush();
    expect(all(a)).toHaveLength(0);
    const [it] = open(b);
    expect(it.jev).toBeNull();
    expect(att.notifications().some((x) => x.item === it.id)).toBe(false);
  });

  it("dedupes notifications per session for 10 minutes but lets escalations through", async () => {
    const s = sid();
    hook(s, "permission.request", { tool: "Bash", input: JSON.stringify({ command: "make" }) });
    await flush();
    hook(s, "turn.stop_failure", { error: "crashed" });
    await flush();
    const mine = att.notifications().filter((x) => att.get(x.item)?.session === `claude:${s}`);
    expect(mine.map((x) => [x.level, x.deduped])).toEqual([["L3", true], ["L3", false]]);
    const r = await d.req("POST", "/api/guard/requests", { rule: "publish", title: "npm publish", tool: "Bash", input: { command: "npm publish" }, session: s, agent: "claude", cwd: "/tmp/demo-repo" });
    await flush();
    const l4 = att.notifications().find((x) => att.get(x.item)?.ref.request === r.body.id);
    expect(l4?.deduped).toBe(false);
  });
});

describe("acknowledgement", () => {
  it("clears open counts and asks, retains the Jev result, and supports Undo", async () => {
    const session = sid();
    hook(session, "turn.stop", { last: QUESTION });
    await flush();
    const [item] = open(session);
    const before = att.metrics().open.L3;
    expect((await d.req("GET", "/api/asks")).body.asks.some((a: { ref: { attention?: string } }) => a.ref.attention === item.id)).toBe(true);
    const ack = await d.req("POST", `/api/attention/${item.id}/label`, { label: "ack" });
    expect(ack.body.item.resolution).toBe("acknowledged");
    expect(ack.body.item.jev).toEqual(item.jev);
    expect(open(session)).toEqual([]);
    expect(att.metrics().open.L3).toBe(before - 1);
    expect((await d.req("GET", "/api/asks")).body.asks.some((a: { ref: { attention?: string } }) => a.ref.attention === item.id)).toBe(false);
    expect((await d.req("POST", `/api/attention/${item.id}/undo-ack`)).status).toBe(200);
    expect(open(session).map((a) => a.id)).toEqual([item.id]);
    att.resolve(item.id, "test finished");
  });

  it("does not reopen an acknowledged event when reclassified under a different kind", async () => {
    const session = `claude:${sid()}`;
    const ref = { event: sid(), event_ts: ago(1000) };
    const item = att.raise({ session, level: "L3", kind: "question", title: QUESTION, ref })!;
    att.label(item.id, "ack");
    expect(att.raise({ session, level: "L4", kind: "decision", title: QUESTION, ref })).toBeNull();
    expect(att.list({ session, open: true })).toEqual([]);
  });

  it("opens a new question, block or failure after acknowledgement without copying ack state", async () => {
    for (const type of ["turn.stop", "permission.request", "turn.stop_failure"]) {
      const session = sid();
      hook(session, "turn.stop", { last: QUESTION }, ago(1000));
      await flush();
      const [item] = open(session);
      att.label(item.id, "ack");
      const ts = new Date(Date.now() + 10).toISOString();
      hook(session, type, { last: "Which new option should I use?", tool: "Bash", input: { command: "make" }, error: "new failure" }, ts);
      await flush();
      expect(open(session)).toHaveLength(1);
      expect(open(session)[0].id).not.toBe(item.id);
      expect(open(session)[0].ref.acked_at).toBeUndefined();
      att.resolve(open(session)[0].id, "test finished");
    }
  });

  it("does not resurrect a seen question from an idle reminder", async () => {
    const session = sid();
    hook(session, "turn.stop", { last: QUESTION }, ago(1000));
    await flush();
    att.label(open(session)[0].id, "ack");
    hook(session, "notification", { kind: "idle_prompt" });
    await flush();
    expect(open(session)).toEqual([]);
  });
});

describe("raise, labels and the HTTP API", () => {
  let item: AttentionItem;
  it("raise() stores items for other modules, drops L0, and filters by mission", async () => {
    expect(att.raise({ level: "L0", kind: "nudge", title: "ambient" })).toBeNull();
    item = att.raise({ level: "L1", kind: "nudge", title: "Extract learnings from a long session", why: "42 turns, never distilled", mission: "m-raise", dedupe: "nudge:x" })!;
    const again = att.raise({ level: "L1", kind: "nudge", title: "Extract learnings (updated)", mission: "m-raise", dedupe: "nudge:x" })!;
    expect(again.id).toBe(item.id);
    const r = await d.req("GET", "/api/attention?open=1&mission=m-raise");
    expect(r.body.map((x: AttentionItem) => x.title)).toEqual(["Extract learnings (updated)"]);
  });

  it("applies ack, override, snooze and dismiss without storing training labels", async () => {
    const s = sid();
    hook(s, "turn.stop", { last: PROGRESS });
    await flush();
    const [it] = open(s);
    const ack = await d.req("POST", `/api/attention/${it.id}/label`, { label: "ack" });
    expect(ack.status).toBe(200);
    expect(ack.body.item.resolution).toBe("acknowledged");
    expect(ack.body).not.toHaveProperty("label");
    await d.req("POST", `/api/attention/${it.id}/undo-ack`);
    const ov = await d.req("POST", `/api/attention/${it.id}/label`, { label: "override", level: "L3", reason: "this one matters" });
    expect(ov.body.item.level).toBe("L3");
    expect(ov.body).not.toHaveProperty("label");
    const sn = await d.req("POST", `/api/attention/${it.id}/snooze`, { minutes: 30 });
    expect(Date.parse(sn.body.item.snoozed_until)).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(open(s).length).toBe(1);
    expect(att.list({ open: true, session: `claude:${s}` })).toHaveLength(0); // hidden while snoozed
    const dis = await d.req("POST", `/api/attention/${it.id}/label`, { label: "dismiss" });
    expect(dis.body.item.resolution).toBe("dismissed");
    expect(d.ctx.db.prepare("SELECT name FROM sqlite_master WHERE name = 'attention_labels'").all()).toEqual([]);
    await flush();
    expect((await d.req("GET", "/api/events?type=attention.label")).body).toEqual([]);
  });

  it("rejects bad labels and unknown items with a clear error", async () => {
    expect((await d.req("POST", `/api/attention/${item.id}/label`, { label: "love" })).status).toBe(400);
    expect((await d.req("POST", `/api/attention/${item.id}/label`, { label: "override" })).status).toBe(400);
    expect((await d.req("POST", "/api/attention/nope/label", { label: "ack" })).status).toBe(404);
    expect((await d.req("POST", "/api/attention", { level: "L9", kind: "nudge", title: "x" })).status).toBe(400);
  });

  it("resolves through the API", async () => {
    const r = await d.req("POST", `/api/attention/${item.id}/resolve`, { resolution: "handled" });
    expect(r.body.resolution).toBe("handled");
    expect((await d.req("GET", `/api/attention/${item.id}`)).body.resolved).toBeTruthy();
  });
});

describe("historical labels", () => {
  it("leaves an existing labels table untouched and ignores replayed labels", async () => {
    d.ctx.db.exec("CREATE TABLE attention_labels (id TEXT PRIMARY KEY, item TEXT NOT NULL, label TEXT NOT NULL, created TEXT NOT NULL, json TEXT NOT NULL)");
    const historical = JSON.stringify({ id: "old-label", item: "old-item", label: "ack" });
    d.ctx.db.prepare("INSERT INTO attention_labels VALUES (?, ?, ?, ?, ?)").run("old-label", "old-item", "ack", ago(3600e3), historical);
    d.ctx.emit({ source: "attention", type: "attention.label", data: { label: { id: "replay-label", item: "old-item", label: "ack", created: ago(3600e3) } } });
    await flush();
    const it = att.raise({ level: "L3", kind: "question", title: "Still needs an answer", session: `claude:${sid()}` })!;
    att.label(it.id, "ack");
    expect(att.get(it.id)?.resolution).toBe("acknowledged");
    expect(d.ctx.db.prepare("SELECT id, json FROM attention_labels").all()).toEqual([{ id: "old-label", json: historical }]);
  });
});
