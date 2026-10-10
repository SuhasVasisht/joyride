// Chart layout in world units (1 unit = 1px at "near" scale 1.0). Labels keep
// a constant screen size; only positions scale, so zooming in opens room for
// detail (semantic zoom) instead of magnifying text.
import { repoLabel } from "../../lib/api";
import type { Lens, WorkerView } from "../../lib/types";
import { lensMatch, primaryLens } from "../../../shared/lens-match";
import { rankOf, type FirstmateNode, type MapMission, type MapWorker, type Spec, type UnfiledSession } from "./world";
import type { Held, UnfiledGroup } from "./place";
import type { ServerGroupView } from "../../../shared/servers";
import { settle, spread, toWorld, type Pos, type Positions } from "./arrange";

export type ZoomLevel = "far" | "mid" | "near";
export const MIN_S = 0.24, MAX_S = 1.6;
export const PRESETS: Record<ZoomLevel, number> = { far: 0.42, mid: 0.7, near: 1 };
export const levelOf = (s: number): ZoomLevel => (s < 0.56 ? "far" : s < 0.88 ? "mid" : "near");

export type Item =
  | { kind: "server"; id: string; x: number; y: number; w: number; h: number; server: ServerGroupView }
  | { kind: "mission"; id: string; x: number; y: number; w: number; h: number; m: MapMission }
  | { kind: "worker"; id: string; x: number; y: number; w: number; h: number; wk: WorkerView }
  | { kind: "sessions"; id: string; x: number; y: number; w: number; h: number; sessions: UnfiledSession[] }
  | { kind: "quiet"; id: string; x: number; y: number; w: number; h: number; workers: WorkerView[] }
  | { kind: "firstmate"; id: string; x: number; y: number; w: number; h: number; fm: FirstmateNode }
  /** Firstmate's open tasks no idea names yet, beside the hub until housekeeping files them. */
  | { kind: "orphans"; id: string; x: number; y: number; w: number; h: number; fm: FirstmateNode }
  /** An empty group's drop spot, so a new group is something to drag onto. */
  | { kind: "empty"; id: string; x: number; y: number; w: number; h: number };

export type RegionIn = {
  id: string; title: string; kind: "spec" | "lens" | "repo" | "health" | "all" | "unfiled" | "firstmate" | "server"; path?: string;
  /** The lens a mission dropped here joins (lens regions, and spec regions drawn from a lens). */
  lens?: string;
  missions: MapMission[]; workers: WorkerView[]; sessions: UnfiledSession[];
  /** Only on the Firstmate region: its single node. */
  firstmate?: FirstmateNode;
  server?: ServerGroupView;
  /** Idle workers that have been quiet for hours: folded into one list so live ones stand out. */
  quiet?: WorkerView[];
  /** Unfiled regions: pending mission proposals for the project. */
  proposals?: number;
  /** Unfiled regions: the project key (renaming the region names a group that holds the project's unfiled work). */
  project?: string;
};
export type RegionOut = RegionIn & { x: number; y: number; w: number; h: number; items: Item[]; contour: string; outer: string; labelX: number; labelY: number; labelW: number };

// Cells are sized per level: text keeps a constant screen size, so a cell needs
// (screen px / typical scale) world units. Far and mid stay compact; near makes
// room for each worker's action line and last message.
const REF_S: Record<ZoomLevel, number> = { far: 0.42, mid: 0.7, near: 1 };
const MISSION_W: Record<ZoomLevel, number> = { far: 400, mid: 360, near: 400 };
const WORKER_W: Record<ZoomLevel, number> = { far: 360, mid: 320, near: 290 };
const GAP_X = 52, GAP_Y = 36, PAD_X = 56, PAD_BOTTOM = 52, REGION_GAP = 120;
const PAD_TOP: Record<ZoomLevel, number> = { far: 104, mid: 104, near: 112 };
export const MAX_WORKERS_SHOWN = 4;
// Wide enough at each level for a place-name to fit beside its neighbours.
const MIN_REGION_W: Record<ZoomLevel, number> = { far: 560, mid: 470, near: 440 };
// The Firstmate node is a framed card, wider than a mission so it reads at Far; its region has no place-name.
const FIRSTMATE_W: Record<ZoomLevel, number> = { far: 600, mid: 580, near: 480 };
const FIRSTMATE_PAD_TOP = 48;

