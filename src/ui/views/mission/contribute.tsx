import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { MissionRoute } from "./MissionPage";
import { NewMissionRoute } from "./NewMission";
import { DependenciesPanel, DoneWhenPanel, SessionsPanel, TimelinePanel, WorkersPanel } from "./panels";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "mission", component: MissionRoute, overlay: true }, { name: "new-mission", component: NewMissionRoute, overlay: true }],
    commands: () => [
      { id: "new-mission", title: "New idea", group: "Ideas", keywords: "create start add idea goal done when", run: () => go("new-mission") },
    ],
    missionPanels: [
      { id: "done_when", title: "Done when", order: 10, component: DoneWhenPanel },
      { id: "workers", title: "Workers", order: 20, component: WorkersPanel },
      { id: "sessions", title: "Sessions", order: 50, component: SessionsPanel },
      { id: "timeline", title: "Timeline", order: 80, component: TimelinePanel },
      { id: "dependencies", title: "Dependencies", order: 90, component: DependenciesPanel },
    ],
  };
}
