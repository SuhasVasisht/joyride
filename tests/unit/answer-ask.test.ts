import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import type { Ask, AskAnswer } from "../../src/shared/asks.ts";
import { loadNoteFiles } from "../../src/shared/note-files.ts";
import type { IntentsApi, IntentRecord } from "../../src/modules/live/intents.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let intents: IntentsApi;
const entries = () => loadNoteFiles(d.sb.env.JOYRIDE_HOME + "/notes").notes;
let open: Ask | null;
let sequence = 0;
const hold = vi.fn(async () => ({ output: "closed: call" }));
const decision = vi.fn(async () => ({ output: "recorded" }));
const note = vi.fn(async () => ({ note: "n", outcome: "saved", announced: true, path: "/fixture" }));
const ack = vi.fn();
const resolve = vi.fn();
const child = vi.fn(async (_it: IntentRecord) => ({ picked: "Yes" }));
const make = (answer: AskAnswer): Ask => ({
  id: `ask-${++sequence}`, kind: "captain_call", source: "backlog", title: "Pick the export format", question: "CSV or XLSX?",
  preamble: "", calls: [], options_source: "none", recommended_answer: "CSV and XLSX", needs_you: true, owner: "captain", state: "Needs you", level: "L3",
  task: "call", worker: null, session: null, mission: "csv-export", place: { on: "task", id: "call" }, answer, opened: new Date().toISOString(), read_only: null, ref: {},
});
const send = (answer = "Use both", extra: Record<string, unknown> = {}, origin: "captain" | "firstmate" | "evolution" = "captain") => intents.create("answer_ask", open!.id, { answer, ...extra }, { origin });

beforeAll(async () => {
  d = await sandboxDaemon("answer-ask", ["live"]);
  intents = d.ctx.service<IntentsApi>("intents");
  const { registerAnswers } = await import("../../src/modules/asks/answer.ts");
  registerAnswers(d.ctx, { get: () => open, list: () => open ? [open] : [], refresh: () => false, registerSource: () => () => {}, response: () => { throw new Error("unused"); } });
  d.ctx.services.set("firstmate", { reload: () => false, answerHold: hold, answerDecision: decision, note, task: () => ({ report: "/fixture/report.md" }) });
  d.ctx.services.set("attention", { label: ack, resolve });
  for (const kind of ["answer_prompt", "reply", "approve", "deny"]) intents.registerHandler(kind, child);
});
afterAll(async () => { await d.stop(); });
beforeEach(() => { vi.clearAllMocks(); open = make({ via: "fm-captain-hold", target: "call", modes: ["done", "release"] }); });

