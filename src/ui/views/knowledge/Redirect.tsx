import { useEffect } from "react";
import { href, type Route } from "../../lib/router";
import { legacyTarget } from "./model";

export function LegacyRedirect({ route }: { route: Route }) {
  const target = legacyTarget(route.name, route.params, route.query);
  useEffect(() => { location.replace(href(target)); }, [target]);
  return <div className="k-page"><p className="k-skeleton">Opening Search…</p></div>;
}