const HEALTH_ORDER: Record<string, number> = { blocked: 0, "needs-review": 1, active: 2, idle: 3 };
const urgency = (m: MapMission) => Math.max(0, ...m.attention.map((a) => rankOf(a.level)));

// First-frame estimates only: every node's rendered height is measured and replaces these.
const tasksMidH = (m: MapMission) => (m.tasks?.length ? 8 + m.tasks.reduce((a, t) => a + 30 + t.asks.length * 26, 0) : 0) + (m.landed?.length ? 24 : 0) + (m.asks?.length ?? 0) * 26;
const tasksNearH = (m: MapMission) => (m.tasks ?? []).reduce((a, t) => a + 76 + t.asks.length * 26, 0) + (m.landed?.length ? 26 : 0) + (m.asks?.length ?? 0) * 26;
function missionH(m: MapMission, level: ZoomLevel) {
  if (level === "far") return 52 / REF_S.far;
  const chips = m.artifacts?.length ? 28 : 0;
  if (level === "mid") return (58 + (m.done_when.length ? 24 : 0) + (m.workers.length ? 24 : 0) + chips + tasksMidH(m)) / REF_S.mid;
  const shown = Math.min(m.workers.length, MAX_WORKERS_SHOWN);
  // A worker line's title is its goal when Joyride knows it, which may take two lines; its owner and helm chips take one.
  return 122 + (m.done_when.length ? 26 : 0) + chips + tasksNearH(m) + (shown ? shown * 126 : m.tasks?.length ? 0 : 30) + (m.workers.length > shown ? 22 : 0);
}
// Mid and near give the owner and helm chips a row of their own.
const workerH = (w: MapWorker, level: ZoomLevel) => {
  const chips = w.artifacts?.length && level !== "far" ? 28 : 0;
  return level === "near" ? 112 + (w.last_message ? 40 : 0) + chips : level === "mid" ? (92 + chips) / REF_S.mid : 30 / REF_S.far;
};
// The bridge row (fleet counts) shows at every level; the ticker line while Firstmate runs.
function firstmateH(f: FirstmateNode, level: ZoomLevel) {
  const off = f.status ? !f.status.running : false;
  const primary = f.status?.primary;
  const primaryHeight = primary?.current ? (level === "near" ? 70 + (primary.lastSwitch ? 50 : 0) + (primary.returnToClaude ? 40 : 0) + (primary.error ? 60 : 0) : 24) : 0;
  if (level === "far") return (78 + 26 + primaryHeight + (off ? 38 : 0)) / REF_S.far;
  return (92 + 30 + primaryHeight + (f.status?.running ? 26 : 0) + (off ? 64 : 0)) / REF_S[level];
}
const sessionsH = (n: number, level: ZoomLevel) => (level === "far" ? 46 / REF_S.far : (34 + Math.min(n, 8) * 24 + (n > 8 ? 22 : 0)) / REF_S[level]);

/**
 * Group missions into regions: spec regions, then lenses, then repo (or health / none per spec). Work
 * outside any mission follows as one "unfiled" region per project (groupUnfiled), crew or not.
 */
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** The group whose title or id is the same name as a repo label, ignoring case and punctuation. */
export function lensNamedLike<L extends { id: string; title: string }>(label: string | null | undefined, lenses: L[]): L | undefined {
  const k = label ? nameKey(label) : "";
  return k ? lenses.find((l) => nameKey(l.title) === k || nameKey(l.id) === k) : undefined;
}

