import "./start.css";
import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { Sheet } from "../../components/Sheet";
import type { Route } from "../../lib/router";
import { GuidePage, GuideRail } from "./Guide";
import { StartSessionRoute } from "./StartSession";

const GuideRoute = (_: { route: Route }) => <Sheet label="How to use Joyride"><GuidePage /></Sheet>;
const StartRoute = ({ route }: { route: Route }) => <Sheet label="Start a session"><StartSessionRoute route={route} /></Sheet>;

export default function contribute(): Contribution {
  return {
    routes: [{ name: "start", component: GuideRoute, overlay: true }, { name: "start-session", component: StartRoute, overlay: true }],
    rail: [{ id: "start", order: 0, component: GuideRail }],
    nav: [{ id: "start", title: "How to use", href: "#/start", order: 110, secondary: true }],
    commands: () => [
      { id: "guide", title: "How to use Joyride", group: "Help", keywords: "help guide start onboarding tutorial", run: () => go("start") },
      { id: "start-session", title: "Start a session in Herdr", group: "Agents", keywords: "new launch claude codex herdr agent", run: () => go("start-session") },
    ],
  };
}
