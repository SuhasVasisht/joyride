import "./usage.css";
import type { Contribution } from "../../lib/registry";
import { go, type Route } from "../../lib/router";
import { Sheet } from "../../components/Sheet";
import { UsagePage, UsageRail } from "./UsagePanel";

const UsageRoute = (_: { route: Route }) => <Sheet label="Usage limits"><UsagePage /></Sheet>;

export default function contribute(): Contribution {
  return {
    routes: [{ name: "usage", component: UsageRoute, overlay: true }],
    rail: [{ id: "usage", order: 15, component: UsageRail }],
    nav: [{ id: "usage", title: "Usage", href: "#/usage", order: 50 }],
    commands: () => [
      { id: "usage", title: "Show usage limits", group: "Agents", keywords: "usage quota limit five-hour 5h weekly reset claude codex cursor subscription account", run: () => go("usage") },
    ],
  };
}
