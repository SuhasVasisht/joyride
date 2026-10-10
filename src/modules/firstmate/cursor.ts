import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseJson, readLines, toolSummary } from "../sessions/lines.ts";
import type { TranscriptState, Turn } from "../sessions/types.ts";

const Message = z.object({
  role: z.enum(["user", "assistant"]), timestamp: z.string().optional(),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional(), name: z.string().optional(), input: z.unknown().optional() })) }),
});

/** Cursor's native primary transcript uses its published session id and project cwd. */
export async function cursorHandoff(session: string | null | undefined, cwd: string): Promise<{ path: string; transcript: TranscriptState }> {
  const id = z.uuid().parse(session?.replace(/^other:/, ""));
  const root = process.env.CURSOR_CONFIG_DIR ?? path.join(os.homedir(), ".cursor");
  const slug = cwd.replace(/[/\\]/g, "-").replace(/^-/, "");
  const file = path.join(root, "projects", slug, "agent-transcripts", id, `${id}.jsonl`);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  await readLines(file, 0, (line) => {
    const raw = parseJson(line);
    if (!raw || (raw.role !== "user" && raw.role !== "assistant")) return;
    const row = Message.parse(raw);
    const text = row.message.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
    if (row.role === "user") {
      current = null;
      if (text) turns.push({ role: "user", ts: row.timestamp ?? null, text, tools: [] });
      return;
    }
    if (!current) { current = { role: "assistant", ts: row.timestamp ?? null, text: "", tools: [] }; turns.push(current); }
    if (text) current.text += (current.text ? "\n\n" : "") + text;
    for (const block of row.message.content) {
      if (block.type === "tool_use" && block.name && current.tools.length < 40)
        current.tools.push({ name: block.name, summary: toolSummary(block.name, block.input) });
    }
  });
  return { path: file, transcript: { turns: turns.slice(-80), queue: null, pulled: null } };
}
