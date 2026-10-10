import type { View } from "./prefs";

type Bounds = { x: number; y: number; w: number; h: number };

/** Screen-space overscan keeps cards ready before they enter during a pan or pinch. */
export function onCamera(bounds: Bounds, view: View, viewport: { w: number; h: number }, overscan = 256): boolean {
  const x = bounds.x * view.s + view.tx, y = bounds.y * view.s + view.ty;
  return x <= viewport.w + overscan && y <= viewport.h + overscan
    && x + bounds.w * view.s >= -overscan && y + bounds.h * view.s >= -overscan;
}
