// Focus on the map: a group (and an idea in it) opened in place on the same canvas, carried in the URL
// (#/map?focus=<group>&idea=<idea>) so back and forward step in and out. The camera flies between views.
import type { Route } from "../../lib/router";
import type { View } from "./prefs";

export type Focus = { group: string | null; idea: string | null };
export const NO_FOCUS: Focus = { group: null, idea: null };

export function focusOf(route: Pick<Route, "name" | "query">): Focus {
  if (route.name !== "map") return NO_FOCUS;
  const group = route.query.get("focus") || null;
  return { group, idea: group ? route.query.get("idea") || null : null };
}
/** The map route for a focus (the plain map for none). */
export function focusPath(f: Focus): string {
  if (!f.group) return "map";
  const q = new URLSearchParams({ focus: f.group });
  if (f.idea) q.set("idea", f.idea);
  return `map?${q.toString()}`;
}
export const focusKey = (f: Focus) => (f.group ? `${f.group}${f.idea ? `\n${f.idea}` : ""}` : "");
/** True when `to` is `from` with a level or two stepped out (idea to group, group to the map). */
export const isOutward = (from: Focus, to: Focus) => focusKey(from) !== focusKey(to) && focusKey(from).startsWith(focusKey(to));

/** A CSS string literal for an attribute selector value. */
export const cssString = (s: string) => `"${s.replace(/["\\]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

type Rect = { x: number; y: number; w: number; h: number };
/** The largest scale in [lo, hi] at which `fits` holds, else lo. `fits` must hold for every scale below one it holds at. */
export function largestFit(fits: (s: number) => boolean, lo: number, hi: number): number {
  if (fits(hi)) return hi;
  if (!fits(lo)) return lo;
  let a = lo, z = hi;
  for (let i = 0; i < 18 && z - a > 0.0005; i++) { const m = (a + z) / 2; if (fits(m)) a = m; else z = m; }
  return a;
}
/** The view that shows `r` at scale `s`: centred across, its top at `top` (centred down when it fits). */
export function frame(r: Rect, s: number, vp: { w: number; h: number }, pad: { top: number; bottom: number }): View {
  const room = vp.h - pad.top - pad.bottom;
  return { s, tx: vp.w / 2 - (r.x + r.w / 2) * s, ty: pad.top + Math.max(0, (room - r.h * s) / 2) - r.y * s };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
type Frames = { frame: (fn: (now: number) => void) => number; cancel: (id: number) => void; now: () => number };
const browser: Frames = { frame: (fn) => requestAnimationFrame(fn), cancel: (id) => cancelAnimationFrame(id), now: () => performance.now() };

/**
 * Fly the camera from one view to another: scale in log space, and the world point at the middle of the
 * viewport in a straight line, so the move reads as one glide. `to` is read every frame, so a target that
 * settles while the camera moves (a card measured, a neighbour moved aside) is still where it lands.
 */
export function fly(from: View, to: () => View, vp: { w: number; h: number }, ms: number, onFrame: (v: View) => boolean | void, onDone: () => void, f: Frames = browser) {
  const t0 = f.now();
  const cx = (v: View) => (vp.w / 2 - v.tx) / v.s, cy = (v: View) => (vp.h / 2 - v.ty) / v.s;
  let id: number | null = null;
  const step = () => {
    const k = ms <= 0 ? 1 : Math.min(1, (f.now() - t0) / ms);
    const e = ease(k), b = to();
    const s = Math.exp(Math.log(from.s) + (Math.log(b.s) - Math.log(from.s)) * e);
    const x = cx(from) + (cx(b) - cx(from)) * e, y = cy(from) + (cy(b) - cy(from)) * e;
    // onFrame says false when someone else moved the camera: the flight gives way.
    if (onFrame(k >= 1 ? b : { s, tx: vp.w / 2 - x * s, ty: vp.h / 2 - y * s }) === false) { id = null; return; }
    if (k >= 1) { id = null; onDone(); return; }
    id = f.frame(step);
  };
  step();
  return { cancel: () => { if (id !== null) f.cancel(id); id = null; } };
}
