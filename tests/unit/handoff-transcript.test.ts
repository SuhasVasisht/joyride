import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeTranscriptState } from "../../src/modules/sessions/claude.ts";
import { codexTranscript } from "../../src/modules/sessions/codex.ts";

describe("Full handoff transcript", () => {
  it.each(["claude", "codex"])("preserves large %s messages for recovery while keeping display turns bounded", async (agent) => {
    const text = "Meaningful pending decision.\n".repeat(6000) + "KEEP THE FINAL PROMISE";
    const answer = text + " and continue it";
    const file = path.join(process.env.JOYRIDE_RUNTIME!, `${agent}-large-handoff.jsonl`);
    const records = agent === "claude" ? [
      { type: "user", origin: { kind: "human" }, message: { role: "user", content: text } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ] : [
      { type: "event_msg", payload: { type: "user_message", message: text } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ];
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const read = async (fullText = false) => agent === "claude" ? (await claudeTranscriptState(file, 80, { fullText })).turns : codexTranscript(file, 80, { fullText });
    expect((await read()).every((t) => t.text.length < 2100)).toBe(true);
    const full = await read(true);
    expect(full[0].text === text).toBe(true);
    expect(full[1].text === answer).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(156 * 1024);
  });
});
