// Where groups sit when the captain has placed them: positions are stored in "near units" (1 unit is
// 1px at Near, scale 1) and spread per zoom level, so an arrangement keeps its shape at every zoom even
// though a group's footprint changes with it (text keeps its screen size). Settling then keeps groups
// apart: each one lands on the free spot nearest where it wants to be.

export type Pos = { x: number; y: number };
export type Positions = ReadonlyMap<string, Pos>;
export type Box = { id: string; x: number; y: number; w: number; h: number };
type Level = "far" | "mid" | "near";

/** The gap settling keeps between two groups, in world units. */
export const GROUP_GAP = 56;

// A typical idea cell at each level: its width (the larger of its fixed width and its minimum screen
// width over the scale) and height (screen px over the scale), plus the gaps the layout puts around it.
const CELL_W: Record<Level, number> = { far: 400, mid: 360, near: 400 };
const MIN_SCREEN_W: Record<Level, number> = { far: 220, mid: 240, near: 240 };
const CELL_H: Record<Level, number> = { far: 60, mid: 140, near: 260 };
const cellX = (lv: Level, ls: number) => Math.max(CELL_W[lv], MIN_SCREEN_W[lv] / ls) + Math.max(52, 16 / ls);
const cellY = (lv: Level, ls: number) => CELL_H[lv] / ls + Math.max(36, 12 / ls);

/** How far stored positions spread at a level and layout scale, per axis. Near at scale 1 is 1. */
export function spread(level: Level, ls: number): Pos {
  return { x: cellX(level, ls) / cellX("near", 1), y: cellY(level, ls) / cellY("near", 1) };
}
export const toWorld = (p: Pos, sp: Pos): Pos => ({ x: p.x * sp.x, y: p.y * sp.y });
/** World position to stored near units, rounded so the file stays readable. */
export const toStored = (p: Pos, sp: Pos): Pos => ({ x: Math.round((p.x / sp.x) * 10) / 10, y: Math.round((p.y / sp.y) * 10) / 10 });

const overlaps = (a: Box, b: Box, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * Place boxes in order without overlaps: each takes the free spot nearest its wish (x, y), trying the wish
 * itself, then edges just past every box already placed. Earlier boxes never move for later ones.
 */
export function settle(boxes: Box[], gap = GROUP_GAP): Map<string, Pos> {
  const placed: Box[] = [];
  const out = new Map<string, Pos>();
  const free = (b: Box) => !placed.some((p) => overlaps(b, p, gap - 0.5));
  for (const b of boxes) {
    let best: Pos = { x: b.x, y: b.y };
    if (!free(b)) {
      const xs = [b.x, ...placed.flatMap((p) => [p.x + p.w + gap, p.x - b.w - gap])];
      const ys = [b.y, ...placed.flatMap((p) => [p.y + p.h + gap, p.y - b.h - gap])];
      let bd = Infinity;
      for (const x of xs) for (const y of ys) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d < bd && free({ ...b, x, y })) { bd = d; best = { x, y }; }
      }
      // Always room below everything.
      if (bd === Infinity) best = { x: b.x, y: Math.max(...placed.map((p) => p.y + p.h)) + gap };
    }
    placed.push({ ...b, ...best });
    out.set(b.id, best);
  }
  return out;
}

/**
 * The arrangement to store when `id` is dropped at `at` (world units): every movable group where it sits
 * now, the dropped one last so it yields to the others when it lands on one of them.
 */
export function arrangementAfterDrop(regions: { id: string; x: number; y: number; movable: boolean }[], id: string, at: Pos, sp: Pos): Map<string, Pos> {
  const next = new Map<string, Pos>();
  for (const r of regions) if (r.movable && r.id !== id) next.set(r.id, toStored(r, sp));
  next.set(id, toStored(at, sp));
  return next;
}
