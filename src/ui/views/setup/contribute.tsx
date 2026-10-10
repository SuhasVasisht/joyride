import "./setup.css";
import type { Contribution } from "../../lib/registry";
import { api } from "../../lib/api";
import { go, type Route } from "../../lib/router";
import { SetupPage } from "./SetupPage";
import type { SetupReport } from "./useSetup";

// A new user lands on the setup page first: when the app opens on the map while something
// required is missing and the page has never been opened (the daemon decides; never in tests).
if (typeof window !== "undefined") {
  const here = () => location.hash.replace(/^#\/?/, "") || "map";
  if (here() === "map") api<SetupReport>("/api/system/setup").then((r) => { if (r?.land && here() === "map") go("setup"); }).catch(() => {});
}

const SetupRoute = ({ route }: { route: Route }) => <SetupPage route={route} />;

export default function contribute(): Contribution {
  return {
    routes: [{ name: "setup", component: SetupRoute }],
    nav: [{ id: "setup", title: "Set up", href: "#/setup", order: 105, secondary: true }],
    commands: () => [
      { id: "setup", title: "Set up Joyride", group: "Help", keywords: "setup install onboarding check firstmate herdr hooks github gh login tools treehouse missing", run: () => go("setup") },
    ],
  };
}
