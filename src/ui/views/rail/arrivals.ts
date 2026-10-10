// Tracks which rail items arrived after the first load, so each new L3/L4
// item gets one entrance (and nothing on initial render or re-renders).
import { useEffect, useRef, useState } from "react";

const known = new Set<string>();
const primed = new Set<string>();

export function useArrivals(channel: string, ids: string[] | null): Set<string> {
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids ? ids.join(",") : null;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    if (!ids) return;
    if (!primed.has(channel)) { ids.forEach((i) => known.add(i)); primed.add(channel); return; }
    const added = ids.filter((i) => !known.has(i));
    if (!added.length) return;
    added.forEach((i) => known.add(i));
    setFresh((f) => new Set([...f, ...added]));
    timers.current.push(setTimeout(() => setFresh((f) => { const n = new Set(f); added.forEach((i) => n.delete(i)); return n; }), 1200));
  }, [key]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return fresh;
}
