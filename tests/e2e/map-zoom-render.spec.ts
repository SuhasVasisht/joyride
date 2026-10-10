import { test, expect } from "./devtools";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { seedRealisticMap } from "./map-realistic";
import { shot } from "./shot";

const label = process.env.MAP_RENDER_SIDE ?? "after";
const beforeDir = process.env.MAP_RENDER_COMPARE;
const stats = z.object({ frames: z.array(z.number()), p95: z.number(), max: z.number(), scale: z.number(), dom: z.number(), tasks: z.number(), notes: z.number(), chips: z.number(), settledMs: z.number().nullable(), hidden: z.number(), levelCommits: z.number(), maxPending: z.number() });
const pixels = z.object({ mean: z.number(), changed: z.number(), scale: z.number(), transform: z.number(), willChange: z.string() });
test.use({ deviceScaleFactor: 2 });

test("realistic DPR 2 map camera stays in budget and settles to a fresh raster", async ({ page, devtools }) => {
  test.setTimeout(600000);
  const command = (...args: string[]) => devtools.command(page, ...args);
  const evaluate = async (code: string): Promise<unknown> => {
    const output = await command("eval", "--full", code);
    const result = output.split("\n").find((line) => line.startsWith("result: "));
    if (!result) throw new Error(output);
    return JSON.parse(z.string().parse(JSON.parse(result.slice(8))));
  };
  let uiDir = path.resolve(process.env.E2E_UI_DIR ?? "dist/ui");
  if (beforeDir) await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const file = path.resolve(uiDir, pathname === "/" ? "index.html" : `.${pathname}`);
    if (file.startsWith(uiDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file });
    else await route.continue();
  });
  const results: unknown[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await seedRealisticMap(page);
    await devtools.select(page);
    if (process.env.MAP_RENDER_CPU) await command("emulate", "--cpu", process.env.MAP_RENDER_CPU);
    if (process.env.MAP_RENDER_TRACE) await command("perf-start", "--no-reload", "--no-auto-stop");
    const sides = beforeDir ? Array.from({ length: Number(process.env.MAP_RENDER_TRIALS ?? 5) }, (_, trial) => [{ side: "before", trial }, { side: "after", trial }]).flat() : Array.from({ length: Number(process.env.MAP_RENDER_TRIALS ?? 1) }, (_, trial) => ({ side: label, trial }));
    for (const { side, trial } of sides) {
      if (beforeDir) {
        uiDir = path.resolve(side === "before" ? beforeDir : (process.env.E2E_UI_DIR ?? "dist/ui"));
        await page.reload(); await expect(page.locator("[data-mission]")).toHaveCount(13);
        await page.evaluate(() => document.fonts.ready);
      }
      const kinds = process.env.MAP_RENDER_TRACE || process.env.MAP_RENDER_LEVELS_ONLY ? ["levels"] : ["pinch", "wheel", "buttons", "pan", "fit", "levels"];
      for (const kind of kinds) {
        const result = stats.parse(await evaluate(`async () => {
          const vp = document.querySelector('.map-viewport');
          vp.querySelector('[data-mission="render-0"] .mn-title').focus();
          [...document.querySelectorAll('[role=radio]')].find(el => el.textContent === 'Near').click();
          const deadline = performance.now() + 10000;
          while(true) {
            const detailed = vp.querySelectorAll('.mission-node:not([data-camera-simplified])').length;
            if(vp.dataset.zoom === 'near' && vp.querySelectorAll('[data-note-card]').length === detailed * 3 && vp.querySelectorAll('.task-card').length === detailed * 2) break;
            if(performance.now() > deadline) throw new Error('Realistic fixture did not finish loading its note and task cards');
            await new Promise(r => setTimeout(r, 50));
          }
          await new Promise(r => setTimeout(r, 250));
          const rect = vp.getBoundingClientRect();
          const tasks = vp.querySelectorAll('.task-card').length, notes = vp.querySelectorAll('[data-note-card]').length, chips = vp.querySelectorAll('.art-chip').length;
          const tracing = ${Boolean(process.env.MAP_RENDER_TRACE)};
          if(tracing) performance.mark('map:levels:begin');
          const observer = tracing ? new MutationObserver(records => {
            const semantic = records.some(r => r.target === vp && r.attributeName === 'data-zoom');
            const children = records.filter(r => r.type === 'childList').length;
            if(semantic || children) performance.mark('map:commit:' + vp.dataset.zoom + ':children=' + children);
          }) : null;
          observer?.observe(vp, {subtree:true, childList:true, attributes:true, attributeFilter:['data-zoom']});
          const inputFrames = '${kind}' === 'levels' ? 380 : 80, totalFrames = inputFrames + 20;
          const frames = []; let previous = 0, lastInput = 0, lastInputFrame = -1, settledMs = null;
          let lastLevel = vp.dataset.zoom, levelCommits = 0, maxPending = 0;
          await new Promise(resolve => {
            let n = 0;
            function frame(t) {
              if(tracing) performance.mark('map:frame:' + n);
              if(previous) frames.push(t - previous); previous = t;
              if(n < inputFrames) {
                const direction = n < 40 ? -1 : 1;
                if('${kind}' === 'buttons') { if(n % 8 === 0) { lastInput = performance.now(); lastInputFrame = n; settledMs = null; document.querySelector('[aria-label="'+(direction < 0 ? 'Zoom in' : 'Zoom out')+'"]').click(); } }
                else if('${kind}' === 'fit') { if(n === 5) { lastInput = performance.now(); lastInputFrame = n; settledMs = null; [...document.querySelectorAll('.zoom-controls button')].find(el => el.textContent === 'Fit').click(); } }
                else if('${kind}' === 'levels') { if(n % 20 === 0) { lastInput = performance.now(); lastInputFrame = n; settledMs = null; if(tracing) performance.mark('map:level-input:' + n); document.querySelectorAll('[role=radio]')[Math.floor(n/20)%3].click(); } }
                else { lastInput = performance.now(); lastInputFrame = n; settledMs = null; for(let j = 0; j < 4; j++) vp.dispatchEvent(new WheelEvent('wheel', {
                  bubbles:true, cancelable:true, clientX:rect.left+rect.width*.45, clientY:rect.top+rect.height*.35,
                  deltaY:direction * ('${kind}' === 'pinch' ? .5 : '${kind}' === 'pan' ? 1 : 2),
                  ctrlKey:'${kind}' === 'pinch', metaKey:'${kind}' === 'wheel'
                })); }
              }
              if(vp.dataset.zoom !== lastLevel) { lastLevel = vp.dataset.zoom; levelCommits++; }
              maxPending = Math.max(maxPending, vp.querySelectorAll('[data-semantic-pending]').length);
              const camera = vp.querySelector('.map-layer').style;
              if (n > lastInputFrame && lastInput && settledMs === null && camera.willChange === 'auto' && new DOMMatrix(camera.transform).a === 1 && !vp.querySelector('[data-semantic-pending]')) settledMs = performance.now() - lastInput;
              if(++n < totalFrames) requestAnimationFrame(frame); else resolve();
            } requestAnimationFrame(frame);
          });
          observer?.disconnect();
          if(tracing) performance.mark('map:levels:end');
          const sorted = [...frames].sort((a,b)=>a-b);
          return { frames, p95:sorted[Math.floor(sorted.length*.95)], max:Math.max(...frames), scale:Number(vp.dataset.scale), dom:vp.querySelectorAll('*').length, tasks, notes, chips, settledMs, hidden: vp.querySelectorAll('[data-camera-hidden]').length, levelCommits, maxPending };
        }`));
        const shotLabel = beforeDir ? `${label}-${side}` : side;
        const { frames, ...summary } = result;
        results.push({ side, trial, kind, ...result }); console.log(JSON.stringify({ side, trial, kind, ...summary }));
        if (kind === "levels") expect(result.levelCommits).toBe(19);
        expect(result.tasks).toBeGreaterThanOrEqual(2); expect(result.notes).toBe(result.tasks * 1.5); expect(result.chips).toBeGreaterThan(5);
        // Chromium rounds frame timestamps to 0.1ms. A 60Hz tick can read 16.8ms.
        if (side !== "before" && !process.env.MAP_RENDER_TRACE) {
          expect.soft(result.p95, `${kind} p95 including clock rounding`).toBeLessThanOrEqual(16.9);
          // Two ticks allow one missed refresh, including timestamp rounding.
          expect.soft(result.max, `${kind} maximum frame`).toBeLessThanOrEqual(33.6);
          expect.soft(result.settledMs).not.toBeNull(); expect.soft(result.settledMs).toBeLessThanOrEqual(150);
          if (kind === "pan") expect(result.hidden).toBeGreaterThan(0);
        }
        // A clone cannot inherit focus (including outline and rounded clipping).
        if (trial === 0) await evaluate(`() => { if(document.activeElement instanceof HTMLElement) document.activeElement.blur(); return true; }`);
        if (trial === 0) await shot(page, "C12/zoom-render", `${shotLabel}-${kind}`);
        if (trial === 0) {
          const dir = path.resolve("docs/checkpoints/C12/zoom-render");
          const actual = path.join(dir, `${shotLabel}-${kind}-raster.png`), fresh = path.join(dir, `${shotLabel}-${kind}-fresh.png`);
          const style = await page.addStyleTag({ content: "*, *::before, *::after { animation:none !important; transition:none !important; caret-color:transparent !important; }" });
          await page.locator(".map-viewport").screenshot({ path: actual });
          await evaluate(`async () => {
            const original = document.querySelector('.map-layer'); window.renderOriginal = original;
            const clone = original.cloneNode(true); clone.style.willChange = 'auto'; window.renderFresh = clone;
            original.style.visibility = 'hidden'; original.after(clone);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;
          }`);
          await page.locator(".map-viewport").screenshot({ path: fresh });
          await evaluate(`() => { window.renderFresh.remove(); window.renderOriginal.style.removeProperty('visibility'); delete window.renderFresh; delete window.renderOriginal; return true; }`);
          await page.route("**/__render_actual", (r) => r.fulfill({ path: actual }));
          await page.route("**/__render_fresh", (r) => r.fulfill({ path: fresh }));
          const delta = pixels.parse(await evaluate(`async () => {
            const decode = async (url) => { const image = await createImageBitmap(await (await fetch(url)).blob()); const c = document.createElement('canvas'); c.width=image.width; c.height=image.height; const ctx=c.getContext('2d'); ctx.drawImage(image,0,0); return ctx.getImageData(0,0,c.width,c.height).data; };
            const a=await decode('/__render_actual'), b=await decode('/__render_fresh'); if(a.length !== b.length) throw new Error('Image sizes differ');
            let sum=0,changed=0; for(let i=0;i<a.length;i+=4) { let max=0; for(let j=0;j<3;j++) { const d=Math.abs(a[i+j]-b[i+j]); sum+=d; max=Math.max(max,d); } if(max>8)changed++; }
            const layer=document.querySelector('.map-layer'); return { mean:sum/(a.length/4*3), changed:changed/(a.length/4), scale:Number(document.querySelector('.map-viewport').dataset.scale), transform:new DOMMatrix(getComputedStyle(layer).transform).a, willChange:getComputedStyle(layer).willChange };
          }`));
          await page.unroute("**/__render_actual"); await page.unroute("**/__render_fresh"); await style.evaluate((el) => el.parentNode?.removeChild(el));
          results.push({ side, trial, kind, raster: delta });
          expect.soft(delta.mean, `${kind} fresh raster mean`).toBe(0);
          expect.soft(delta.changed, `${kind} fresh raster changed pixels`).toBe(0);
          expect(delta.transform).toBeCloseTo(1, 6); expect(delta.willChange).toBe("auto");
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    fs.mkdirSync("docs/checkpoints/C12/zoom-render", { recursive: true });
    fs.writeFileSync(`docs/checkpoints/C12/zoom-render/${label}-frames.json`, JSON.stringify(results, null, 2));
    if (process.env.MAP_RENDER_TRACE) console.log(await command("perf-stop", "--file", path.resolve(`.joyride/zoom-render/${label}-trace.json.gz`)));

  }
});

test("offscreen idea details stay lightweight and keyboard focus restores their controls", async ({ page }) => {
  await seedRealisticMap(page);
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  const placeholder = page.locator('[data-mission][data-camera-simplified]').last();
  await expect(placeholder).toHaveAttribute("data-camera-simplified", "");
  const idea = await placeholder.getAttribute("data-mission");
  if (!idea) throw new Error("Missing offscreen idea");
  expect(await placeholder.locator(".task-card, [data-note-card]").count()).toBe(0);
  await placeholder.locator(".mn-title").focus();
  const restored = page.locator(`[data-mission="${idea}"]`);
  await expect(restored).not.toHaveAttribute("data-camera-simplified", "");
  await expect(restored.locator(".task-card")).toHaveCount(2);
  await expect(restored.locator("[data-note-card]")).toHaveCount(3);
  const scale = Number(await page.locator(".map-viewport").getAttribute("data-scale"));
  await page.keyboard.press("+");
  await expect.poll(async () => Number(await page.locator(".map-viewport").getAttribute("data-scale"))).toBeGreaterThan(scale);
  await page.keyboard.press("-");
  await expect.poll(async () => Number(await page.locator(".map-viewport").getAttribute("data-scale"))).toBeCloseTo(scale, 2);
  await shot(page, "C12/zoom-render", "offscreen-idea-restored");
});

test("semantic swaps retain outgoing cards and rapid reversal finishes at the requested detail", async ({ page }) => {
  await seedRealisticMap(page);
  const viewport = page.locator(".map-viewport");
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  await expect(viewport).toHaveAttribute("data-zoom", "near");
  await expect(viewport.locator("[data-semantic-pending]")).toHaveCount(0);
  await expect(viewport.locator(".task-card").first()).toBeVisible();
  const retained = await viewport.evaluate(async (vp) => {
    let outgoing = false, empty = false, obsolete = false;
    const offscreen = [...vp.querySelectorAll(".mission-node[data-camera-simplified]")];
    const observer = new MutationObserver(() => {
      if (vp.getAttribute("data-zoom") === "far" && offscreen.some((node) => node.querySelector(".task-card"))) obsolete = true;
      for (const node of vp.querySelectorAll(".mission-node:not([data-camera-simplified])")) {
        if (node.hasAttribute("data-semantic-pending") && node.querySelector(".task-card")) outgoing = true;
        if (!node.querySelector(".mn-summary, .mn-detail")) empty = true;
      }
    });
    observer.observe(vp, { subtree: true, attributes: true, childList: true });
    const far = [...vp.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((el) => el.textContent === "Far");
    far?.click();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    observer.disconnect();
    return { outgoing, empty, obsolete };
  });
  expect(retained).toEqual({ outgoing: true, empty: false, obsolete: false });
  await viewport.evaluate(async (vp) => {
    for (const level of ["Near", "Far", "Near", "Mid"]) {
      [...vp.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((el) => el.textContent === level)?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  await expect(viewport).toHaveAttribute("data-zoom", "mid");
  await expect(viewport.locator("[data-semantic-pending]")).toHaveCount(0);
  await expect(viewport.locator('.mission-node:not([data-camera-simplified]):not([data-lv="mid"])')).toHaveCount(0);
  await expect(viewport.locator(".task-card")).toHaveCount(0);
  await expect(viewport.locator(".task-row").first()).toBeVisible();
  await shot(page, "C12/zoom-render", "levelswap-rapid-reversal");
});

test("Show on map restores an offscreen idea's note before gliding to it", async ({ page }) => {
  await seedRealisticMap(page);
  await page.getByRole("radio", { name: "Near", exact: true }).click();
  const placeholder = page.locator('[data-mission][data-camera-simplified]').last();
  await expect(placeholder).toHaveAttribute("data-camera-simplified", "");
  const idea = await placeholder.getAttribute("data-mission");
  if (!idea) throw new Error("Missing offscreen idea");
  const note = `render-note-${idea.slice("render-".length)}-0`;
  expect(await placeholder.locator("[data-board-item]").count()).toBe(0);
  // Let the saved camera retain this offscreen target when the map mounts again.
  await page.waitForTimeout(300);
  await page.goto("/#/board");
  await page.locator(`.bd-page [data-board-item="${note}"]`).getByRole("button", { name: "Show on map", exact: true }).click();
  const card = page.locator(`.map-plane [data-board-item="${note}"]`);
  await expect(card).toHaveAttribute("data-landed", "", { timeout: 4000 });
  await expect(page.locator(`[data-mission="${idea}"]`)).not.toHaveAttribute("data-camera-simplified", "");
  await expect(card).toBeInViewport();
  await shot(page, "C12/zoom-render", "offscreen-note-revealed");
});
