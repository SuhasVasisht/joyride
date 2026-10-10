// "Save and tell Firstmate": the text of the captain inbox note that points Firstmate at a saved note.
// It carries the note's bullets, how to read it again, and the joyride-mission and joyride-request
// markers Firstmate keeps verbatim in a brief (control-plane report §10, preference bullet 3).
import type { NoteAnchor } from "../../shared/notes.ts";

export type TellInput = {
  requestId: string;
  note: { id: string; bullets: string[]; anchor: NoteAnchor };
  /** The idea the note belongs to: its own for an idea note, its task's for a task note. */
  mission: { id: string; title: string } | null;
};

function place(a: NoteAnchor, mission: TellInput["mission"]): string {
  if (a.kind === "mission") return `the idea "${mission?.title ?? a.id}" (${a.id})`;
  if (a.kind === "task") return `task ${a.id}${mission ? ` in the idea "${mission.title}"` : ""}`;
  if (a.kind === "session") return `the agent session ${a.id}`;
  return "no particular idea or task (a global note)";
}

function readBack(a: NoteAnchor): string {
  if (a.kind === "mission") return "joyride notes --idea " + a.id;
  if (a.kind === "task") return "joyride notes --task " + a.id;
  if (a.kind === "session") return "joyride notes --session " + a.id;
  return "joyride notes --global";
}

export function tellText({ requestId, note, mission }: TellInput): string {
  return [
    `The captain saved a note on ${place(note.anchor, mission)} in Joyride and asked you to read it:`,
    ...note.bullets.map((b) => `- ${b}`),
    "",
    `Note ${note.id}; read it and its neighbours with \`${readBack(note.anchor)}\`. Act on it, or keep it for the next brief on this work.`,
    ...(mission ? [`joyride-mission: ${mission.id}`] : []),
    `joyride-request: ${requestId}`,
  ].join("\n");
}