describe("captain answer channel", () => {
  it.each(["firstmate", "evolution"] as const)("refuses %s before delivery or notes", async (origin) => {
    expect(await send("yes", {}, origin)).toMatchObject({ status: "failed", result: { refused: "captain_only" } });
    expect(hold).not.toHaveBeenCalled(); expect(note).not.toHaveBeenCalled();
  });
  it("records the exact answer, routes done and captures an active idea decision with its report", async () => {
    const result = await send("Go with your recommendations: 1 A, 2 B. Keep rounding unchanged.");
    expect(result.status, result.error ?? "").toBe("sent");
    expect(hold).toHaveBeenCalledWith("call", "Go with your recommendations: 1 A, 2 B. Keep rounding unchanged.", open!.title, "done");
    expect(note).toHaveBeenCalledWith(result.id, expect.stringContaining("Captain answered call on the map:"));
    const entry = entries().filter(e => e.scope === "mission:csv-export").find((e) => e.provenance.ref === `answer_ask:${result.id}`)!;
    expect(entry).toMatchObject({ kind: "note", status: "active", scope: "mission:csv-export" });
    expect(entry.body).toContain("CSV or XLSX?"); expect(entry.body).toContain("CSV and XLSX"); expect(entry.body).toContain("/fixture/report.md");
  });
  it("routes release and preserves the mode on identical replay after the ask disappears", async () => {
    const target = open!.id;
    expect((await send("Ship it", { mode: "release" })).status).toBe("sent");
    expect(hold).toHaveBeenCalledWith("call", "Ship it", open!.title, "release");
    open = null;
    expect(await intents.create("answer_ask", target, { answer: "Ship it", mode: "release" })).toMatchObject({ status: "sent", result: { replay: true } });
    expect(hold).toHaveBeenCalledTimes(1); expect(note).toHaveBeenCalledTimes(1);
    expect((await intents.create("answer_ask", target, { answer: "Ship it", mode: "done" })).status).toBe("failed");
  });
  it("serializes concurrent identical answers and resumes after a wake failure without redelivery", async () => {
    note.mockRejectedValueOnce(new Error("wake unavailable"));
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status)).toEqual(["failed", "sent"]);
    expect(hold).toHaveBeenCalledTimes(1); expect(note).toHaveBeenCalledTimes(2);
    expect(entries().filter((e) => e.provenance.ref === `answer_ask:${results[0].id}`)).toHaveLength(1);
  });
  it("treats a new hold lifecycle as a new call on the same task", async () => {
    await send();
    open = { ...open!, opened: "2099-01-01T00:00:00Z" };
    expect((await send("Use CSV only")).status).toBe("sent");
    expect(hold).toHaveBeenCalledTimes(2);
  });
  it.each(["reconcile", "yes\nother\tanswer", "yes\twrong-mode", " ", "x".repeat(513), "yes\x00no"])("refuses unsafe intake value %j", async (answer) => {
    expect((await send(answer)).status).toBe("failed"); expect(hold).not.toHaveBeenCalled();
  });
  it("leaves an owner failure retryable and never files a wake or a decision for a skipped answer", async () => {
    hold.mockRejectedValueOnce(new Error("skipped: call (already closed)"));
    expect((await send()).status).toBe("failed"); expect(note).not.toHaveBeenCalled();
    expect((await send()).status).toBe("sent"); expect(hold).toHaveBeenCalledTimes(2);
  });
  it("keeps a secondmate hold read-only", async () => {
    open = { ...open!, read_only: "Answer in Firstmate", answer: { via: "none", target: null } };
    expect(await send()).toMatchObject({ status: "failed", result: { refused: "read_only" } }); expect(hold).not.toHaveBeenCalled();
  });
  it.each([true, false])("routes a crewmate decision, keyed=%s", async (keyed) => {
    open = make(keyed ? { via: "fm-send-resolve-key", target: "crew", key: "flake-cause" } : { via: "fm-send", target: "crew" });
    expect((await send("Fix the race")).status).toBe("sent");
    expect(decision).toHaveBeenCalledWith("crew", "Fix the race", ...(keyed ? ["flake-cause"] : []));
  });
  it.each([
    ["answer_prompt", "allow", "answer_prompt", { choice: "allow" }],
    ["reply", "Fix the race", "reply", { text: "Fix the race" }],
    ["approve_deny", "allow", "approve", { reason: "Captain answered on the Joyride map" }],
    ["approve_deny", "deny", "deny", { reason: "Captain answered on the Joyride map" }],
  ] as const)("routes %s through its existing owner", async (via, answer, kind, payload) => {
    open = make({ via, target: "worker-or-guard" });
    expect((await send(answer)).status).toBe("sent");
    expect(child.mock.calls[0][0]).toMatchObject({ kind, target: "worker-or-guard", origin: "captain", payload });
  });
  it("propagates a prompt refusal and leaves attention open", async () => {
    intents.registerHandler("answer_prompt", () => { throw new Error("prompt changed"); });
    open = { ...make({ via: "answer_prompt", target: "w" }), kind: "prompt", ref: { attention: "att" } };
    expect((await send("allow")).status).toBe("failed"); expect(resolve).not.toHaveBeenCalled();
    intents.registerHandler("answer_prompt", child);
  });
  it.each(["ack", "nudge"] as const)("acknowledges %s", async (via) => {
    open = make(via === "ack" ? { via, target: "attention" } : { via, target: "attention", mission: "csv-export" });
    expect((await send("Reviewed")).status).toBe("sent"); expect(ack).toHaveBeenCalledWith("attention", "ack", { reason: "Reviewed" });
  });
});
