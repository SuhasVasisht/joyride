import type { NewReceipt } from "../../../shared/freeform";
import { revealOnMap } from "../map/reveal";

export function animateResult(r: NewReceipt) {
  if (r.state === "failed" || r.state === "undone") return;
  if (r.landing && document.querySelector(".map-viewport") && ["note", "list", "link", "move", "group", "idea", "agent"].includes(r.animation)) {
    const e = r.landing;
    if (e.kind === "note") revealOnMap({ kind: "item", id: e.id, board: e.scope, zoom: "mid" });
    else if (e.kind === "idea") revealOnMap({ kind: "idea", id: e.id });
    else if (e.kind === "group") revealOnMap({ kind: "region", id: `lens:${e.id}` });
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const mark = () => {
    const landing = r.landing;
    const el = landing?.kind === "note" ? document.querySelector<HTMLElement>(`[data-board-item="${CSS.escape(landing.id)}"]`)
      : landing?.kind === "idea" ? document.querySelector<HTMLElement>(`[data-mission="${CSS.escape(landing.id)}"]`)
      : landing?.kind === "group" ? document.querySelector<HTMLElement>(`[data-region="lens:${CSS.escape(landing.id)}"]`) : null;
    if (!el) return false;
    el.dataset.newAnimation = r.animation;
    setTimeout(() => { delete el.dataset.newAnimation; }, 850);
    return true;
  };
  if (!mark()) {
    const watcher = new MutationObserver(() => { if (mark()) watcher.disconnect(); });
    watcher.observe(document.querySelector(".main") ?? document.body, { subtree: true, childList: true });
    setTimeout(() => watcher.disconnect(), 6000);
  }
  if (r.animation === "firstmate") {
    const from = document.querySelector(".nb-input")?.getBoundingClientRect();
    const to = document.querySelector('[data-testid="firstmate-node"]')?.getBoundingClientRect();
    if (!from || !to) return;
    const card = document.createElement("span"); card.className = "nb-flight"; card.textContent = "Sent to Firstmate";
    card.style.left = `${from.left}px`; card.style.top = `${from.top}px`; document.body.append(card);
    const a = card.animate([{ opacity: .8, transform: "translate(0,0) scale(1)" }, { opacity: 0, transform: `translate(${to.left - from.left}px,${to.top - from.top}px) scale(.65)` }], { duration: 700, easing: "cubic-bezier(.2,.7,.2,1)" });
    a.finished.finally(() => card.remove());
  }
}
