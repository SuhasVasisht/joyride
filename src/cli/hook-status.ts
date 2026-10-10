import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const HookEvent = z.object({ source: z.string(), type: z.string(), ts: z.string() });
/** Hook installation is configuration; only the event log proves hooks actually ran. */
export function codexHookStatus(eventsDir: string): string {
  const seen = new Set<string>();
  let last = "";
  let unreadable = false;
  let files: string[];
  try { files = fs.readdirSync(eventsDir).filter(f => f.endsWith(".jsonl")).sort(); }
  catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) return "Codex hook history unavailable; check event log permissions.";
    files = [];
  }
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(path.join(eventsDir, file), "utf8"); } catch { unreadable = true; continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"hook.codex"')) continue;
      try {
        const event = HookEvent.safeParse(JSON.parse(line));
        if (event.success && event.data.source === "hook.codex") { seen.add(event.data.type); if (event.data.ts > last) last = event.data.ts; }
      } catch { /* A partial append is not evidence that a hook ran. */ }
    }
  }
  if (!seen.size) return unreadable ? "Codex hook history unavailable; check event log permissions." : "Codex hooks have never fired in this event log. In Codex, run /hooks and approve Joyride once. Firstmate crewmates/scouts use --disable hooks; approval does not enable their hooks.";
  const missing = ["session.start", "tool.pre", "session.end"].filter(t => !seen.has(t));
  return `Codex hooks last fired ${last}${missing.length ? `; not yet observed: ${missing.join(", ")}` : "; session.start, tool.pre and session.end observed"}${unreadable ? "; some event files unreadable" : ""}. Firstmate crewmates/scouts disable hooks.`;
}
