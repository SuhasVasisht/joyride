// A board item's flight from New into its place. New has already saved it (views/new/apply.ts); this card is
// only the motion: it lifts off the box, the chart glides to the item's place when it is off screen, the card
// flies into the item's real card (or its chip at far zoom) and dissolves into it, and the place glows once.
// Off the chart (another page, or the item isn't drawn) it says where it went and fades; New's result keeps
// Show on map and Undo. Nothing stays behind.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { parse } from "../../lib/router";
import { itemKind, parseBlocks } from "../../../shared/board";
import { placeName } from "../../../shared/new-plan";
import { revealOnMap } from "../../views/map/reveal";
import { setArriving } from "../notes/arriving";
import { KIND_GLYPH, LinkGlyph } from "../notes/NoteCard";
import { ghostStore, type Ghost } from "./ghost";

const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The longest a ghost may live: the longest flight (lift, finding the card, a glide, the arc) with room to spare. */
const WATCHDOG_MS = 7000;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
/**
 * The item's card (or chip) on the chart once it is drawn and the chart has made room for it (its place grows,
 * the chart re-packs): null when it doesn't appear within `ms`.
 */
async function cardOf(id: string, ms: number, live: () => boolean): Promise<HTMLElement | null> {
  const sel = `.map-viewport .map-plane [data-board-item="${CSS.escape(id)}"]`;
  const t0 = performance.now();
  let last = "", same = 0;
  while (live() && performance.now() - t0 < ms) {
    const el = document.querySelector<HTMLElement>(sel);
    const r = el?.getBoundingClientRect();
    const sig = r && r.width > 0 ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : "";
    same = sig && sig === last ? same + 1 : 0;
    last = sig;
    if (el && same >= 4) return el;
    await frame();
  }
  return null;
}
function inView(el: HTMLElement): boolean {
  const vp = el.closest(".map-viewport")?.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return !!vp && r.left >= vp.left + 8 && r.right <= vp.right - 8 && r.top >= vp.top + 8 && r.bottom <= vp.bottom - 60;
}
/** The chart's "landed" event for this item, or a timeout. */
function landed(id: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const on = (e: Event) => { if ((e as CustomEvent).detail?.id === id) done(); };
    const t = setTimeout(() => done(), ms);
    function done() { clearTimeout(t); window.removeEventListener("joyride:landed", on); resolve(); }
    window.addEventListener("joyride:landed", on);
  });
}
/** A moment's glow on the place the item landed in: its group's name, its idea, or the hub. */
function glow(card: HTMLElement) {
  card.dataset.settled = "";
  setTimeout(() => { delete card.dataset.settled; }, 1200);
  const place = card.closest<HTMLElement>(".map-node");
  if (!place) return;
  delete place.dataset.landed;
  void place.offsetWidth;
  place.dataset.landed = "";
  setTimeout(() => { delete place.dataset.landed; }, 1800);
}

