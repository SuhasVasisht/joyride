import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { KnowledgePage } from "./KnowledgePage";
import { LegacyRedirect } from "./Redirect";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "knowledge", component: KnowledgePage }, { name: "memory", component: LegacyRedirect }],
    nav: [
      { id: "knowledge", title: "Search", href: "#/knowledge", order: 40 },
      { id: "artifacts", title: "Artifacts", href: "#/knowledge/artifacts", order: 41 },
    ],
    commands: () => [
      { id: "go-knowledge", title: "Search ideas and sources", group: "Navigate", keywords: "ideas notes artifacts sessions tasks search", run: () => go("knowledge") },
      { id: "knowledge-artifacts", title: "Browse artifacts", group: "Search", keywords: "reports pages claude firstmate newest", run: () => go("knowledge/artifacts") },
      { id: "knowledge-sessions", title: "Find a saved session", group: "Search", keywords: "resume command preserved session record", run: () => go("knowledge?types=sessions") },
    ],
  };
}
