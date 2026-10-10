// Control plane CP6 components, ready for the map to mount:
//   <NudgeTray/>              the rail section (mounted from views/nudges/contribute.tsx)
//   <NudgeCard n/>            one nudge, answered in place; use nudgesOn(list, "task", id) to pin them to a card
//   <TidiedToasts/>    "Tidied" toasts with Undo
//   <IdeaBrief idea/>         an idea's headline, now and next
//   <Pulse value/>, usePulse  a card pulses once when its state changes
//   <Morph deps/>, useMorph   FLIP for [data-morph-id] children when ideas and groups change
export { NudgeTray } from "./NudgeTray";
export { NudgeCard } from "./NudgeCard";
export { TidiedToasts } from "./Toasts";
export { IdeaBrief, IdeaBriefView } from "./IdeaBrief";
export { Pulse, usePulse, Morph, useMorph } from "./motion";
export { useNudges, useIdeaBrief, useIdeaBriefs, actOn, sendFeedback, nudgesOn } from "./api";
