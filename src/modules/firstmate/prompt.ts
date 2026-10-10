// The task request Joyride files as a captain inbox note (bin/fm-inbox.sh) for a
// create_task intent. Firstmate (the orchestrator) decides the crew; Joyride only states
// the goal, the definition of done, the evidence rule and the delivery mode.
import type { Mission } from "../../shared/schema.ts";
import { requestMarker } from "./request.ts";

export const missionMarker = (id: string) => `joyride-mission: ${id}`;

/** The idea's notes carried in a task request: at most this many bullets and characters. */
export const REQUEST_NOTES_MAX_BULLETS = 30;
export const REQUEST_NOTES_MAX_CHARS = 2500;

export function buildTaskRequest(o: {
  mission: Mission; brief: string; evidenceBin: string; skillsDir: string; images?: string[];
  /** The create_task intent id: the request marker lets the map follow this request to the task it becomes. */
  request?: string;
  /** The captain's notes on this idea (src/modules/notes), newest first: each note's bullets. */
  notes?: string[][];
}): string {
  const m = o.mission;
  const goal = m.goal.trim().replace(/\n{3,}/g, "\n\n");
  const lines: string[] = [];
  lines.push(`Ahoy. Joyride request: please create a task for the mission "${m.title}".`);
  lines.push("");
  lines.push(`Keep ${o.request ? "these lines" : "this line"} verbatim in the task brief (Captain's intent) so Joyride can map the task back to its mission${o.request ? " and to this request" : ""}:`);
  lines.push(missionMarker(m.id));
  if (o.request) lines.push(requestMarker(o.request));
  lines.push("");
  lines.push(`What to do: ${o.brief.trim()}`);
  if (o.images?.length) { lines.push(""); lines.push(imagesNote(o.images, "Put these paths in the task brief so the crewmate opens them too")); }
  if (goal) { lines.push(""); lines.push(`Mission goal: ${goal.length > 1500 ? goal.slice(0, 1500) + " …" : goal}`); }
  if (m.done_when.length) {
    lines.push("");
    lines.push("Done when:");
    for (const c of m.done_when) lines.push(`- ${c.text}`);
  }
  const notes = requestNotes(o.notes ?? []);
  if (notes.lines.length) {
    lines.push("");
    lines.push(`The captain's notes on this idea (put them in the task brief${notes.more ? `; ${notes.more} more via \`joyride notes --idea ${m.id}\`` : ""}):`);
    lines.push(...notes.lines);
  }
  lines.push("");
  const repos = m.repos.length ? m.repos : [];
  if (repos.length) {
    lines.push(`Project: ${repos.join(", ")}${m.branches.length ? ` (branches: ${m.branches.join(", ")})` : ""}. Project mode local-only, no push/PR. If the project is not registered yet, register it as local-only: clone it from that path into projects/<name> and make no remote or GitHub calls.`);
  } else {
    lines.push("Project: the mission names no repo yet; ask me which project before spawning. Project mode local-only, no push/PR.");
  }
  lines.push("");
  lines.push(`Evidence: the crewmate must record proof with joyride-evidence before reporting done, for example \`${o.evidenceBin} run --mission ${m.id} --name "unit tests" -- <test command>\`, plus Playwright screenshots for UI changes. A claim without a recorded run counts as nothing.`);
  lines.push("");
  lines.push(`Skills: use the repo instructions and the skills in ${o.skillsDir} when the task calls for them.`);
  lines.push("");
  lines.push("Delivery: project mode local-only, no push/PR. Stop with a clean ready branch; land it locally only after I approve.");
  if (o.request) { lines.push(""); lines.push("If you decide not to make a task of this, answer it with `fm-inbox.sh reply <note id>` so the map shows why."); }
  return lines.join("\n");
}

function requestNotes(notes: string[][]): { lines: string[]; more: number } {
  const lines: string[] = [];
  let chars = 0, more = 0;
  for (const b of notes.flat()) {
    const l = `- ${b}`;
    if (lines.length >= REQUEST_NOTES_MAX_BULLETS || chars + l.length > REQUEST_NOTES_MAX_CHARS) { more++; continue; }
    lines.push(l); chars += l.length + 1;
  }
  return { lines, more };
}

/** The image paths spelled out for an agent, with how to open them (Claude Code's Read, Codex's view_image). */
export function imagesNote(images: string[], then: string): string {
  const head = images.length === 1 ? "The captain attached an image. It is stored at:" : `The captain attached ${images.length} images. They are stored at:`;
  return [head, ...images.map((p) => `- ${p}`), `${then}: Read in Claude Code and view_image in Codex load an image from its path.`].join("\n");
}