/** The group an idea sits in on the map: a spec region, else its lens, else its repo (or health / none per spec). */
export type IdeaGroup = { id: string; title: string; kind: "spec" | "lens" | "repo" | "health" | "all"; lens?: string; path?: string };
export function groupOfIdea(m: Pick<MapMission, "id" | "title" | "goal" | "repos" | "lenses" | "health">, lenses: Lens[], spec: Spec | null): IdeaGroup {
  const groupBy = spec?.home?.group_by ?? "lens";
  const sr = (spec?.home?.regions ?? []).find((r) => (r.lens && lenses.some((l) => l.id === r.lens && lensMatch(l, m))) || (r.repo && m.repos.some((x) => x === r.repo || repoLabel(x) === r.repo)));
  if (sr) return { id: `spec:${sr.id}`, title: sr.title, kind: "spec", lens: sr.lens };
  if (groupBy === "none") return { id: "all", title: "Ideas", kind: "all" };
  if (groupBy === "health") return { id: `health:${m.health}`, title: { blocked: "Blocked", "needs-review": "Needs review", active: "Under way", idle: "Becalmed" }[m.health] ?? m.health, kind: "health" };
  const repo = m.repos[0] ?? "";
  if (groupBy === "lens") {
    // An idea no group claims falls back to its repo, unless a group already bears that repo's name:
    // then it joins the group, so the chart never shows "Joyride" and "joyride" side by side.
    const l = primaryLens(m, lenses) ?? lensNamedLike(repo ? repoLabel(repo) : null, lenses);
    if (l) return { id: `lens:${l.id}`, title: l.title, kind: "lens", lens: l.id };
  }
  return { id: `repo:${repo || "none"}`, title: repo ? repoLabel(repo)! : "No repo", kind: "repo", path: repo || undefined };
}

export function buildRegions(missions: MapMission[], lenses: Lens[], spec: Spec | null, unfiled: UnfiledGroup<WorkerView, UnfiledSession>[], firstmate?: FirstmateNode, held?: Map<string, Held<WorkerView, UnfiledSession>>): RegionIn[] {
  const groupBy = spec?.home?.group_by ?? "lens";
  const out = new Map<string, RegionIn>();
  for (const m of missions) {
    const g = groupOfIdea(m, lenses, spec);
    if (!out.has(g.id)) out.set(g.id, { ...g, missions: [], workers: [], sessions: [] });
    out.get(g.id)!.missions.push(m);
  }
  if (groupBy === "lens") {
    // Every group is charted, even an empty one (a drop spot), with what it holds outside its ideas.
    for (const l of lenses) {
      const sr = (spec?.home?.regions ?? []).find((r) => r.lens === l.id);
      const key = sr ? `spec:${sr.id}` : `lens:${l.id}`;
      if (!out.has(key)) out.set(key, sr ? { id: key, title: sr.title, kind: "spec", lens: l.id, missions: [], workers: [], sessions: [] } : { id: key, title: l.title, kind: "lens", lens: l.id, missions: [], workers: [], sessions: [] });
      const h = held?.get(l.id);
      if (h) { const r = out.get(key)!; r.workers.push(...h.workers); r.sessions.push(...h.sessions); }
    }
  }
  const regions = [...out.values()];
  for (const r of regions) r.missions.sort((a, b) => (HEALTH_ORDER[a.health] ?? 9) - (HEALTH_ORDER[b.health] ?? 9) || urgency(b) - urgency(a) || Number(a.archive) - Number(b.archive) || b.updated.localeCompare(a.updated));
  // Regions with something urgent first, then live ones, then the rest; archive-only regions last.
  const score = (r: RegionIn) => (r.missions.some((m) => m.health === "blocked") || r.workers.some((w) => w.status === "blocked") ? 0
    : r.missions.some((m) => m.health !== "idle") || r.workers.some((w) => w.status === "working") ? 1
    : !r.missions.length && !r.workers.length && !r.sessions.length ? 4 : r.missions.length && r.missions.every((m) => m.archive) ? 3 : 2);
  regions.sort((a, b) => score(a) - score(b) || b.missions.length - a.missions.length || a.title.localeCompare(b.title));
  for (const g of unfiled) {
    if (!g.workers.length && !g.sessions.length && !g.quiet.length) continue;
    regions.push({ id: `unfiled:${g.key || "none"}`, title: g.title, kind: "unfiled", path: g.path ?? undefined, project: g.key, missions: [], workers: g.workers, sessions: g.sessions, quiet: g.quiet, proposals: g.proposals });
  }
  // Firstmate is always charted, first, so the control plane sits top-left at every zoom.
  if (firstmate) regions.unshift({ id: "firstmate", title: "Firstmate", kind: "firstmate", missions: [], workers: [], sessions: [], firstmate });
  return regions;
}

