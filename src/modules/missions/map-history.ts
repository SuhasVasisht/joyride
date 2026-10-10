import { z } from "zod";
import { git } from "../../core/util.ts";
import { paths } from "../../shared/paths.ts";
import { MapActor } from "../../shared/map-actions.ts";

export type MapHistoryEntry = { id: string; commit: string | null; key?: string; at: string; summary: string; actor: MapActor | null; undone: boolean };
const Row = z.tuple([z.string(), z.string(), z.string()]);
let cached: { head: string; entries: MapHistoryEntry[] } | null = null;
export function readMapHistory(): MapHistoryEntry[] {
  const head = git(paths.root, ["rev-parse", "HEAD"], { allowFail: true });
  if (cached?.head === head) return cached.entries;
  const log = git(paths.root, ["log", "-n", "500", "--format=%H%x00%aI%x00%B%x00", "--grep=^joyride: \\(map move:\\|undo map move \\)", "--", "missions", "lenses", "map"], { allowFail: true });
  const parts = log.split("\0");
  const rows: z.infer<typeof Row>[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) rows.push(Row.parse([parts[i].trim(), parts[i + 1], parts[i + 2]]));
  const undone = new Set(rows.flatMap(([, , body]) => {
    const match = body.match(/^joyride: undo map move ([0-9a-f]+)/);
    return match ? [match[1]] : [];
  }));
  const entries = rows.filter(([, , body]) => body.startsWith("joyride: map move:")).map(([commit, at, body]) => {
    const trailer = body.match(/^Map-actor: (.+)$/m);
    let actor: MapActor | null = null;
    if (trailer) {
      try { const parsed = MapActor.safeParse(JSON.parse(trailer[1])); if (parsed.success) actor = parsed.data; } catch { /* older commits have no attribution */ }
    }
    return { id: commit, commit, at, summary: body.split("\n")[0].replace(/^joyride: map move: /, "").replace(/^mission /, "idea ").replace(/ to lens /, " to group "), actor, undone: [...undone].some((sha) => commit.startsWith(sha)) };
  });
  cached = { head, entries };
  return entries;
}
