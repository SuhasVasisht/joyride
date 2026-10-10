import type { UiAction } from "../../../shared/freeform";
import { go } from "../../lib/router";
import { getArchive, setArchive, requestZoom, saveView } from "../map/prefs";
import { revealOnMap } from "../map/reveal";
import { z } from "zod";
import { screenView } from "./screen";
import { parse } from "../../lib/router";

export const BrowserState = z.object({ hash: z.string(), view: z.object({ s: z.number(), tx: z.number(), ty: z.number(), user: z.boolean().optional() }).nullable(), archive: z.boolean().nullable(), rail: z.boolean(), railScroll: z.number().default(0), tab: z.enum(["chat", "terminal", "context"]).nullable(), palette: z.boolean().default(false) });
export type BrowserState = z.infer<typeof BrowserState>;
export function browserState(): BrowserState {
  const tab = document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim().toLowerCase();
  const route = parse(), loadingTab = route.name === "worker" ? route.query.get("tab") === "terminal" ? "terminal" : route.query.get("tab") === "details" ? "context" : "chat" : null;
  return { hash: location.hash, view: screenView(), archive: getArchive(), rail: Boolean(document.querySelector(".rail:not([hidden])")), railScroll: document.querySelector(".rail")?.scrollTop ?? 0, palette: Boolean(document.querySelector(".palette-backdrop")), tab: tab === "terminal" ? "terminal" : tab === "context" || tab === "details" ? "context" : tab === "chat" ? "chat" : loadingTab };
}
export function restoreBrowser(state: BrowserState) {
  location.hash = state.hash;
  if (state.archive !== null) setArchive(state.archive);
  window.dispatchEvent(new CustomEvent(state.rail ? "joyride:open-rail" : "joyride:close-rail"));
  window.dispatchEvent(new CustomEvent("joyride:palette", { detail: state.palette }));
  if (state.view) saveView(state.view);
  setTimeout(() => {
    const rail = document.querySelector(".rail"); if (rail) rail.scrollTop = state.railScroll;
    if (state.view) window.dispatchEvent(new CustomEvent("joyride:map-view", { detail: state.view }));
    if (state.tab) window.dispatchEvent(new CustomEvent("joyride:worker-tab", { detail: state.tab }));
  }, 150);
}

export function applyUi(command: UiAction): () => void {
  const state = browserState(), { archive, rail } = state;
  const restore = () => restoreBrowser(state);
  switch (command.action) {
    case "navigate": go(command.path); return restore;
    case "zoom": go("map"); setTimeout(() => requestZoom(command.level), 150); return restore;
    case "archive": setArchive(command.show); return () => setArchive(archive ?? false);
    case "rail": window.dispatchEvent(new CustomEvent(command.show ? "joyride:open-rail" : "joyride:close-rail")); return () => window.dispatchEvent(new CustomEvent(rail ? "joyride:open-rail" : "joyride:close-rail"));
    case "reveal": if (command.kind === "hub") revealOnMap({ kind: "hub" }); else if (command.id) revealOnMap({ kind: command.kind, id: command.id }); return restore;
    case "tab": setTimeout(() => window.dispatchEvent(new CustomEvent("joyride:worker-tab", { detail: command.tab })), 150); return restore;
    case "view": go("map"); saveView({ ...command, user: true }); setTimeout(() => window.dispatchEvent(new CustomEvent("joyride:map-view", { detail: command })), 150); return restore;
    case "palette": window.dispatchEvent(new CustomEvent("joyride:palette", { detail: command.show })); return restore;
    case "attention": window.dispatchEvent(new CustomEvent("joyride:show-needs-you")); return restore;
    default: { const exhaustive: never = command; return exhaustive; }
  }
}
