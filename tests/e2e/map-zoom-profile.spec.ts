import { test, expect } from "./devtools";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { seedDenseMap } from "./map-dense";
import { shot } from "./shot";

const measurement = z.object({
  kind: z.string(), frames: z.array(z.number()), handlers: z.array(z.number()), median: z.number(), p95: z.number(), max: z.number(), over20: z.number(),
  handlerMax: z.number(), reads: z.number(), nodeWrites: z.number(), hullWrites: z.number(), contentWrites: z.number(), nodes: z.number(), dom: z.number(), before: z.number(), after: z.number(), elapsed: z.number(), peakScale: z.number(), domPeak: z.number(),
});
const label = process.env.MAP_ZOOM_PROFILE;
test.skip(!label, "Opt-in performance measurement");
test.use({ deviceScaleFactor: Number(process.env.MAP_ZOOM_DPR ?? 1) });
test("measure dense map zoom through Chrome", async ({ page, devtools }) => {
  test.setTimeout(process.env.MAP_ZOOM_COMPARE ? 600000 : 120000);
  const compare = process.env.MAP_ZOOM_COMPARE;
  let uiDir = path.resolve(process.env.E2E_UI_DIR ?? "dist/ui-4415");
  if (compare) {
    await page.route("**/*", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(uiDir, pathname === "/" ? "index.html" : `.${pathname}`);
      if (file.startsWith(uiDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file });
      else await route.continue();
    });
    await page.addInitScript(() => sessionStorage.clear());
  }
  await seedDenseMap(page, true);
  await page.evaluate(() => document.fonts.ready);
  const results: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  {
    await devtools.select(page);
    const sides = compare ? Array.from({ length: 5 }, (_, trial) => [{ side: "before", trial }, { side: "after", trial }]).flat() : [{ side: label, trial: 0 }];
    for (const { side, trial } of sides) {
      if (compare) {
        uiDir = path.resolve(side === "before" ? compare : (process.env.E2E_UI_DIR ?? "dist/ui-4415"));
        await page.reload();
        await expect(page.locator("[data-mission]")).toHaveCount(10);
        await page.evaluate(() => document.fonts.ready);
      }
      for (const kind of ["pinch", "wheel", "button"]) {
      const stdout = await devtools.command(page, "eval", "--full", `async () => {
        const vp = document.querySelector('.map-viewport');
        document.querySelector('[role=radio]').click();
        await new Promise(r => setTimeout(r, 350));
        const rect = vp.getBoundingClientRect();
        const frames = [], handlers = [];
        let previous = 0, reads = 0, nodeWrites = 0, hullWrites = 0, contentWrites = 0;
        const original = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() { if(this.matches('.map-node')) reads++; return original.call(this); };
        const observer = new MutationObserver(records => {
          for(const r of records) {
            if(r.type === 'childList') contentWrites++;
            else if(r.target.matches('.map-node')) nodeWrites++;
            else if(r.target.matches('.contour path')) hullWrites++;
          }
        });
        observer.observe(vp, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'd'] });
        const before = Number(vp.dataset.scale);
        let peakScale = before, domPeak = vp.querySelectorAll("*").length;
        const start = performance.now();
        await new Promise(resolve => {
          let n = 0;
          function frame(t) {
            if(previous) frames.push(t - previous);
            previous = t;
            if(n < 96) {
              const a = performance.now();
              const direction = n < 48 ? -1 : 1;
              if('${kind}' === 'button') {
                if(n % 4 === 0) document.querySelector('[aria-label="' + (direction < 0 ? 'Zoom in' : 'Zoom out') + '"]').click();
              } else {
                for(let j = 0; j < 4; j++) vp.dispatchEvent(new WheelEvent('wheel', {
                  bubbles: true, cancelable: true, clientX: rect.left + rect.width * .45, clientY: rect.top + rect.height * .35,
                  deltaY: direction * ('${kind}' === 'pinch' ? .65 : 2.6), ctrlKey: '${kind}' === 'pinch', metaKey: '${kind}' === 'wheel'
                }));
              }
              handlers.push(performance.now() - a);
            }
            peakScale = Math.max(peakScale, Number(vp.dataset.scale));
            domPeak = Math.max(domPeak, vp.querySelectorAll("*").length);
            if(++n < 116) requestAnimationFrame(frame); else resolve();
          }
          requestAnimationFrame(frame);
        });
        observer.disconnect(); Element.prototype.getBoundingClientRect = original;
        const sorted = [...frames].sort((a,b) => a-b);
        return { kind: '${kind}', frames, handlers, median: sorted[Math.floor(sorted.length/2)], p95: sorted[Math.floor(sorted.length*.95)], max: Math.max(...frames), over20: frames.filter(x=>x>20).length,
          handlerMax: Math.max(...handlers), reads, nodeWrites, hullWrites, contentWrites, nodes: vp.querySelectorAll('.map-node').length, dom: vp.querySelectorAll('*').length,
          peakScale, domPeak, before, after: Number(vp.dataset.scale), elapsed: performance.now() - start };
      }`);
      const line = stdout.split("\n").find((line) => line.startsWith("result: "));
      if (!line) throw new Error(stdout);
      const result = measurement.parse(JSON.parse(z.string().parse(JSON.parse(line.slice(8)))));
      expect(result.peakScale).toBeGreaterThan(result.before);
      results.push({ side, trial, ...result });
      const { frames, handlers, ...summary } = result;
      console.log(JSON.stringify({ side, trial, ...summary }));
    }
    }
    fs.mkdirSync("test-results/zoom-profile", { recursive: true });
    fs.writeFileSync(`test-results/zoom-profile/${label}.json`, JSON.stringify(results, null, 2));
    expect(errors).toEqual([]);
    await expect(page.locator(".map-viewport")).toBeVisible();
    await shot(page, "C12", `map-zoom-profile-${label}`);
  }
});
