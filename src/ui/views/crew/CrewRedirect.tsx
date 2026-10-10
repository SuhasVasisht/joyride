// #/crew/<id> is a task's sheet over the map; #/crew alone is the crew on the Agents page.
// Replace, so Back never lands on the redirect again.
import { useEffect } from "react";
import type { Route } from "../../lib/router";
import { filterPath } from "../agents/model";

export const crewTarget = (route: Pick<Route, "params" | "query">) => {
  const id = route.params[0];
  if (!id) return `#/${filterPath({ owner: "crew" })}`;
  const qs = route.query.toString();
  return `#/task/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`;
};

export function CrewRedirect({ route }: { route: Route }) {
  useEffect(() => { location.replace(crewTarget(route)); }, [route]);
  return null;
}
