import { test, expect, type Page } from "@playwright/test";
import { seedDenseMap } from "./map-dense";
import { shot } from "./shot";

/** Map elements outside the visible canvas, or under the overlays along its bottom edge. */
async function outsideCanvas(page: Page) {
  return page.locator(".map-viewport").evaluate((vp) => {
    const b = vp.getBoundingClientRect();
    const floor = Math.min(b.bottom, ...[...vp.querySelectorAll(".zoom-controls, .next-ask, .map-legend")].map((o) => o.getBoundingClientRect()).filter((r) => r.height).map((r) => r.top));
    return [...vp.querySelectorAll(".map-plane > .map-node")].filter((node) => {
      const r = node.getBoundingClientRect();
      return r.left < b.left || r.top < b.top || r.right > b.right || r.bottom > floor;
    }).map((node) => (node.getAttribute("data-map-item") ?? node.getAttribute("data-region") ?? node.className) as string);
  });
}

async function geometryProblems(page: Page) {
  return page.locator(".map-viewport").evaluate((vp) => {
    const problems: string[] = [];
    const box = (el: Element) => el.getBoundingClientRect();
    const name = (el: Element) => el.getAttribute("data-mission") ?? el.getAttribute("data-worker") ?? el.className;
    const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const nodes = [...vp.querySelectorAll(".map-node")];
    for (let i = 0; i < nodes.length; i++) for (const b of nodes.slice(i + 1)) {
      if (overlap(box(nodes[i]), box(b))) problems.push(`nodes overlap: ${name(nodes[i])} / ${name(b)}`);
    }
    const contours = [...vp.querySelectorAll(".contour:not(.k-firstmate) .c-inner")];
    for (let i = 0; i < contours.length; i++) for (const b of contours.slice(i + 1)) {
      if (overlap(box(contours[i]), box(b))) problems.push("cluster contours overlap");
    }
    for (const node of nodes) {
      const parts = [...node.querySelectorAll(".mn-title, .wn-title, .wl-title, .sn-name, .art-chip, .fleet-chip, .wl-status, .mn-count")];
      for (let i = 0; i < parts.length; i++) for (const b of parts.slice(i + 1)) {
        if (!parts[i].contains(b) && !b.contains(parts[i]) && overlap(box(parts[i]), box(b))) problems.push(`content overlaps in ${name(node)}`);
      }
      for (const label of node.querySelectorAll(".mn-title, .wn-title, .wl-title, .sn-name, .rl-title, .fm-title, .ac-title")) {
        const r = box(label);
        if (!r.width || !r.height) continue;
        const text = label.textContent ?? "";
        const font = getComputedStyle(label);
        const canvas = document.createElement("canvas").getContext("2d");
        if (!canvas) throw new Error("Cannot measure label text");
        canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        if (r.width < canvas.measureText(text.slice(0, Math.min(12, text.length))).width) problems.push(`label too narrow: ${text}`);
      }
    }
    return problems;
  });
}

test("zoom bursts preserve the pointer anchor and defer detail until settled", async ({ page }) => {
  await seedDenseMap(page);
  await page.locator('[data-mission="zoom-0"] .mn-title').focus();
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  const vp = page.locator(".map-viewport");
  await expect(vp).toHaveAttribute("data-zoom", "near");
  const during = await vp.evaluate(async (vp) => {
    const node = vp.querySelector('[data-mission="zoom-0"]');
    const layer = vp.querySelector<HTMLElement>(".map-layer");
    if (!node || !layer) throw new Error("Missing chart layers");
    const before = node.getBoundingClientRect();
    const x = before.left + 100, y = before.top + 20;
    let hulls = 0, cards = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element && record.target.matches(".contour path")) hulls++;
        if (record.target instanceof Element && record.target.matches(".map-node")) cards++;
      }
    });
    observer.observe(vp, { subtree: true, attributes: true, attributeFilter: ["d", "style"] });
    for (let i = 0; i < 4; i++) vp.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, clientX: x, clientY: y, deltaY: 8 }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const after = node.getBoundingClientRect();
    observer.disconnect();
    const k = Math.exp(-0.32);
    return { hulls, cards, level: vp.getAttribute("data-zoom"), s: vp.getAttribute("data-scale"),
      dx: after.left - (x + (before.left - x) * k), dy: after.top - (y + (before.top - y) * k),
      width: after.width / before.width, left: after.left, top: after.top, k };
  });
  expect(during.level).toBe("near");
  expect(Number(during.s)).toBeCloseTo(Math.exp(-0.32), 3);
  expect(during.hulls).toBe(0);
  expect(during.cards).toBe(0);
  expect(Math.abs(during.dx)).toBeLessThan(1);
  expect(Math.abs(during.dy)).toBeLessThan(1);
  expect(during.width).toBeCloseTo(during.k, 3);
  await expect(vp).toHaveAttribute("data-zoom", "mid");
  await expect.poll(() => geometryProblems(page)).toEqual([]);
  const settled = await page.locator('[data-mission="zoom-0"]').boundingBox();
  expect(settled).not.toBeNull();
  expect(Math.abs(settled!.x - during.left)).toBeLessThan(5);
  expect(Math.abs(settled!.y - during.top)).toBeLessThan(5);
  await shot(page, "C12", "map-zoom-settled-mid");

  // A two-pointer pinch uses the same coalesced zoom path.
  await vp.evaluate(async (vp) => {
    const r = vp.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height - 130;
    const pointer = (type: string, id: number, px: number) => vp.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: id, pointerType: "touch", button: 0, clientX: px, clientY: y,
    }));
    pointer("pointerdown", 101, x - 40); pointer("pointerdown", 102, x + 40);
    pointer("pointermove", 101, x - 80); pointer("pointermove", 102, x + 80);
    pointer("pointerup", 101, x - 80); pointer("pointerup", 102, x + 80);
  });
  await expect(vp).toHaveAttribute("data-zoom", "near");
  expect(Number(await vp.getAttribute("data-scale"))).toBeCloseTo(Math.exp(-0.32) * 2, 2);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect.poll(() => outsideCanvas(page)).toEqual([]);
});

