// Board items (notes, lists, links) wherever the captain looks: a mission panel on the idea page, the map's
// hub (Unfiled), groups, ideas, tasks and workers, and the task sheet. The components live in components/notes.
//   map, hub, groups and ideas: a board (chips at far, compact cards at mid, editable cards at near), and a "+"
//     that opens New on that place.
//   map, tasks and workers: mid zoom a ✎ count; near zoom the chips and an "Add note" button.
import type { ReactNode } from "react";
import type { Contribution } from "../../lib/registry";
import { MapBoard, NoteCount, NotesBlock } from "../../components/notes/NotesBlock";
import type { NoteAnchor } from "../../components/notes/notes";
import { openComposer } from "../../components/compose/ghost";
import type { ZoomLevel } from "../map/layout";
import { registerMapSlot } from "../map/slots";
import type { MissionH } from "../map/world";

function IdeaNotesPanel({ mission }: { mission: MissionH; missionId: string }) {
  return <NotesBlock anchor={{ kind: "mission", id: mission.id }} place="this idea" />;
}

/**
 * Typing or clicking in a note never opens the card under it or starts a pan. A card's grip (and its Move to…)
 * is the exception: the chart picks those up to carry the card or open Move to.
 */
function OnMap({ children, kind }: { children: ReactNode; kind: string }) {
  const own = (e: React.SyntheticEvent) => { if (!(e.target as HTMLElement).closest("[data-drag-handle]")) e.stopPropagation(); };
  return <div className={`map-notes mn-${kind}`} onClick={own} onPointerDown={own}>{children}</div>;
}

function MapNotes({ anchor, place, level, kind }: { anchor: NoteAnchor; place: string; level: ZoomLevel; kind: string }) {
  if (level === "far") return null;
  if (level === "mid") return <NoteCount anchor={anchor} />;
  return <OnMap kind={kind}><NotesBlock anchor={anchor} place={place} variant="strip" /></OnMap>;
}

/** A group's "+": New, on this group's board. */
function GroupAdd({ group, title }: { group: string; title: string; level: ZoomLevel }) {
  return (
    <button type="button" className="rl-add" data-group-add={group} aria-label={`Add a note, list or link to ${title}`} title={`Add a note, list or link to ${title}`}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); openComposer({ board: { kind: "group", id: group, title } }); }}>+</button>
  );
}

registerMapSlot("hub-notes", ({ level }) => (
  <OnMap kind="hub"><MapBoard scope="global" place="the hub" level={level} /></OnMap>
));
registerMapSlot("group-head", GroupAdd);
registerMapSlot("group-board", ({ group, title, level }) => (
  <OnMap kind="group"><MapBoard scope={`group:${group}`} place={title} level={level} /></OnMap>
));
registerMapSlot("idea-notes", ({ mission, level }) => <OnMap kind="idea"><MapBoard scope={`mission:${mission}`} place="this idea" level={level} composer={false} /></OnMap>);
registerMapSlot("task-notes", ({ task, level }) => <MapNotes anchor={{ kind: "task", id: task }} place="this task" level={level} kind="task" />);
registerMapSlot("worker-notes", ({ session, level }) => (session ? <MapNotes anchor={{ kind: "session", id: session }} place="this agent" level={level} kind="worker" /> : null));
registerMapSlot("task-sheet", ({ task, mission }) => (
  <section className="ts-notes" aria-label="Notes on this task">
    <NotesBlock anchor={{ kind: "task", id: task }} place="this task" variant="strip" also={mission ? { anchor: { kind: "mission", id: mission }, label: "From its idea" } : null} />
  </section>
));

export default function contribute(): Contribution {
  return {
    missionPanels: [{ id: "notes", title: "Notes", order: 15, component: IdeaNotesPanel }],
  };
}
