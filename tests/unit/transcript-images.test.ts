// Images in a conversation: the transcript readers put the attached images' paths on the user
// turn, so the chat view shows them. Record shapes are trimmed from a Herdr lab run where Joyride
// relayed two images to Claude Code 2.1.289 and Codex 0.160.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claudeTranscript } from "../../src/modules/sessions/claude.ts";
import { codexHumanText, codexImages, codexTranscript } from "../../src/modules/sessions/codex.ts";

const A = "/data/.joyride/uploads/2026-10-04/abc123def.png";
const B = "/data/.joyride/uploads/2026-10-04/ghi456jkl.jpg";
const write = (name: string, records: unknown[]) => {
  const p = path.join(process.env.JOYRIDE_RUNTIME!, name);
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

describe("images in transcripts", () => {
  it("keeps image-only inputs even when they have no text or source path", async () => {
    expect(codexHumanText([{ type: "input_image", image_url: "data:" }])).toBe("[image]");
    const file = write("codex-image-only.jsonl", [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:" }] } }]);
    expect((await codexTranscript(file, 10))[0]).toMatchObject({ role: "user", text: "[image]", images: [""] });
    const claude = write("claude-image-only.jsonl", [{ type: "user", message: { content: [{ type: "image", source: { type: "base64", data: "" } }] } }]);
    expect((await claudeTranscript(claude, 10))[0]).toMatchObject({ role: "user", text: "[image]", images: [""] });
  });
  it("Claude Code: the meta record after the prompt names each image's source", async () => {
    const file = write("claude-images.jsonl", [
      { type: "user", uuid: "u1", timestamp: "2026-10-04T21:44:00Z", origin: { kind: "human" }, imagePasteIds: [1, 2],
        message: { role: "user", content: [{ type: "text", text: "[Image #1] [Image #2]Which two words?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBO" } }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" } }] } },
      { type: "user", uuid: "u2", isMeta: true, timestamp: "2026-10-04T21:44:00Z",
        message: { role: "user", content: [{ type: "text", text: `[Image: source: ${A}]` }, { type: "text", text: `[Image: source: ${B}]` }] } },
      { type: "assistant", uuid: "a1", timestamp: "2026-10-04T21:44:05Z", message: { role: "assistant", content: [{ type: "text", text: "GIRAFFE 7 and OTTER 3." }] } },
      { type: "user", uuid: "u3", timestamp: "2026-10-04T21:45:00Z", origin: { kind: "human" }, message: { role: "user", content: "thanks" } },
    ]);
    const turns = await claudeTranscript(file, 10);
    expect(turns.map((t) => [t.role, t.text, t.images ?? null])).toEqual([
      ["user", "[Image #1] [Image #2]Which two words?", [A, B]],
      ["assistant", "GIRAFFE 7 and OTTER 3.", null],
      ["user", "thanks", null],
    ]);
  });

  it("Codex: local_image items, or the <image path> wrapper of the model input", async () => {
    expect(codexImages([{ type: "local_image", path: A }, { type: "text", text: "[Image #1] hi" }])).toEqual([A]);
    expect(codexImages([{ type: "input_text", text: `<image name=[Image #1] path="${B}">` }, { type: "input_image", image_url: "data:" }, { type: "input_text", text: "</image>" }])).toEqual([B]);
    const file = write("codex-images.jsonl", [
      { timestamp: "2026-10-04T21:44:41Z", type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "m1", content: [{ type: "local_image", path: A }, { type: "local_image", path: B }, { type: "text", text: "[Image #1] [Image #2] Which two words?" }] } } },
      { timestamp: "2026-10-04T21:44:45Z", type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "m2", content: [{ type: "Text", text: "GIRAFFE 7 and OTTER 3." }] } } },
    ]);
    const turns = await codexTranscript(file, 10);
    expect(turns[0]).toMatchObject({ role: "user", text: "[Image #1] [Image #2] Which two words?", images: [A, B] });
    expect(turns[1]).toMatchObject({ role: "assistant", text: "GIRAFFE 7 and OTTER 3." });
    expect(turns[1].images).toBeUndefined();
    // Older rollouts carry the human turn as a user_message event with local_images.
    const older = write("codex-older.jsonl", [
      { timestamp: "2026-10-04T21:44:41Z", type: "event_msg", payload: { type: "user_message", message: "[Image #1] look", images: ["data:image/png;base64,iVBO"], local_images: [A] } },
      { timestamp: "2026-10-04T21:44:45Z", type: "event_msg", payload: { type: "agent_message", message: "Seen." } },
    ]);
    expect((await codexTranscript(older, 10))[0]).toMatchObject({ role: "user", text: "[Image #1] look", images: [A] });
  });
});
