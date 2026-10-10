import { describe, expect, it } from "vitest";
import { cssString, fly, focusKey, focusOf, focusPath, frame, isOutward, largestFit, NO_FOCUS } from "../../src/ui/views/map/focus";
import { glanceOf, glanceParts, sortIdea, taskBucket } from "../../src/ui/views/map/glance";
import { parse } from "../../src/ui/lib/router";

const ask = (needs_you: boolean) => ({ needs_you }) as any;
const task = (status: string, section: string, asks: any[] = [], crew: any[] = []) => ({ status, section, asks, crew, last_event: "" }) as any;

describe("an idea at a glance", () => {
  it("sorts tasks by what the captain asks of them", () => {
    expect(taskBucket(task("working", "in_flight", [ask(true)]))).toBe("needs-you");
    expect(taskBucket(task("needs-decision", "in_flight", [ask(false)]))).toBe("stuck");
    expect(taskBucket(task("failed", "in_flight"))).toBe("stuck");
    expect(taskBucket(task("working", "in_flight", [], [{ status: "blocked" }]))).toBe("stuck");
    expect(taskBucket(task("working", "in_flight"))).toBe("moving");
    expect(taskBucket(task("paused", "in_flight"))).toBe("moving");
    expect(taskBucket(task("queued", "queued"))).toBe("next");
    expect(taskBucket(task("waiting", "in_flight"))).toBe("next");
  });
  it("counts asks that need the captain, then stuck, moving and next, and says it in that order", () => {
    const g = glanceOf({
      asks: [ask(true), ask(false)],
      tasks: [task("working", "in_flight", [ask(true), ask(true)]), task("blocked", "in_flight"), task("working", "in_flight"), task("queued", "queued")],
      workers: [{ status: "working" }, { status: "blocked" }, { status: "idle" }], landed: [1, 2],
    });
    expect(g).toEqual({ needsYou: 3, stuck: 2, moving: 2, next: 1, landed: 2, idle: 1 });
    expect(glanceParts(g).map((p) => p.text)).toEqual(["3 need you", "2 stuck", "2 moving", "1 up next"]);
    expect(glanceParts(g)[0].signal).toBe(true);
    expect(glanceParts({ needsYou: 1, stuck: 0, moving: 0, next: 0, landed: 4, idle: 2 }).map((p) => p.text)).toEqual(["1 needs you"]);
    expect(glanceParts({ needsYou: 0, stuck: 0, moving: 0, next: 0, landed: 4, idle: 2 })).toEqual([]);
    const sorted = sortIdea([task("queued", "queued")], [{ status: "idle" }, { status: "working" }]);
    expect(sorted.tasks.get("next")).toHaveLength(1);
    expect(sorted.workers.get("moving")).toHaveLength(1);
    expect(sorted.idle).toHaveLength(1);
  });
});

describe("focus in the URL", () => {
  it("reads and writes #/map?focus=<group>&idea=<idea>, ignoring an idea without a group", () => {
    const f = { group: "repo:/tmp/a b", idea: "csv-export" };
    expect(focusOf(parse(`#/${focusPath(f)}`))).toEqual(f);
    expect(focusOf(parse("#/map?idea=x"))).toEqual(NO_FOCUS);
    expect(focusOf(parse("#/mission/x"))).toEqual(NO_FOCUS);
    expect(focusPath(NO_FOCUS)).toBe("map");
  });
  it("knows stepping out from stepping across", () => {
    const g = { group: "lens:a", idea: null }, i = { group: "lens:a", idea: "x" };
    expect(isOutward(i, g)).toBe(true);
    expect(isOutward(g, NO_FOCUS)).toBe(true);
    expect(isOutward(g, i)).toBe(false);
    expect(isOutward(g, { group: "lens:b", idea: null })).toBe(false);
    expect(focusKey(NO_FOCUS)).toBe("");
  });
  it("escapes ids for attribute selectors", () => {
    expect(cssString('repo:/a "b"\\c')).toBe('"repo:/a \\"b\\"\\\\c"');
  });
});

describe("the camera", () => {
  it("frames a rectangle, centred when it fits and top-aligned when it doesn't", () => {
    expect(frame({ x: 100, y: 50, w: 200, h: 100 }, 1, { w: 1000, h: 800 }, { top: 60, bottom: 40 })).toEqual({ s: 1, tx: 300, ty: 60 + 300 - 50 });
    expect(frame({ x: 0, y: 0, w: 200, h: 2000 }, 1, { w: 1000, h: 800 }, { top: 60, bottom: 40 }).ty).toBe(60);
    expect(largestFit((s) => s <= 0.73, 0.5, 1)).toBeCloseTo(0.73, 2);
    expect(largestFit(() => false, 0.5, 1)).toBe(0.5);
  });
  it("flies to a target read every frame and lands on it exactly", () => {
    let t = 0;
    const frames: (() => void)[] = [];
    const seen: { s: number; tx: number; ty: number }[] = [];
    let done = false;
    let target = { s: 1, tx: -500, ty: -200 };
    fly({ s: 0.5, tx: 0, ty: 0 }, () => target, { w: 1000, h: 800 }, 400, (v) => { seen.push(v); }, () => { done = true; },
      { frame: (fn) => { frames.push(() => fn(t)); return frames.length; }, cancel: () => {}, now: () => t });
    for (let i = 1; i <= 10 && !done; i++) {
      t = i * 50;
      if (i === 5) target = { s: 1, tx: -520, ty: -200 };
      frames.shift()!();
    }
    expect(done).toBe(true);
    expect(seen.at(-1)).toEqual({ s: 1, tx: -520, ty: -200 });
    // A frame handler that says false stops the flight where it is, without landing.
    let landed = false, n = 0;
    const q: (() => void)[] = [];
    fly({ s: 1, tx: 0, ty: 0 }, () => ({ s: 1, tx: 100, ty: 0 }), { w: 1000, h: 800 }, 400, () => (++n < 2 ? undefined : false), () => { landed = true; },
      { frame: (fn) => { q.push(() => fn(0)); return q.length; }, cancel: () => {}, now: () => n * 50 });
    while (q.length) q.shift()!();
    expect(landed).toBe(false);
    expect(n).toBe(2);
    // Scale moves monotonically between the two.
    for (let i = 1; i < seen.length; i++) expect(seen[i].s).toBeGreaterThanOrEqual(seen[i - 1].s - 1e-9);
  });
});
