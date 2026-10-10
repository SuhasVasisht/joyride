import { afterEach, expect, test, vi } from "vitest";
import { createGesture } from "../../src/ui/views/map/gesture";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const frames = new Map<number, () => void>();
  let next = 0;
  let view = 0;
  const paints: number[] = [], commits: number[] = [];
  const moving: boolean[] = [];
  const gesture = createGesture(() => paints.push(view), () => commits.push(view), {
    frame: (fn) => { frames.set(++next, fn); return next; },
    cancelFrame: (id) => { frames.delete(id); },
    delay: (fn, ms) => setTimeout(fn, ms),
    cancelDelay: (id) => clearTimeout(id),
  }, (active) => moving.push(active));
  return {
    gesture, paints, commits, frames, moving,
    input(value: number) { view = value; gesture.update(); },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); },
  };
}

test("a burst paints the latest accumulated view once per frame", () => {
  const s = setup();
  s.input(1); s.input(2); s.input(3);
  expect(s.frames.size).toBe(1);
  expect(s.paints).toEqual([]);
  s.frame();
  expect(s.paints).toEqual([3]);
  expect(s.commits).toEqual([]);
  s.input(4); s.frame();
  expect(s.paints).toEqual([3, 4]);
});

test("continued input delays detail, then commits the final view", () => {
  const s = setup();
  s.input(1); s.frame();
  vi.advanceTimersByTime(48);
  s.input(2);
  vi.advanceTimersByTime(63);
  expect(s.commits).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(s.paints).toEqual([1, 2]);
  expect(s.commits).toEqual([2]);
  expect(s.frames.size).toBe(0);
});

test("finish flushes pending input and cancels its callbacks", () => {
  const s = setup();
  s.input(7); s.gesture.finish();
  s.frame(); vi.runAllTimers();
  expect(s.paints).toEqual([7]);
  expect(s.commits).toEqual([7]);
});

test("unmount or a preset cancels pending gesture work", () => {
  const s = setup();
  s.input(7); s.gesture.cancel();
  s.frame(); vi.runAllTimers();
  expect(s.paints).toEqual([]);
  expect(s.commits).toEqual([]);
  s.input(8); s.frame();
  expect(s.paints).toEqual([8]);
});

test("promotion lasts only for the moving camera and clears on settle or cancellation", () => {
  const s = setup();
  expect(s.gesture.active()).toBe(false);
  s.input(1); s.input(2); s.frame();
  expect(s.gesture.active()).toBe(true);
  expect(s.moving).toEqual([true]);
  vi.advanceTimersByTime(100);
  expect(s.gesture.active()).toBe(false);
  expect(s.moving).toEqual([true, false]);
  s.input(3); s.gesture.cancel();
  expect(s.gesture.active()).toBe(false);
  expect(s.moving).toEqual([true, false, true, false]);
});
