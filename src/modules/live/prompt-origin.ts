import fs from "node:fs/promises";
import { z } from "zod";
import type { EventRecord } from "../../shared/schema.ts";
import { readLines } from "../sessions/lines.ts";

const Prompt = z.object({
  type: z.literal("user"), promptId: z.string(), sessionId: z.string(),
  isSidechain: z.boolean().optional(), isMeta: z.boolean().optional(),
  turnOrigin: z.string().optional(), scheduledTaskId: z.string().optional(),
});

/** Claude 2.1.289 hooks carry prompt_id, but only the transcript carries scheduled origin.
 * Wait beyond the default submission-hook timeout; never match arbitrary wakeup prose.
 * Legacy hooks and missing stores keep their existing attribution behavior. */
export async function isScheduledPrompt(e: EventRecord): Promise<boolean> {
  const { transcript, prompt_id: id } = e.data ?? {};
  if (e.source !== "hook.claude" || typeof transcript !== "string" || typeof id !== "string" || !id) return false;
  const deadline = Date.now() + 35_000;
  try {
    // A newly submitted prompt is at the tail. Avoid reading years of conversation on each steer.
    let offset = Math.max(0, (await fs.stat(transcript)).size - (4 << 20));
    do {
      let scheduled: boolean | undefined;
      const read = await readLines(transcript, offset, (line) => {
        if (!line.includes(id)) return;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { return; }
        const parsed = Prompt.safeParse(raw);
        if (!parsed.success) return;
        const r = parsed.data;
        if (r.promptId !== id || r.sessionId !== e.session || r.isSidechain) return;
        scheduled = r.turnOrigin === "scheduled" || (r.isMeta === true && !!r.scheduledTaskId);
      });
      if (scheduled !== undefined) return scheduled;
      offset = read.end;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
  } catch { /* Missing or unreadable transcripts cannot stop the daemon. */ }
  return false;
}
