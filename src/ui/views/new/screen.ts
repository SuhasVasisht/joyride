import { ScreenElement, type ScreenContext } from "../../../shared/freeform";
import { parse } from "../../lib/router";
import { loadView } from "../map/prefs";
import { currentGroup } from "../map/current";

let hovered: ScreenContext["hovered"] = null;
let selected: ScreenContext["selected"] = null;
export function screenView(): ScreenContext["view"] {
  const vp = document.querySelector<HTMLElement>(".map-viewport");
  if (vp) {
    const s = Number(vp.style.getPropertyValue("--s")), tx = Number(vp.style.getPropertyValue("--tx")), ty = Number(vp.style.getPropertyValue("--ty"));
    if (s > 0 && [s, tx, ty].every(Number.isFinite)) return { s, tx, ty };
  }
  return loadView();
}
function element(node: Element | null): ScreenContext["hovered"] {
  const el = node?.closest<HTMLElement>("[data-board-item], [data-ask], [data-worker], [data-task], [data-session], [data-mission], .region-label[data-region], [data-attention], [data-artifact]");
  if (!el || el.closest(".new-box")) return null;
  const d = el.dataset;
  const kind = d.boardItem ? "note" : d.ask ? "ask" : d.worker ? "worker" : d.task ? "task" : d.session ? "session" : d.mission ? "idea" : d.attention ? "attention" : d.artifact ? "artifact" : d.regionCwd ? "project" : "group";
  const id = d.boardItem ?? d.ask ?? d.worker ?? d.task ?? d.session ?? d.mission ?? d.attention ?? d.artifact ?? d.regionCwd ?? d.region?.replace(/^lens:/, "");
  const title = el.querySelector("h1,h2,h3,.rl-title,.mn-title,.wn-title,.nk-title,a")?.textContent?.trim() || el.getAttribute("aria-label") || id;
  const control = node?.closest("button,label,li,[role=tab],input");
  const detail = control && el.contains(control) ? (control.getAttribute("aria-label") || control.textContent || "").trim().slice(0, 2000) : undefined;
  const r = ScreenElement.safeParse({ kind, id, title, detail });
  return r.success ? r.data : null;
}
export function trackScreen() {
  const point = (e: PointerEvent) => { if (e.target instanceof Element && !e.target.closest(".rail")) { const ref = element(e.target); if (ref) hovered = ref; } };
  const select = (e: Event) => { if (e.target instanceof Element && !e.target.closest(".rail")) { const ref = element(e.target); if (ref) selected = ref; } };
  // Map controls stop bubbling to avoid dragging the chart. Capture the user's target first.
  window.addEventListener("pointerover", point, true); window.addEventListener("click", select, true); window.addEventListener("focusin", select, true);
  return () => { window.removeEventListener("pointerover", point, true); window.removeEventListener("click", select, true); window.removeEventListener("focusin", select, true); };
}
export function captureScreen(place: ScreenContext["place"]): ScreenContext {
  const route = parse(), vp = document.querySelector<HTMLElement>(".map-viewport"), group = currentGroup();
  const focused = route.name === "mission" && route.params[0] ? { kind: "idea", id: route.params[0], title: document.querySelector(".mission-page h1")?.textContent ?? route.params[0] }
    : vp?.dataset.focusIdea ? { kind: "idea", id: vp.dataset.focusIdea, title: vp.dataset.focusIdea }
    : vp?.dataset.focus ? element(document.querySelector(`.region-label[data-region="${CSS.escape(vp.dataset.focus)}"]`))
    : group ? { kind: "group", ...group } : null;
  const validFocus = ScreenElement.safeParse(focused), visible = new Map<string, ScreenElement>();
  document.querySelectorAll<HTMLElement>(".main [data-mission], .main [data-worker], .main [data-task], .main [data-session], .main [data-board-item], .main .region-label[data-region], .main [data-ask]").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || el.closest("[data-camera-hidden]")) return;
    const ref = element(el); if (ref && visible.size < 500) visible.set(`${ref.kind}:${ref.id}`, ref);
  });
  return { route: route.raw || "map", view: screenView(), place, focused: validFocus.success ? validFocus.data : null, hovered, selected, visible: [...visible.values()] };
}
