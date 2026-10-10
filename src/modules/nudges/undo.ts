import type { UndoNotice } from "../../shared/nudges.ts";
type RuleRun = { id: string; kind: string; at: string; summary: string; commit: string | null; undone: unknown; dry_run: boolean; agent?: string; key?: string };

/** Recent committed edits for the existing Undo toast, independent of nudge rules. */
export function undoNotices(runs: RuleRun[], now: number): UndoNotice[] {
  return runs.filter((r) => !r.dry_run && (r.commit || r.kind === "map-hide") && !r.undone && now - Date.parse(r.at) <= 864e5)
    .map((r) => ({
      id: `tidied:${r.id}`,
      title: r.kind.startsWith("map") ? `Map edit by ${r.agent}: ${r.summary}` : `Tidied: ${r.summary || "housekeeping changed your ideas"}`,
      why: r.kind === "map-hide" ? "An agent set work aside. Undo returns it to the map." : r.kind.startsWith("map") ? "An agent edited your map. Undo restores exactly what it changed." : r.kind === "place" ? "Housekeeping filed Firstmate tasks into ideas." : "Housekeeping tidied your ideas and groups.",
      ref: { run: r.id, commit: r.commit, kind: r.kind, ...(r.key ? { key: r.key } : {}) },
    }));
}
