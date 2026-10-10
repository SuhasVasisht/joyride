// Motion for a self-updating map (control plane CP6). Two primitives, both quiet and both off under
// prefers-reduced-motion:
//   Pulse / usePulse  a card pulses once when its state changes (never on first render).
//   useMorph          FLIP: children marked data-morph-id glide from where they were to where they are
//                     when ideas and groups are renamed, merged or regrouped; new ids fade in.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** True for one animation after `value` changes; keyed by JSON so objects compare by content. */
export function usePulse(value: unknown, ms = 900): boolean {
  const key = JSON.stringify(value ?? null);
  const prev = useRef(key);
  const [on, setOn] = useState(false);
  useLayoutEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    if (reduced()) return;
    setOn(false);
    const raf = requestAnimationFrame(() => setOn(true));
    const t = setTimeout(() => setOn(false), ms);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [key, ms]);
  return on;
}

/** Wraps a card; pulses its edge once when `value` changes. `tone` picks the colour: signal only for needs-you. */
export function Pulse({ value, tone = "working", className = "", style, children, as: Tag = "div" }: {
  value: unknown; tone?: "working" | "review" | "signal"; className?: string; style?: CSSProperties; children: ReactNode; as?: "div" | "li" | "section" | "span";
}) {
  const on = usePulse(value);
  return <Tag className={`nd-pulse tone-${tone}${on ? " pulsing" : ""}${className ? ` ${className}` : ""}`} style={style} data-pulse={on ? "on" : undefined}>{children}</Tag>;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * FLIP for every [data-morph-id] inside `ref`: after each render where `deps` changed, elements that moved
 * or resized animate from their previous box; ids that are new fade and scale in. Layout must be keyed by
 * ids (the map's dataKey) so an element survives a rename instead of remounting.
 */
export function useMorph(ref: RefObject<HTMLElement | null>, deps: unknown[], ms = 380) {
  const boxes = useRef(new Map<string, Box>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>("[data-morph-id]")];
    const next = new Map<string, Box>();
    const first = boxes.current.size === 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      next.set(el.dataset.morphId!, { x: r.left, y: r.top, w: r.width, h: r.height });
    }
    if (!first && !reduced() && typeof root.animate === "function") {
      for (const el of els) {
        const id = el.dataset.morphId!;
        const now = next.get(id)!, was = boxes.current.get(id);
        if (!was) { el.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: ms, easing: "cubic-bezier(.2,.7,.2,1)" }); continue; }
        const dx = was.x - now.x, dy = was.y - now.y;
        const sx = now.w ? was.w / now.w : 1, sy = now.h ? was.h / now.h : 1;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        el.dataset.morphing = "1";
        const a = el.animate([{ transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: "top left", transform: "none" }], { duration: ms, easing: "cubic-bezier(.2,.7,.2,1)" });
        a.onfinish = a.oncancel = () => { delete el.dataset.morphing; };
      }
    }
    boxes.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A container whose [data-morph-id] children morph when `deps` change. */
export function Morph({ deps, className, children }: { deps: unknown[]; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useMorph(ref, deps);
  return <div ref={ref} className={className}>{children}</div>;
}
