import { expect, test } from "vitest";
import { createSemanticQueue } from "../../src/ui/views/map/semantic";

function harness() {
  let serial = 0;
  const frames = new Map<number, () => void>();
  const commits: string[] = [];
  let idle = 0;
  const queue = createSemanticQueue((fn) => { frames.set(++serial, fn); return serial; }, (id) => frames.delete(id), () => idle++);
  const tick = () => {
    const batch = [...frames.values()]; frames.clear();
    batch.forEach((fn) => fn());
  };
  const add = (key: object, name: string) => {
    let finish = () => {};
    const cancel = queue.enqueue(key, (done) => { commits.push(name); finish = done; });
    return { cancel, finish: () => finish() };
  };
  return { queue, tick, add, commits, frames, idle: () => idle };
}

test("at most two cards commit per frame, and the next chunk waits for acknowledgement", () => {
  const h = harness();
  const a = h.add({}, "first"), b = h.add({}, "second"); h.add({}, "third");
  h.tick(); h.tick();
  expect(h.commits).toEqual(["first", "second"]);
  expect(h.queue.busy()).toBe(true);
  a.finish(); h.tick();
  expect(h.commits).toEqual(["first", "second"]);
  b.finish(); h.tick();
  expect(h.commits).toEqual(["first", "second", "third"]);
});

test("rapid reversal cancels obsolete detail and commits the latest request", () => {
  const h = harness(), key = {};
  const old = h.add(key, "near"); old.cancel();
  const current = h.add(key, "far"); h.tick(); current.finish();
  expect(h.commits).toEqual(["far"]);
  expect(h.queue.busy()).toBe(false);
  expect(h.frames.size).toBe(0);
  expect(h.idle()).toBeGreaterThan(0);
});

test("a cancelled in-flight commit cannot acknowledge a replacement on the same card", () => {
  const h = harness(), key = {};
  const old = h.add(key, "near"); h.tick(); old.cancel();
  const current = h.add(key, "mid"); h.tick();
  h.add({}, "far"); old.finish(); h.tick();
  expect(h.commits).toEqual(["near", "mid"]);
  current.finish(); h.tick();
  expect(h.commits).toEqual(["near", "mid", "far"]);
});

test("unmounting the last pending card cancels its scheduled work", () => {
  const h = harness();
  h.add({}, "near").cancel(); h.tick();
  expect(h.commits).toEqual([]);
  expect(h.frames.size).toBe(0);
  expect(h.queue.busy()).toBe(false);
});