export function LandingGhost({ g }: { g: Ghost }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"lift" | "fly" | "away">("lift");
  const id = g.saved!;
  const land = g.landing!;
  const where = placeName(land.place);

  useLayoutEffect(() => { setArriving(id, true); return () => setArriving(id, false); }, [id]);

  useEffect(() => {
    let live = true;
    const alive = () => live;
    const el = ref.current!;
    const remove = () => { if (live) ghostStore.remove(g.id); };
    // Whatever happens to the flight (a stalled frame, an error, a chart that never draws the card), the ghost
    // goes: nothing stays behind.
    const dog = setTimeout(() => { setArriving(id, false); remove(); }, WATCHDOG_MS);
    (async () => {
      if (!reduceMotion()) await el.animate([{ opacity: 0, transform: "translateY(6px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" }).finished.catch(() => {});
      const onMap = parse().name === "map" && !!document.querySelector(".map-viewport");
      let card = onMap ? await cardOf(id, 2500, alive) : null;
      if (!live) return;
      if (card && !inView(card)) {
        // Off screen: the chart glides to it (quietly: the arrival is the mark), then the card flies.
        revealOnMap({ kind: "item", id, quiet: true });
        await landed(id, 2200);
        card = await cardOf(id, 600, alive);
      }
      if (!live) return;
      if (!card) {
        setState("away");
        await sleep(1100);
        if (!live) return;
        if (!reduceMotion()) await el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(4px) scale(.96)" }], { duration: 260, easing: "ease-in", fill: "forwards" }).finished.catch(() => {});
        setArriving(id, false);
        return remove();
      }
      setState("fly");
      if (reduceMotion()) { setArriving(id, false); glow(card); return remove(); }
      // Each frame aims at where the card is now, so a chart that re-packs or glides under the flight is
      // still met exactly. A shallow arc: up and over, then down into the card, dissolving as the card takes
      // its place. One scale, so the words shrink evenly into the card (or chip) rather than squash.
      const from = el.getBoundingClientRect();
      const first = card.getBoundingClientRect();
      const ms = Math.min(820, 480 + Math.hypot(first.left - from.left, first.top - from.top) * 0.18);
      const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      let shown = false;
      await new Promise<void>((resolve) => {
        const t0 = performance.now();
        let over = false;
        const done = () => { if (!over) { over = true; resolve(); } };
        // Frames can stall (a busy or hidden tab): the flight still ends on time.
        setTimeout(done, ms + 300);
        const step = (now: number) => {
          if (over) return;
          try {
            if (!live || !card!.isConnected) { done(); return; }
            const t = Math.min(1, Math.max(0, (now - t0) / ms)), e = ease(t);
            const to = card!.getBoundingClientRect();
            const dx = (to.left - from.left) * e, dy = (to.top - from.top) * e;
            const k = 1 + (Math.max(0.3, Math.min(1.4, to.width / Math.max(1, from.width))) - 1) * e;
            const lift = Math.sin(Math.PI * e) * Math.min(56, Math.abs(to.left - from.left) * 0.08 + 16);
            el.style.transform = `translate(${dx}px, ${dy - lift}px) scale(${k})`;
            el.style.opacity = String(t < 0.62 ? 1 : Math.max(0, 1 - (t - 0.62) / 0.38));
            // The real card fades in under the ghost as it arrives.
            if (!shown && t > 0.6) { shown = true; setArriving(id, false); }
            if (t < 1) requestAnimationFrame(step); else done();
          } catch { done(); }
        };
        requestAnimationFrame(step);
      });
      if (!live) return;
      setArriving(id, false);
      if (card.isConnected) glow(card);
      remove();
    })().catch(() => {}).finally(() => { setArriving(id, false); remove(); });
    return () => { live = false; clearTimeout(dog); };
  }, []);

  const kind = itemKind(land.bullets);
  // The label already says the first line; the lines under it are the rest.
  const all = parseBlocks(land.bullets);
  const blocks = (all[0]?.kind === "text" && land.label.startsWith(all[0].text.slice(0, 40)) ? all.slice(1) : all).slice(0, 4);
  const link = kind === "link" && blocks.length === 1 && blocks[0].kind === "link" ? blocks[0].link : null;
  const f = g.from;
  const style = f ? { left: Math.max(8, Math.min(f.x, window.innerWidth - 328)), top: f.y, width: Math.max(240, Math.min(320, f.w)) } : { right: 24, bottom: 24, width: 300 };
  return (
    <div ref={ref} className={`landing-ghost lg-${state} bk-${kind}`} style={style} data-landing-ghost={id} role="status" aria-label={`${kind === "list" ? "List" : kind === "link" ? "Link" : "Note"} saved in ${where}`}>
      <div className="lg-head">
        <span className="lg-glyph" aria-hidden>{link ? <LinkGlyph link={link} /> : KIND_GLYPH[kind]}</span>
        <span className="lg-label">{land.label}</span>
      </div>
      {!link && blocks.length ? (
        <ul className="lg-lines">
          {blocks.map((b, i) => (
            <li key={i} className={`lg-${b.kind}${b.kind === "todo" && b.done ? " done" : ""}`}>
              {b.kind === "todo" ? <span className="lg-box" aria-hidden /> : b.kind === "link" ? <LinkGlyph link={b.link} /> : null}
              <span>{b.kind === "link" ? b.link.title : b.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="lg-where">{state === "away" ? <>Saved in <b>{where}</b></> : <>To <b>{where}</b></>}</div>
    </div>
  );
}
