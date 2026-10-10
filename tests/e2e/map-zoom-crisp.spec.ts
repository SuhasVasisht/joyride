import { test, expect } from "./devtools";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { seedDenseMap } from "./map-dense";
import { shot } from "./shot";

const label = process.env.MAP_ZOOM_QUALITY ?? "after";
const baseline = label === "before";
const difference = z.object({ mean: z.number(), changed: z.number(), max: z.number(), pixels: z.number() });
const state = z.object({ scale: z.number(), transform: z.number(), level: z.string(), dpr: z.number(), willChange: z.string() });


for (const dpr of [1, 2]) {
  test.describe(`map raster at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("settled zoom matches a fresh raster after temporary camera promotion", async ({ page, devtools }) => {
      test.setTimeout(240000);
      const command = (...args: string[]) => devtools.command(page, ...args);
      const evaluate = async (code: string): Promise<unknown> => {
        const output = await command("eval", "--full", code);
        const result = output.split("\n").find((line) => line.startsWith("result: "));
        if (!result) throw new Error(output);
        return JSON.parse(z.string().parse(JSON.parse(result.slice(8))));
      };
      const dir = path.resolve("test-results/zoom-crisp", `${label}-dpr${dpr}`);
      const checkpoint = `C12/zoom-crisp/${label}-dpr${dpr}`;
      fs.mkdirSync(dir, { recursive: true });
      const results: unknown[] = [];
      try {
        await seedDenseMap(page, true);
        await page.evaluate(() => document.fonts.ready);
        await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
        await devtools.select(page);
        await evaluate(`() => {
          window.zoomOriginalTimeout = window.setTimeout;
          window.setTimeout = function(fn, ms, ...args) { return window.zoomOriginalTimeout(fn, (ms === 64 || ms === 100) ? 60000 : ms, ...args); };
          return true;
        }`);
        const compare = async (name: string) => {
          const actual = path.join(dir, `${name}.png`), fresh = path.join(dir, `${name}-fresh.png`);
          const view = state.parse(await evaluate(`() => {
            const vp = document.querySelector('.map-viewport'), layer = document.querySelector('.map-layer');
            return { scale: Number(vp.dataset.scale), level: vp.dataset.zoom, transform: new DOMMatrix(getComputedStyle(layer).transform).a, dpr: devicePixelRatio, willChange: getComputedStyle(layer).willChange };
          }`));
          expect(view.dpr, name).toBe(dpr);
          if (!baseline && name.endsWith("during")) expect(view.willChange, name).toBe("transform");
          if (name.endsWith("settled")) expect(view.transform, name).toBeCloseTo(1, 6);
          await page.screenshot({ path: actual });
          const keep = ["pinch-1.25-during", "pinch-3.5-settled", "fit-settled"].includes(name);
          if (keep) await shot(page, checkpoint, name);
          if (name === "pinch-1.25-during") await command("screenshot", path.join(dir, "chrome-during.png"));
          // A new layer has no raster history. It keeps the identical DOM, geometry and CSS transform.
          await evaluate(`async () => {
            const original = document.querySelector('.map-layer');
            window.zoomOriginalLayer = original;
            const fresh = original.cloneNode(true);
            window.zoomFreshLayer = fresh;
            original.style.visibility = 'hidden';
            original.after(fresh);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
          }`);
          await page.screenshot({ path: fresh });
          if (keep) await shot(page, checkpoint, `${name}-fresh`);
          await evaluate(`() => { window.zoomFreshLayer.remove(); window.zoomOriginalLayer.style.removeProperty('visibility'); delete window.zoomFreshLayer; delete window.zoomOriginalLayer; return true; }`);
          await page.route("**/__raster_actual", (route) => route.fulfill({ path: actual }));
          await page.route("**/__raster_fresh", (route) => route.fulfill({ path: fresh }));
          const delta = difference.parse(await evaluate(`async () => {
            const decode = async (s) => {
              const image = await createImageBitmap(await (await fetch(s)).blob());
              const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
              const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            };
            const a = await decode('/__raster_actual'), b = await decode('/__raster_fresh');
            if (a.length !== b.length) throw new Error("Raster screenshot dimensions differ");
            let sum = 0, changed = 0, max = 0;
            for (let i = 0; i < a.length; i += 4) { let pixel = 0; for(let c = 0; c < 3; c++) { const d = Math.abs(a[i+c]-b[i+c]); sum += d; pixel = Math.max(pixel, d); } if(pixel > 8) changed++; max = Math.max(max, pixel); }
            return { mean: sum / (a.length / 4 * 3), changed: changed / (a.length / 4), max, pixels: a.length / 4 };
          }`));
          await page.unroute("**/__raster_actual");
          await page.unroute("**/__raster_fresh");
          console.log(JSON.stringify({ name, ...view, ...delta }));
          results.push({ name, ...view, ...delta });
          if (!baseline && name.endsWith("settled")) {
            expect(view.willChange, name).toBe("auto");
            expect(delta.mean, `${name} mean RGB difference`).toBeLessThan(0.1);
            expect(delta.changed, `${name} fraction of pixels differing by >8`).toBeLessThan(0.002);
          }
        };
        const preset = async (name: string) => {
          await page.getByRole("radio", { name, exact: true }).click();
          await page.waitForTimeout(300);
        };
        for (const factor of [1.25, 2, 3.5]) {
          await preset("Far");
          await evaluate(`async () => {
            const vp = document.querySelector('.map-viewport'), r = vp.getBoundingClientRect();
            for (let i = 0; i < 4; i++) vp.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(${factor}) / .04, clientX: r.left + r.width * .45, clientY: r.top + r.height * .35 }));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;
          }`);
          await compare(`pinch-${factor}-during`);
          await evaluate(`() => { window.setTimeout = window.zoomOriginalTimeout; return true; }`);
          // Send an unchanged view through the input path to release the deferred layout.
          await evaluate(`() => { document.querySelector('.map-viewport').dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, ctrlKey:true, deltaY:0 })); return true; }`);
          await page.waitForTimeout(400);
          await compare(`pinch-${factor}-settled`);
          await evaluate(`() => { window.setTimeout = function(fn, ms, ...args) { return window.zoomOriginalTimeout(fn, (ms === 64 || ms === 100) ? 60000 : ms, ...args); }; return true; }`);
        }
        await preset("Far");
        for (const [name, factor] of [["long-pinch-in", 2], ["long-pinch-out", 0.7]] as const) {
          await evaluate(`async () => {
            const vp = document.querySelector('.map-viewport'), r = vp.getBoundingClientRect();
            for (let i = 0; i < 48; i++) {
              vp.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, ctrlKey:true, deltaY:-Math.log(${factor})/.48, clientX:r.left+r.width/2, clientY:r.top+r.height/2 }));
              await new Promise(r => requestAnimationFrame(r));
            }
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;
          }`);
          await compare(`${name}-during`);
        }
        await preset("Far");
        await evaluate(`async () => {
          const vp = document.querySelector('.map-viewport'), r = vp.getBoundingClientRect();
          const x = r.left+r.width/2, y = r.bottom-130;
          const pointer = (type, id, px) => vp.dispatchEvent(new PointerEvent(type, { bubbles:true, pointerId:id, pointerType:'touch', button:0, clientX:px, clientY:y }));
          pointer('pointerdown',101,x-40); pointer('pointerdown',102,x+40);
          pointer('pointermove',101,x-60); pointer('pointermove',102,x+60);
          window.zoomPointerUp = () => { pointer('pointerup',101,x-60); pointer('pointerup',102,x+60); };
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;
        }`);
        await compare("two-pointer-during");
        await evaluate(`() => { window.setTimeout = window.zoomOriginalTimeout; window.zoomPointerUp(); delete window.zoomPointerUp; document.querySelector('.map-viewport').dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, ctrlKey:true, deltaY:0 })); return true; }`);
        await page.waitForTimeout(400);
        await compare("two-pointer-settled");
        await evaluate(`() => { window.setTimeout = function(fn, ms, ...args) { return window.zoomOriginalTimeout(fn, (ms === 64 || ms === 100) ? 60000 : ms, ...args); }; return true; }`);
        await preset("Mid");
        await evaluate(`async () => {
          const vp = document.querySelector('.map-viewport'), r = vp.getBoundingClientRect();
          vp.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, metaKey:true, deltaY:-160, clientX:r.left+r.width/2, clientY:r.top+r.height/2 }));
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;
        }`);
        await compare("wheel-during");
        await evaluate(`() => { window.setTimeout = window.zoomOriginalTimeout; return true; }`);
        await evaluate(`() => { document.querySelector('.map-viewport').dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, ctrlKey:true, deltaY:0 })); return true; }`);
        await page.waitForTimeout(400);
        await compare("wheel-settled");
        for (const [name, button] of [["plus", "Zoom in"], ["minus", "Zoom out"]] as const) {
          await evaluate(`() => { window.setTimeout = function(fn, ms, ...args) { return window.zoomOriginalTimeout(fn, (ms === 64 || ms === 100) ? 60000 : ms, ...args); }; return true; }`);
          await page.getByRole("button", { name: button, exact: true }).click();
          await page.waitForTimeout(50);
          await compare(`${name}-during`);
          await evaluate(`() => { window.setTimeout = window.zoomOriginalTimeout; document.querySelector('.map-viewport').dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, ctrlKey:true, deltaY:0 })); return true; }`);
          await page.waitForTimeout(400);
          await compare(`${name}-settled`);
        }
        for (const name of ["Near", "Mid", "Far"]) { await preset(name); await compare(`${name.toLowerCase()}-settled`); }
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await page.waitForTimeout(400);
        await compare("fit-settled");
        await shot(page, "C12", `map-crisp-${label}-dpr${dpr}`);
      } finally {
        fs.mkdirSync(path.resolve("docs/checkpoints", checkpoint), { recursive: true });
        fs.writeFileSync(path.resolve("docs/checkpoints", checkpoint, "pixels.json"), JSON.stringify(results, null, 2));

      }
    });
  });
}
