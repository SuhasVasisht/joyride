// "This looks moot": the captain-only recheck_ask intent files one inbox note for Firstmate to re-check a
// Firstmate-owned call. It is never an answer, never `reconcile`, and refused for asks Firstmate doesn't own.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { canRecheck, type Ask, type AskAnswer } from "../../src/shared/asks.ts";
import type { IntentsApi } from "../../src/modules/live/intents.ts";
import { recheckText } from "../../src/modules/asks/recheck.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let intents: IntentsApi;
let open: Ask | null;
const note = vi.fn(async () => ({ note: "n1", outcome: "saved", announced: true, path: "/fixture" }));
const hold = vi.fn();
const make = (answer: AskAnswer, extra: Partial<Ask> = {}): Ask => ({
  id: "hold:jr-csv-calls", kind: "captain_call", source: "backlog", title: "Pick the export format", question: "CSV or XLSX?\n(A) CSV; (B, recommended) both",
  preamble: "", calls: [], options_source: "parsed", recommended_answer: null, needs_you: true, owner: "captain", state: "Needs you", level: "L3",
  task: "jr-csv-calls", worker: null, session: null, mission: "csv-export", place: { on: "task", id: "jr-csv-calls" }, answer, opened: null, read_only: null, ref: {}, ...extra,
});

beforeAll(async () => {
  d = await sandboxDaemon("recheck-ask", ["live"]);
  intents = d.ctx.service<IntentsApi>("intents");
  const { registerRecheck } = await import("../../src/modules/asks/recheck.ts");
  registerRecheck(d.ctx, { get: () => open, list: () => (open ? [open] : []), refresh: () => false, registerSource: () => () => {}, response: () => { throw new Error("unused"); } });
  d.ctx.services.set("firstmate", { note, answerHold: hold });
});
afterAll(async () => { await d.stop(); });
beforeEach(() => { vi.clearAllMocks(); open = make({ via: "fm-captain-hold", target: "jr-csv-calls", modes: ["done"] }); });

describe("recheck_ask", () => {
  it("files one inbox note with the markers and never touches the hold", async () => {
    const it1 = await intents.create("recheck_ask", open!.id, { words: "We dropped XLSX last week" }, { origin: "captain" });
    expect(it1.status, it1.error ?? "").toBe("sent");
    expect(it1.result).toMatchObject({ ask: open!.id, via: "inbox", note: "n1" });
    expect(note).toHaveBeenCalledTimes(1);
    const [rid, body] = note.mock.calls[0] as unknown as [string, string];
    expect(rid).toBe(it1.id);
    expect(body).toContain("may be moot");
    expect(body).toContain("We dropped XLSX last week");
    expect(body).toContain("joyride-mission: csv-export");
    expect(body).toContain(`joyride-request: ${it1.id}`);
    expect(hold).not.toHaveBeenCalled();
  });
  it.each(["firstmate", "evolution"] as const)("refuses origin %s", async (origin) => {
    expect(await intents.create("recheck_ask", open!.id, {}, { origin })).toMatchObject({ status: "failed", result: { refused: "captain_only" } });
    expect(note).not.toHaveBeenCalled();
  });
  it("refuses asks Firstmate doesn't own, and closed ones", async () => {
    open = make({ via: "answer_prompt", target: "local:p1" }, { id: "attention:a1", kind: "prompt", source: "attention" });
    expect(await intents.create("recheck_ask", open.id, {})).toMatchObject({ status: "failed", result: { refused: "not_firstmate_call" } });
    open = null;
    expect(await intents.create("recheck_ask", "hold:gone", {})).toMatchObject({ status: "failed", result: { refused: "ask_closed" } });
    expect(note).not.toHaveBeenCalled();
  });
  it("offers the button only for holds and crew decisions that can be answered here", () => {
    expect(canRecheck(make({ via: "fm-captain-hold", target: "t", modes: ["done"] }))).toBe(true);
    expect(canRecheck(make({ via: "fm-send-resolve-key", target: "t", key: "k" }))).toBe(true);
    expect(canRecheck(make({ via: "fm-send", target: "t" }))).toBe(true);
    expect(canRecheck(make({ via: "fm-captain-hold", target: "t", modes: ["done"] }, { read_only: "Answer in Firstmate" }))).toBe(false);
    for (const answer of [{ via: "ack", target: "a" }, { via: "approve_deny", target: "g" }, { via: "prune", target: "p" }, { via: "none", target: null }] as AskAnswer[]) expect(canRecheck(make(answer))).toBe(false);
  });
  it("words the decision case for its worker, and never asks Joyride to reconcile", () => {
    const text = recheckText(make({ via: "fm-send-resolve-key", target: "scout", key: "flake-cause" }, { id: "decision:scout:flake-cause", mission: null }), "int_1");
    expect(text).toContain("resolve the decision with its worker");
    expect(text).not.toContain("joyride-mission:");
    expect(text).toContain("joyride-request: int_1");
  });
});
