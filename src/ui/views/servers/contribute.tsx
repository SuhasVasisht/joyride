import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { ServersPage } from "./ServersPage";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "servers", component: ServersPage }],
    nav: [{ id: "servers", title: "Servers", href: "#/servers", order: 15 }],
    commands: () => [{ id: "go-servers", title: "Go to servers", group: "Navigate", keywords: "review preview backend frontend terminals processes", run: () => go("servers") }],
  };
}
