import type { Contribution } from "../../lib/registry";
import { api, repoLabel } from "../../lib/api";
import { go } from "../../lib/router";
import type { WorkerView } from "../../lib/types";
import { WorkerRoute } from "./WorkerPane";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "worker", component: WorkerRoute, overlay: true }],
    commands: async () => {
      let workers: WorkerView[] = [];
      try { workers = await api<WorkerView[]>("/api/workers"); } catch { return []; }
      return workers.map((w) => ({
        id: `worker:${w.id}`, title: w.title || w.id, hint: `${w.status} worker in ${repoLabel(w.repo ?? w.cwd)}`, group: "Workers",
        keywords: `worker ${w.agent} ${w.status} ${w.cwd} ${w.id}`, run: () => go(`worker/${encodeURIComponent(w.id)}`),
      }));
    },
  };
}