// ---------- layout ----------
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

type P = [number, number];
function hull(pts: P[]): P[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P, a: P, b: P) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P[] = [], upper: P[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** A coastline-like contour around the region's items: convex hull, densified, nudged outward by seeded noise, smoothed. */
function contour(rects: { x: number; y: number; w: number; h: number }[], seed: string, pad: number, extra: number): string {
  const pts: P[] = [];
  for (const r of rects) pts.push([r.x - pad, r.y - pad], [r.x + r.w + pad, r.y - pad], [r.x + r.w + pad, r.y + r.h + pad], [r.x - pad, r.y + r.h + pad]);
  const h = hull(pts);
  if (h.length < 3) return "";
  const cx = h.reduce((a, p) => a + p[0], 0) / h.length, cy = h.reduce((a, p) => a + p[1], 0) / h.length;
  const rand = rng(hash(seed));
  const dense: P[] = [];
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / 150));
    for (let k = 0; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const pushed = dense.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
    const amt = extra + rand() * 18;
    return [x + (dx / d) * amt, y + (dy / d) * amt] as P;
  });
  const n = pushed.length;
  let d = `M${pushed[0][0].toFixed(1)},${pushed[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pushed[(i - 1 + n) % n], p1 = pushed[i], p2 = pushed[(i + 1) % n], p3 = pushed[(i + 2) % n];
    const c1: P = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: P = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + "Z";
}

export type ScreenSizes = ReadonlyMap<string, number>;

function layoutRegion(r: RegionIn, level: ZoomLevel, scale: number, sizes: ScreenSizes, idea?: string | null, viewport?: { w: number; h: number }, columns?: number) {
  const far = level === "far";
  const cells: Item[] = [
    ...r.missions.map((m): Item => ({ kind: "mission", id: m.id, x: 0, y: 0, w: MISSION_W[level], h: missionH(m, level), m })),
    ...r.workers.map((wk): Item => ({ kind: "worker", id: wk.id, x: 0, y: 0, w: WORKER_W[level], h: workerH(wk, level), wk })),
  ];
  if (r.server) cells.push({ kind: "server", id: r.id, x: 0, y: 0, w: 440 / REF_S[level], h: (180 + r.server.members.length * 100) / REF_S[level], server: r.server });
  if (r.sessions.length) cells.push({ kind: "sessions", id: `${r.id}:sessions`, x: 0, y: 0, w: WORKER_W[level], h: sessionsH(r.sessions.length, level), sessions: r.sessions });
  if (r.quiet?.length) cells.push({ kind: "quiet", id: `${r.id}:quiet`, x: 0, y: 0, w: WORKER_W[level], h: sessionsH(r.quiet.length, level), workers: r.quiet });
  if (r.firstmate) cells.push({ kind: "firstmate", id: "firstmate", x: 0, y: 0, w: FIRSTMATE_W[level], h: firstmateH(r.firstmate, level), fm: r.firstmate });
  if (!cells.length && r.kind !== "firstmate") cells.push({ kind: "empty", id: `${r.id}:empty`, x: 0, y: 0, w: MISSION_W[level], h: (level === "far" ? 52 : 72) / REF_S[level] });
  if (r.firstmate?.orphans?.length) cells.push({ kind: "orphans", id: "firstmate:orphans", x: 0, y: 0, w: MISSION_W[level], h: (level === "far" ? 52 : 60 + r.firstmate.orphans.length * (level === "near" ? 140 : 32)) / REF_S[level], fm: r.firstmate });
  const padX = Math.max(PAD_X, (far ? 16 : 24) / scale), gapX = Math.max(GAP_X, 16 / scale), gapY = Math.max(GAP_Y, 12 / scale);
  const labelH = sizes.get(`region:${r.id}`) ?? (level === "far" ? 46 : 70);
  const padTop = r.kind === "firstmate" ? Math.max(FIRSTMATE_PAD_TOP, 18 / scale) : Math.max(PAD_TOP[level], (labelH + 18) / scale);
  for (const c of cells) {
    // An idea with task cards needs room for a task row (mid) or an ask's options (near).
    const tasks = c.kind === "mission" ? (c.m.tasks?.length ?? 0) + (c.m.asks?.length ?? 0) : c.kind === "orphans" ? 1 : 0;
    const minScreen = c.kind === "firstmate" ? 320 : c.kind === "mission" || c.kind === "orphans" ? (far ? 220 : tasks ? (level === "near" ? 360 : 300) : 240) : (far ? 240 : 270);
    c.w = Math.max(c.w, minScreen / scale);
    // Text does not scale. Reserve its rendered height, including wrapped chips,
    // before placing neighbours and drawing the contour.
    // The focused idea shows everything, so it keeps its own measured height.
    const full = c.kind === "mission" && c.id === idea;
    if (full && viewport) c.w = Math.max(360, Math.min(880, viewport.w - 128)) / scale;
    c.h = ((full ? sizes.get(`${c.id}#full`) : undefined) ?? sizes.get(c.id) ?? c.h * REF_S[level] * (full ? 1.8 : 1)) / scale;
  }
  const n = cells.length;
  const cols = columns ?? (far && r.kind === "unfiled" ? 1 : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 20 ? 4 : 5);
  const colW = Math.max(...cells.map((c) => c.w));
  const heights = new Array(cols).fill(0);
  const items: Item[] = [];
  for (const c of cells) {
    const col = heights.indexOf(Math.min(...heights));
    const x = padX + col * (colW + gapX);
    const y = padTop + heights[col];
    heights[col] += c.h + gapY;
    items.push({ ...c, x, y });
  }
  const usedCols = Math.min(cols, n);
  const w = padX * 2 + usedCols * colW + (usedCols - 1) * gapX;
  const h = padTop + Math.max(0, ...heights) - (n ? gapY : 0) + Math.max(PAD_BOTTOM, (far ? 16 : 24) / scale);
  return { ...r, w: r.kind === "firstmate" ? w : Math.max(w, MIN_REGION_W[level]), h, items, padX, padTop, labelH };
}

