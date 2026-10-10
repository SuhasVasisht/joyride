import type { Contribution } from "../../lib/registry";
import { api, post } from "../../lib/api";
import { go } from "../../lib/router";
import { CrewRedirect } from "./CrewRedirect";
import { CrewPanel } from "./crew";
import { FirstmateRail } from "./FirstmateRail";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "crew", component: CrewRedirect, overlay: true }],
    missionPanels: [{ id: "crew", title: "Crew", order: 30, component: CrewPanel }],
    rail: [{ id: "firstmate", order: 14, component: FirstmateRail }],
    commands: () => [
      {
        id: "open-firstmate", title: "Open Firstmate", group: "Crew", keywords: "firstmate control session chat terminal reply",
        run: async () => {
          const s = await api<{ pane: { worker: string } | null }>("/api/firstmate/status").catch(() => null);
          go(s?.pane ? `worker/${encodeURIComponent(s.pane.worker)}` : "map");
        },
      },
      { id: "start-firstmate", title: "Start Firstmate", group: "Crew", keywords: "firstmate orchestrator launch herdr pane", run: async () => { go("agents?owner=crew"); await post("/api/firstmate/start"); } },
    ],
  };
}
