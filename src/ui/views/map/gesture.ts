type Scheduler = {
  frame: (fn: () => void) => number;
  cancelFrame: (id: number) => void;
  delay: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancelDelay: (id: ReturnType<typeof setTimeout>) => void;
};

/** Paint the latest view once per frame and commit detail after input stops. */
export function createGesture(paint: () => void, settle: () => void, scheduler: Scheduler = {
  frame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (id) => cancelAnimationFrame(id),
  delay: (fn, ms) => setTimeout(fn, ms),
  cancelDelay: (id) => clearTimeout(id),
}, moving: (active: boolean) => void = () => {}) {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (frame !== null) scheduler.cancelFrame(frame);
    if (timer !== null) scheduler.cancelDelay(timer);
    frame = null;
    timer = null;
    moving(false);
  };
  const finish = () => {
    cancel();
    paint();
    settle();
  };
  return {
    active: () => timer !== null,
    update() {
      if (timer === null) moving(true);
      if (frame === null) frame = scheduler.frame(() => { frame = null; paint(); });
      if (timer !== null) scheduler.cancelDelay(timer);
      // Four quiet refresh intervals leave time for incremental card commits.
      timer = scheduler.delay(finish, 64);
    },
    finish,
    cancel,
  };
}
