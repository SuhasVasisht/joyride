import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { api } from "../../lib/api";
import { MapView } from "./MapView";
import { getArchive, requestZoom, toggleArchive } from "./prefs";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "map", component: MapView }],
    nav: [{ id: "map", title: "Map", href: "#/map", order: 0 }],
    commands: async () => {
      const base = [
        { id: "go-map", title: "Go to map", run: () => go("map"), group: "Navigate", keywords: "home chart" },
        { id: "map-archive", title: getArchive() ? "Hide archived ideas on the map" : "Show archived ideas on the map", run: () => toggleArchive(false), group: "Map", keywords: "toggle archive" },
        { id: "map-fit", title: "Fit the map to everything", run: () => { go("map"); setTimeout(() => requestZoom("fit"), 0); }, group: "Map", keywords: "zoom reset" },
        { id: "map-far", title: "Zoom map out to idea titles", hint: "Far", run: () => { go("map"); setTimeout(() => requestZoom("far"), 0); }, group: "Map", keywords: "zoom far" },
        { id: "map-near", title: "Zoom map in to worker detail", hint: "Near", run: () => { go("map"); setTimeout(() => requestZoom("near"), 0); }, group: "Map", keywords: "zoom near" },
        { id: "toggle-rail", title: "Toggle the attention rail", hint: "\\", run: () => { window.dispatchEvent(new CustomEvent("joyride:toggle-rail")); }, group: "View", keywords: "rail sidebar hide show" },
      ];
      let missions: { id: string; title: string; archive: boolean; health: string }[] = [];
      try { missions = await api("/api/missions"); } catch { /* daemon down: navigation commands only */ }
      return [
        ...base,
        ...missions.map((m) => ({
          id: `mission:${m.id}`, title: m.title, hint: m.archive ? "Archived idea" : "Idea", group: "Ideas", keywords: `idea ${m.id} ${m.health}`,
          run: () => go(`mission/${encodeURIComponent(m.id)}`),
        })),
      ];
    },
  };
}