export type Layout = { level: ZoomLevel; regions: RegionOut[]; bounds: { x: number; y: number; w: number; h: number }; items: Map<string, Item> };
export type LayoutOpts = {
  /** Where the captain placed groups, in near units (arrange.ts). Groups without one keep their flowed spot. */
  positions?: Positions;
  /** The focused group: laid out with Near detail, in place; its neighbours move aside. */
  focus?: string | null;
  /** Measured heights at Near, for the focused group. */
  focusSizes?: ScreenSizes;
  /** The focused idea, shown in full. */
  idea?: string | null;
  /** Available reading canvas; a tall focus reflows into the columns that fit it. */
  focusViewport?: { w: number; h: number };
};

export function layoutRegions(regions: RegionIn[], level: ZoomLevel, scale = PRESETS[level], sizes: ScreenSizes = new Map(), maxWidth?: number, opts: LayoutOpts = {}): Layout {
  const sized = regions.map((r) => layoutRegion(r, level, scale, sizes, opts.idea));
  const area = sized.reduce((a, r) => a + r.w * r.h, 0);
  const maxW = maxWidth ?? Math.max(1500, Math.sqrt(area) * 1.7);
  const gap = level === "far" ? 24 / scale : Math.max(REGION_GAP, 40 / scale);
  // Flow first: the order regions read in when nobody has placed them.
  const at = new Map<string, Pos>();
  let x = 0, y = 0, rowH = 0;
  for (const r of sized) {
    if (x > 0 && x + r.w > maxW) { x = 0; y += rowH + gap; rowH = 0; }
    at.set(r.id, { x, y });
    x += r.w + gap;
    rowH = Math.max(rowH, r.h);
  }
  // A focused group opens up in place, at Near detail.
  const focusAt = opts.focus ? sized.findIndex((r) => r.id === opts.focus) : -1;
  if (focusAt >= 0) {
    const region = regions[focusAt], measured = opts.focusSizes ?? sizes, vp = opts.focusViewport;
    let reading = layoutRegion(region, "near", scale, measured, opts.idea, vp);
    if (vp && !opts.idea) {
      // Keep the narrowest arrangement that fits; when none fits, minimise the height at readable card widths.
      for (let cols = 1; cols <= reading.items.length; cols++) {
        const candidate = layoutRegion(region, "near", scale, measured, null, vp, cols);
        if (candidate.w * scale > vp.w - 64) break;
        reading = candidate;
        if (candidate.h * scale <= vp.h - 64) break;
      }
    }
    sized[focusAt] = reading;
  }
  const placed = opts.positions?.size ? opts.positions : null;
  if (placed || focusAt >= 0) {
    // Firstmate stays put, then the focused group, then placed groups (in the order they were placed), then the rest.
    const sp = spread(level, scale);
    const rank = (r: (typeof sized)[number]) => (r.kind === "firstmate" ? 0 : r.id === opts.focus ? 1 : placed?.has(r.id) ? 2 : 3);
    const order = [...placed?.keys() ?? []];
    const boxes = [...sized].sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? order.indexOf(a.id) - order.indexOf(b.id) : 0)).map((r) => {
      const p = r.kind !== "firstmate" && placed?.get(r.id);
      return { id: r.id, ...(p ? toWorld(p, sp) : at.get(r.id)!), w: r.w, h: r.h };
    });
    for (const [id, p] of settle(boxes, gap)) at.set(id, p);
  }
  const out: RegionOut[] = [];
  for (const r of sized) {
    const { x, y } = at.get(r.id)!;
    const items = r.items.map((it) => ({ ...it, x: it.x + x, y: it.y + y }));
    const labelY = y + r.padTop - 12 / scale;
    const label = { x: x + r.padX - 8 / scale, y: labelY - r.labelH / scale, w: r.w - r.padX * 2, h: r.labelH / scale };
    const rects = r.kind === "firstmate" ? items : [...items, label];
    out.push({ ...r, x, y, items, contour: contour(rects, r.id, 12 / scale, 0), outer: contour(rects, r.id + "~", 12 / scale, 12), labelX: label.x, labelY, labelW: label.w });
  }
  const minX = Math.min(0, ...out.map((r) => r.x)), minY = Math.min(0, ...out.map((r) => r.y));
  const maxX = Math.max(1, ...out.map((r) => r.x + r.w)), maxY = Math.max(1, ...out.map((r) => r.y + r.h));
  const all = new Map<string, Item>();
  for (const r of out) for (const it of r.items) all.set(it.id, it);
  return { level, regions: out, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, items: all };
}