for (const size of [{ width: 1440, height: 900 }, { width: 2000, height: 1064 }]) {
  test(`dense map stays readable across zooms at ${size.width}x${size.height}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(size);
    await seedDenseMap(page);
    for (const zoom of ["Far", "Mid", "Near", "Fit"]) {
      if (zoom === "Near") await page.locator('[data-mission="zoom-0"] .mn-title').focus();
      if (zoom === "Fit") await page.getByRole("button", { name: "Fit", exact: true }).click();
      else await page.getByRole("radio", { name: zoom, exact: true }).click();
      await expect(page.locator(".map-viewport")).toHaveAttribute("data-zoom", /far|mid|near/);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator("[data-semantic-pending]")).toHaveCount(0);
      await expect.poll(() => geometryProblems(page), { message: `${zoom} geometry settles without overlaps` }).toEqual([]);
      await shot(page, "C2", `map-zoom-after-${size.width}-${zoom.toLowerCase()}`);
      if (zoom === "Fit") {
        const clipped = await page.locator(".map-viewport").evaluate((vp) => {
          const bounds = vp.getBoundingClientRect();
          return [...vp.querySelectorAll(".map-node")].filter((node) => {
            const r = node.getBoundingClientRect();
            return r.left < bounds.left + 6 || r.top < bounds.top + 6 || r.right > bounds.right - 6 || r.bottom > bounds.bottom - 6;
          }).map((node) => node.textContent);
        });
        expect(clipped, "Fit contains every map node").toEqual([]);
      }
    }
    await page.locator(".map-viewport").focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press("-");
    await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "0.240");
    await expect.poll(() => geometryProblems(page)).toEqual([]);
    await shot(page, "C2", `map-zoom-after-${size.width}-minimum`);
    for (let i = 0; i < 18; i++) {
      await page.keyboard.press("+");
      await expect.poll(() => geometryProblems(page)).toEqual([]);
    }
    await expect(page.locator(".map-viewport")).toHaveAttribute("data-scale", "1.600");
    await shot(page, "C2", `map-zoom-after-${size.width}-maximum`);
    expect(pageErrors).toEqual([]);
  });
}

for (const size of [{ width: 1440, height: 900 }, { width: 2000, height: 1064 }]) {
  test(`a chart taller than the window still fits, and zoom out reaches Fit, at ${size.width}x${size.height}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(size);
    await seedDenseMap(page, true);
    const vp = page.locator(".map-viewport");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    // Fit frames every cluster, down to the bottom-most unfiled groups, clear of the bottom overlays.
    await expect.poll(() => outsideCanvas(page)).toEqual([]);
    // Below the old floor the chart shrinks as a whole, so the label-width check (unscaled text) does not apply; overlaps do.
    const overlaps = async () => (await geometryProblems(page)).filter((p) => !p.startsWith("label too narrow"));
    await expect.poll(overlaps).toEqual([]);
    const fitScale = Number(await vp.getAttribute("data-scale"));
    expect(fitScale).toBeLessThan(0.24);
    await shot(page, "C12", `map-fit-tall-${size.width}`);

    // Zoom in, then all the way out: zoom out reaches at least the Fit level.
    await vp.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("+");
    expect(Number(await vp.getAttribute("data-scale"))).toBeGreaterThan(fitScale);
    for (let i = 0; i < 40; i++) await page.keyboard.press("-");
    expect(Number(await vp.getAttribute("data-scale"))).toBeLessThanOrEqual(fitScale);
    await expect.poll(overlaps).toEqual([]);
    await shot(page, "C12", `map-min-tall-${size.width}`);
    expect(pageErrors).toEqual([]);
  });
}
