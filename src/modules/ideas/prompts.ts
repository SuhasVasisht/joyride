import { registerLlmFake } from "../../core/fakes.ts";
import { truncate } from "../../core/util.ts";

export const NAMING_SCHEMA = {
  type: "object",
  properties: {
    existing: { type: "string", description: "id of the open idea this task belongs to, or \"\" for a new idea" },
    title: { type: "string" },
    goal: { type: "string" },
    group: { type: "string", description: "id of an existing group for a new idea, or \"\"" },
  },
  required: ["existing", "title", "goal", "group"],
  additionalProperties: false,
};
export type Naming = { existing: string; title: string; goal: string; group: string };

export type NamingInput = {
  task: { id: string; title: string; kind: string; repo: string | null; brief: string; last_event: string };
  ideas: { id: string; title: string; goal: string; tasks: string[] }[];
  groups: { id: string; title: string }[];
};

export function namingPrompt(input: NamingInput): string {
  return [
    "You keep a developer's ideas tidy. An idea is one stream of the captain's intent (\"One fleet\", \"Knowledge home\"); tasks are pieces of work inside an idea.",
    "A Firstmate task was filed without an idea. Decide where it goes:",
    "- If it clearly continues one of the open ideas below, set existing to that idea's id and copy its title.",
    "- Otherwise set existing to \"\" and name a new idea: title is 2 to 6 words, sentence case, naming the outcome (not the repo, not the task id); goal is one plain sentence about what the stream of work is for.",
    "- group: for a new idea, the id of the group below it fits best, or \"\" when none fits.",
    "Use only what is given. Return JSON only.",
    "<task>",
    JSON.stringify(input.task),
    "</task>",
    "<ideas>",
    JSON.stringify(input.ideas),
    "</ideas>",
    "<groups>",
    JSON.stringify(input.groups),
    "</groups>",
  ].join("\n");
}

// ---------- fakes (JOYRIDE_FAKE_MODELS=1) ----------

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? []));

/** Joins the open idea sharing two or more words with the task's title; otherwise names a new idea after the task. */
registerLlmFake("idea_naming", (prompt: string) => {
  const grab = (tag: string) => { const m = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`)); return m ? JSON.parse(m[1]) : null; };
  const task = grab("task") ?? { title: "Untitled task" };
  const ideas: NamingInput["ideas"] = grab("ideas") ?? [];
  const tw = words(`${task.title}`);
  let best: { id: string; title: string } | null = null, bestN = 1;
  for (const i of ideas) { let n = 0; for (const w of words(i.title)) if (tw.has(w)) n++; if (n > bestN) { bestN = n; best = i; } }
  if (best) return { existing: best.id, title: best.title, goal: "", group: "" };
  const title = String(task.title).replace(/^(scout|ship)\s*:?\s*/i, "").split(/\s+/).slice(0, 5).join(" ");
  return { existing: "", title: title.replace(/^[a-z]/, (c) => c.toUpperCase()) || "New idea", goal: `Deliver: ${task.title}.`, group: "" };
});
