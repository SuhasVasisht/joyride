// Mounts the ghost cards (control plane CP5) and the map's "+ Add to this idea", which opens New (views/new)
// on that idea. A ghost flies to where its request lands on the chart: the task it became, else its idea, else the tray.
// A note or list flies to its card on the chart once saved, else to the idea or the hub it is saved on.
// The ghost tray and the hook-up points for other surfaces live in components/compose.
import { useEffect } from "react";
import type { Contribution } from "../../lib/registry";
import { ComposeHost } from "../../components/compose/ComposeHost";
import { ghostStore, openComposer, registerGhostTarget, useGhosts, type Ghost, type Target } from "../../components/compose/ghost";
import type { ZoomLevel } from "../map/layout";
import { registerMapSlot } from "../map/slots";

/** Room the ghost card needs under its anchor. */
const ROOM = 150;
/** The first of these on the chart that is on screen with room under it; otherwise the ghost waits in the tray. */
function onChart(...selectors: string[]): DOMRect | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(`.map-viewport ${sel}`);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const vp = el.closest(".map-viewport")!.getBoundingClientRect();
    if (r.width > 0 && r.bottom > vp.top && r.bottom + ROOM < vp.bottom && r.right > vp.left && r.left < vp.right) return r;
  }
  return null;
}

export function chartTarget(t: Target | undefined, g: Ghost): DOMRect | null {
  const esc = (s: string) => CSS.escape(s);
  if (g.as === "note" || g.as === "list") {
    if (g.saved) { const r = onChart(`[data-note-card="${esc(g.saved)}"]`); if (r) return r; }
    return g.idea ? onChart(`.mission-node[data-mission="${esc(g.idea)}"] .mn-head`) : onChart(".fm-node .fm-head");
  }
  if (!t) return null;
  const task = g.progress?.task?.id ?? (t.kind === "task" ? t.id : null);
  if (task) { const r = onChart(`[data-task="${esc(task)}"]`); if (r) return r; }
  const idea = g.progress?.task?.mission ?? g.mission?.id ?? (t.kind === "idea" ? t.id : t.kind === "task" ? t.idea : null);
  // Under the idea's title row, else under its "+ Add to this idea": an island at near zoom is taller than the screen.
  const node = `.mission-node[data-mission="${esc(idea ?? "")}"]`;
  return idea ? onChart(`${node} .mn-head`, `${node} [data-compose]`) : null;
}

/** Anchored ghosts follow the chart while it pans and zooms (the map writes its transform to the viewport's style). */
function GhostFollow() {
  const ghosts = useGhosts();
  const any = ghosts.length > 0;
  useEffect(() => {
    const vp = document.querySelector(".map-viewport");
    if (!any || !vp) return;
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; const g = ghostStore.list()[0]; if (g) ghostStore.update(g.id, {}); });
    });
    mo.observe(vp, { attributes: true, attributeFilter: ["style", "data-zoom"] });
    return () => { mo.disconnect(); cancelAnimationFrame(frame); };
  }, [any]);
  return null;
}

function IdeaComposer({ mission, level }: { mission: string; level: ZoomLevel }) {
  if (level !== "near") return null;
  return (
    <button type="button" className="rl-add map-compose idea" data-compose={mission} onClick={(e) => { e.stopPropagation(); openComposer({ idea: mission }); }}
      aria-label="Add to this idea" title="Add work, a note, a list or a link to this idea">
      <span aria-hidden>+</span>
    </button>
  );
}

registerMapSlot("idea-composer", IdeaComposer);
registerMapSlot("map-overlay", GhostFollow);
registerGhostTarget(chartTarget);

export default function contribute(): Contribution {
  return {
    global: [ComposeHost],
  };
}
