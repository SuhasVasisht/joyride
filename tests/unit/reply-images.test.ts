import { describe, expect, it } from "vitest";
import { imageMarkers, matchReplies } from "../../src/shared/replies.ts";

const created = "2026-10-05T20:00:00Z";
const reply = (id: string, text = "", images = ["/uploads/a.png"]) => ({ id, text, images, created });
const turn = (text: string, images?: string[], ts = created) => ({ role: "user", ts, text, images });

describe("mapping replies to transcript image slots", () => {
  it("counts an image once when both its marker and its path are present", () => {
    expect(matchReplies([reply("a"), reply("b")], [turn("[Image #1]", ["/uploads/a.png"])])).toEqual([
      { id: "a", turn: 0, offset: 0, images: ["/uploads/a.png"] },
    ]);
  });

  it("maps joined image replies in order, including identical images and image-only replies", () => {
    expect(matchReplies([reply("a", "first"), reply("b", "second"), reply("c")], [turn("[Image #1] first\n[Image #1] second\n[Image #2]")]))
      .toEqual([0, 1, 2].map((offset) => ({ id: ["a", "b", "c"][offset], turn: 0, offset, images: ["/uploads/a.png"] })));
    expect(imageMarkers("[Image#1] [Image #7]")).toBe(2);
  });

  it("does not claim plain path text, older prompts or another image's slots", () => {
    expect(matchReplies([reply("a", "look")], [turn("look /uploads/a.png"), turn("[Image #1] look", undefined, "2026-10-05T19:00:00Z"), turn("[Image #1] look", ["/uploads/b.png"])]))
      .toEqual([]);
  });

  it("recovers a prompt whose image block has no source path or text marker", () => {
    expect(matchReplies([reply("a")], [turn("[image]", [""])]))
      .toEqual([{ id: "a", turn: 0, offset: 0, images: ["/uploads/a.png"] }]);
  });
});
