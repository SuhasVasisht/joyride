// Where the captain placed each group on the map: map/layout.yaml, authored data like lenses. Positions are
// in near units (1 unit is 1px at Near zoom, scale 1); the map spreads them per zoom level and keeps groups
// from overlapping (src/ui/views/map/arrange.ts). A group without a position keeps its flowed spot.
import fs from "node:fs";
import YAML from "yaml";
import { z } from "zod";

export type GroupPos = { x: number; y: number };
/** Group ids as the map charts them: lens:<id>, repo:<path>, unfiled:<project>, spec:<id>, health:<state>, all. */
export const MapGroupId = z.string().min(1).max(300).regex(/^(?:(?:lens|repo|unfiled|spec|health|server):[^\n\r]*|all)$/, "Use a group id from map show, such as lens:<id>, repo:<path>, server:<id> or unfiled:<project>.");
const Coord = z.number().finite().min(-1e6).max(1e6);
const Pos = z.object({ x: Coord, y: Coord }).strict();
const File = z.object({ groups: z.record(z.string(), Pos).default({}) }).passthrough();

const round = (n: number) => Math.round(n * 10) / 10;

export function readLayout(file: string): Map<string, GroupPos> {
  let raw: unknown = null;
  try { raw = YAML.parse(fs.readFileSync(file, "utf8")); } catch { return new Map(); }
  const parsed = File.safeParse(raw ?? {});
  if (!parsed.success) return new Map();
  return new Map(Object.entries(parsed.data.groups).filter(([id]) => MapGroupId.safeParse(id).success));
}

/** The file's text: groups in the order they were placed (the last one moved, last). */
export function renderLayout(groups: ReadonlyMap<string, GroupPos>): string {
  const lines = [...groups].map(([id, p]) => `  ${JSON.stringify(id)}: { x: ${round(p.x)}, y: ${round(p.y)} }`);
  return "# Where groups sit on the map, in near units (1 unit is 1px at Near zoom). Written by the map; Undo restores it.\n"
    + (lines.length ? `groups:\n${lines.join("\n")}\n` : "groups: {}\n");
}

export const PlaceInput = z.union([
  // The map: the whole arrangement after a drop, the moved group last.
  z.object({ positions: z.record(z.string(), Pos), moved: MapGroupId, title: z.string().max(200).optional(), actor: z.unknown().optional() }).strict(),
  // An agent: one group to a position, or back to its flowed spot.
  z.object({ group: z.string().min(1).max(300), x: Coord, y: Coord, actor: z.unknown().optional() }).strict(),
  z.object({ group: z.string().min(1).max(300), reset: z.literal(true), actor: z.unknown().optional() }).strict(),
]);
export type PlaceInput = z.infer<typeof PlaceInput>;

/** A group id as the map charts it; a bare lens id (from map show's groups) means that lens's group. */
export const groupKey = (g: string) => (/^(lens|repo|unfiled|spec|health|server):/.test(g) || g === "all" || g === "firstmate" ? g : `lens:${g}`);

/** The next arrangement for a request, or the reason it can't be made. */
export function nextLayout(current: ReadonlyMap<string, GroupPos>, input: PlaceInput): { groups: Map<string, GroupPos>; moved: string } {
  if ("positions" in input) {
    const groups = new Map<string, GroupPos>();
    for (const [id, p] of Object.entries(input.positions)) if (MapGroupId.safeParse(id).success) groups.set(id, p);
    if (!groups.has(input.moved)) throw new Error(`The arrangement has no position for ${input.moved}.`);
    const p = groups.get(input.moved)!;
    groups.delete(input.moved);
    groups.set(input.moved, p);
    return { groups, moved: input.moved };
  }
  const id = groupKey(input.group);
  if (id === "firstmate") throw new Error("Firstmate's hub stays where it is.");
  const ok = MapGroupId.safeParse(id);
  if (!ok.success) throw new Error(ok.error.issues[0]?.message ?? "Unknown group.");
  const groups = new Map(current);
  groups.delete(id);
  if (!("reset" in input)) groups.set(id, { x: input.x, y: input.y });
  return { groups, moved: id };
}
