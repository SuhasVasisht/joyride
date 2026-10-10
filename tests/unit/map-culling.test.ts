import { expect, test } from "vitest";
import { onCamera } from "../../src/ui/views/map/culling";

const viewport = { w: 1000, h: 700 };
const view = { s: 1, tx: 0, ty: 0 };
test("keeps intersecting cards and the overscan, hides fully outside cards", () => {
  expect(onCamera({ x: -200, y: -40, w: 250, h: 100 }, view, viewport)).toBe(true);
  expect(onCamera({ x: 1200, y: 0, w: 100, h: 100 }, view, viewport)).toBe(true);
  expect(onCamera({ x: 1257, y: 0, w: 100, h: 100 }, view, viewport)).toBe(false);
  expect(onCamera({ x: 0, y: -400, w: 100, h: 100 }, view, viewport)).toBe(false);
});
test("applies camera scale and translation before comparing bounds", () => {
  const box = { x: 2000, y: 2000, w: 200, h: 200 };
  expect(onCamera(box, view, viewport)).toBe(false);
  expect(onCamera(box, { s: 0.3, tx: 0, ty: 0 }, viewport)).toBe(true);
  expect(onCamera(box, { s: 2, tx: -4000, ty: -4000 }, viewport)).toBe(true);
});
test("retains a tall note card crossing the viewport even if its top is offscreen", () => {
  expect(onCamera({ x: 50, y: -1800, w: 400, h: 2000 }, view, viewport, 0)).toBe(true);
  expect(onCamera({ x: 50, y: -2100, w: 400, h: 2000 }, view, viewport, 0)).toBe(false);
});
