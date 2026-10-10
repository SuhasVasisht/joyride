import { expect, type Locator } from "@playwright/test";

/** Pan the chart itself, rather than scrolling the page around its transformed nodes. */
export async function panTo(target: Locator) {
  const viewport = target.page().locator(".map-viewport");
  await expect(async () => {
    const [node, frame] = await Promise.all([target.boundingBox(), viewport.boundingBox()]);
    if (!node || !frame) throw new Error("The chart target is not rendered yet.");
    const dx = node.x + node.width / 2 - (frame.x + frame.width / 2);
    const dy = node.y + node.height / 2 - (frame.y + frame.height / 2);
    await viewport.evaluate((el, delta) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent("wheel", { deltaX: delta.dx, deltaY: delta.dy, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    }, { dx, dy });
    // Fully on screen, give or take IntersectionObserver's float noise after a fractional pan.
    await expect(target).toBeInViewport({ ratio: 0.999 });
  }).toPass({ timeout: 10000 });
}
