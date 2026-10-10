import type { Contribution } from "../../lib/registry";
import { go } from "../../lib/router";
import { SettingsPage } from "./SettingsPage";

export default function contribute(): Contribution {
  return {
    routes: [{ name: "settings", component: SettingsPage }],
    nav: [{ id: "settings", title: "Settings", href: "#/settings", order: 100, secondary: true }],
    commands: () => [
      { id: "go-settings", title: "Open settings", group: "Navigate", keywords: "config models jev llm backend notifications guard components metrics", run: () => go("settings") },
      { id: "settings-models", title: "Change the heavy model per task", group: "Settings", keywords: "claude codex haiku sonnet backend llm", run: () => { go("settings"); setTimeout(() => document.getElementById("settings-models")?.scrollIntoView(), 50); } },
      { id: "settings-notify", title: "Notification settings", group: "Settings", keywords: "macos notify level test", run: () => { go("settings"); setTimeout(() => document.getElementById("settings-notifications")?.scrollIntoView(), 50); } },
    ],
  };
}
