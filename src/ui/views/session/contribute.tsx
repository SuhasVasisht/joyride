import type { Contribution } from "../../lib/registry";
import { api, cleanTitle, repoLabel, timeAgo } from "../../lib/api";
import { go } from "../../lib/router";
import type { SessionView } from "../../lib/types";
import { SessionRoute } from "./SessionPane";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "session", component: SessionRoute, overlay: true }],
    commands: async () => {
      let sessions: SessionView[] = [];
      try { sessions = await api<SessionView[]>("/api/sessions?limit=150"); } catch { return []; }
      return sessions.map((s) => ({
        id: `session:${s.key}`, title: cleanTitle(s.title || s.first_prompt, s.key), hint: `Session in ${repoLabel(s.repo)}, ${timeAgo(s.updated)}`, group: "Sessions",
        keywords: `session ${s.source} ${s.cwd} ${s.branch ?? ""}`, run: () => go(`session/${encodeURIComponent(s.key)}`),
      }));
    },
  };
}
