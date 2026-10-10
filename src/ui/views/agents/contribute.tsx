import { useEffect } from "react";
import type { Contribution } from "../../lib/registry";
import { useApi } from "../../lib/api";
import { go, type Route } from "../../lib/router";
import type { MissionProposal } from "../../lib/types";
import { AgentsPage } from "./AgentsPage";
import { filterPath, legacyTarget } from "./model";

/** #/fleet, #/proposals and #/view moved onto the Agents page. Replace, so Back never lands on the redirect again. */
export function LegacyRedirect({ route }: { route: Route }) {
  useEffect(() => { location.replace(`#/${legacyTarget(route) ?? "agents"}`); }, [route]);
  return null;
}

/** Suggested ideas waiting on the Agents page (the old Proposals count). */
function AgentsBadge() {
  const { data } = useApi<MissionProposal[]>("/api/missions/proposals", ["proposals"]);
  const n = (data ?? []).filter((p) => (p.status ?? "pending") === "pending").length;
  return n ? <span className="nav-badge" aria-label={`${n} suggested ideas`} title={`${n} suggested ideas to review`}>{n}</span> : null;
}

export default function contribute(): Contribution {
  return {
    routes: [
      { name: "agents", component: AgentsPage },
      { name: "fleet", component: LegacyRedirect },
      { name: "proposals", component: LegacyRedirect },
      ...["view", "views", "evolve", "hillclimb", "capabilities", "learnings"].map((name) => ({ name, component: LegacyRedirect })),
    ],
    nav: [{ id: "agents", title: "Agents", href: "#/agents", order: 10, badge: AgentsBadge }],
    commands: () => [
        { id: "go-agents", title: "Go to agents", group: "Navigate", keywords: "agents sessions fleet crew watched yours proposals views roster", run: () => go("agents") },
        { id: "agents-needs-you", title: "Agents that need you", group: "Agents", keywords: "blocked waiting needs you prompt fleet", run: () => go(filterPath({ show: "needs-you" })) },
        { id: "agents-your-helm", title: "Agents at your helm", group: "Agents", keywords: "helm steering captain fleet", run: () => go(filterPath({ show: "your-helm" })) },
        { id: "agents-crew", title: "Firstmate's crew", group: "Agents", keywords: "crew firstmate tasks backlog crews", run: () => go(filterPath({ owner: "crew" })) },
        { id: "agents-yours", title: "Your own sessions", group: "Agents", keywords: "yours watched kept to myself sessions", run: () => go(filterPath({ owner: "yours" })) },
        { id: "agents-running", title: "Agents running now", group: "Agents", keywords: "running working live", run: () => go(filterPath({ state: "running" })) },
        { id: "agents-done", title: "Finished agents and closed sessions", group: "Agents", keywords: "done closed finished sessions history", run: () => go(filterPath({ state: "done" })) },
        { id: "agents-suggested", title: "Suggested ideas", group: "Agents", keywords: "proposals triage backfill suggested ideas file", run: () => go(filterPath({ show: "suggested" })) },
    ],
  };
}
