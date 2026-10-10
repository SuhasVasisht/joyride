// Mounts the CP6 nudges: the tray in the rail, an idea's nudges on its island ("Still want this?" with
// Keep, Pause or Drop), and the "Tidied" toasts over the map. The components live in components/nudges.
//   map, mid zoom: one line per nudge;  near zoom: each nudge answered in place.
import type { Contribution } from "../../lib/registry";
import type { Ask } from "../../../shared/asks";
import { NudgeCard, NudgeTray, TidiedToasts, nudgesOn, useNudges } from "../../components/nudges";
import "../../components/nudges/nudges.css";
import type { ZoomLevel } from "../map/layout";
import { AskBadge, AskCard } from "../map/AskCard";
import { registerMapSlot, type SlotProps } from "../map/slots";

/** CP6's nudges pinned to this idea, plus the attention nudges the asks projection placed on it. */
function IdeaNudges({ mission, asks, level }: { mission: string; asks: Ask[]; level: ZoomLevel }) {
  const { data } = useNudges();
  const list = nudgesOn(data?.nudges, "idea", mission);
  if (level === "far" || (!list.length && !asks.length)) return null;
  if (level === "mid") {
    return (
      <div className="map-nudges mid">
        {list.map((n) => <span key={n.id} className="nd-badge" data-nudge={n.id} title={n.why}><span aria-hidden>◌</span> {n.title}</span>)}
        {asks.map((a) => <AskBadge key={a.id} ask={a} />)}
      </div>
    );
  }
  return (
    <div className="map-nudges" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {list.length ? <ul className="nd-list">{list.map((n) => <NudgeCard key={n.id} n={n} />)}</ul> : null}
      {asks.map((a) => <AskCard key={a.id} ask={a} folded />)}
    </div>
  );
}

function MapToasts({ focused }: SlotProps["map-overlay"]) {
  return <TidiedToasts inline={focused} />;
}

registerMapSlot("idea-nudges", IdeaNudges);
registerMapSlot("map-overlay", MapToasts);

export default function contribute(): Contribution {
  return { rail: [{ id: "nudges", order: 25, component: NudgeTray }] };
}
