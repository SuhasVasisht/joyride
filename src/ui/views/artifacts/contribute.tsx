import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { LegacyRedirect } from "../knowledge/Redirect";
import { ArtifactOverlay } from "./ArtifactOverlay";
import { ArtifactsPanel } from "./ArtifactsPanel";

export default function contribute(): Contribution {
  return {
    // Artifacts live in Knowledge now; #/artifacts/... redirects to the matching view.
    global: [ArtifactOverlay],
    routes: [{ name: "artifacts", component: LegacyRedirect }],
    missionPanels: [{ id: "artifacts", title: "Artifacts", order: 70, component: ArtifactsPanel }],
    commands: () => [
      { id: "go-artifacts", title: "Go to artifacts", group: "Navigate", keywords: "pages reports pull requests claude chatgpt", run: () => go("knowledge/artifacts") },
      { id: "register-artifact", title: "Register an artifact", group: "Artifacts", keywords: "add link pr report page", run: () => go(`knowledge?register=1&t=${Date.now()}`) },
    ],
  };
}
