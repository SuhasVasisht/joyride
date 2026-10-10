import { firstmateStatus } from "../../lib/firstmate-status";
import type { Contribution } from "../../lib/registry";
import { api } from "../../lib/api";
import { go } from "../../lib/router";
import type { CrewTask } from "../crew/crew";
import { TaskRoute } from "./TaskSheet";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "task", component: TaskRoute, overlay: true }],
    commands: async () => {
      let tasks: CrewTask[] = [];
      try { tasks = await api<CrewTask[]>("/api/firstmate/tasks"); } catch { return []; }
      return tasks.filter((t) => t.section !== "done").map((t) => ({
        id: `task:${t.id}`, title: t.title || t.id, hint: `${firstmateStatus(t.status).label} Firstmate task ${t.id}`, group: "Tasks",
        keywords: `task firstmate crew steer ${t.id} ${t.status}`, run: () => go(`task/${encodeURIComponent(t.id)}`),
      }));
    },
  };
}
