/** Serialize expensive card commits, yielding a paint between pairs of cards. A transition
 * alone can interrupt render work, but still commits every card in one burst. */
export function createSemanticQueue(
  frame: (fn: () => void) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
  idle: () => void = () => {},
) {
  const waiting = new Map<object, (done: () => void) => void>();
  const active = new Set<{ key: object }>();
  let scheduled: number | null = null;
  const schedule = () => {
    if (active.size || scheduled !== null) return;
    if (!waiting.size) { idle(); return; }
    scheduled = frame(() => {
      scheduled = null;
      const batch = [...waiting.entries()].slice(0, 2).map(([key, commit]) => {
        waiting.delete(key);
        const job = { key };
        active.add(job);
        return { job, commit };
      });
      for (const { job, commit } of batch) commit(() => {
        if (!active.delete(job)) return;
        schedule();
      });
    });
  };
  return {
    busy: () => active.size > 0 || waiting.size > 0,
    enqueue(key: object, commit: (done: () => void) => void) {
      waiting.set(key, commit);
      schedule();
      return () => {
        waiting.delete(key);
        for (const job of active) if (job.key === key) active.delete(job);
        if (!waiting.size && scheduled !== null) { cancelFrame(scheduled); scheduled = null; }
        schedule();
      };
    },
  };
}

export type SemanticQueue = ReturnType<typeof createSemanticQueue>;
