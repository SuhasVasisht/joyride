// Extension registry. Each feature contributes routes, rail sections,
// palette commands and nav items from its own file under views/<feature>/
// (default export `contribute()`), discovered with import.meta.glob so
// features never edit a shared list.
import type { ComponentType } from "react";
import type { Route } from "./router";

export type RouteDef = { name: string; component: ComponentType<{ route: Route }>; overlay?: boolean };
export type RailDef = { id: string; order: number; component: ComponentType };
export type CommandDef = { id: string; title: string; hint?: string; keywords?: string; run: () => void | Promise<void>; group?: string };
/** `secondary` items sit in the topbar's "More" menu (their badges stay mounted and roll up to it). */
export type NavDef = { id: string; title: string; href: string; order: number; badge?: ComponentType; secondary?: boolean };
/** A section of the mission page. Ordered by workspace.yaml `mission_panels` (ids), then `order`. */
export type MissionPanelDef = { id: string; title: string; order: number; component: ComponentType<{ mission: any; missionId: string }> };
export type Contribution = {
  routes?: RouteDef[];
  /** Mounted once by the shell, hidden, on every page: hosts for portals and global listeners. */
  global?: ComponentType[];
  rail?: RailDef[];
  commands?: () => CommandDef[] | Promise<CommandDef[]>;
  nav?: NavDef[];
  missionPanels?: MissionPanelDef[];
};

const mods = import.meta.glob<{ default: () => Contribution }>("../views/*/contribute.tsx", { eager: true });
export const contributions: Contribution[] = Object.values(mods).map((m) => m.default());
export const routes = new Map<string, RouteDef>(contributions.flatMap((c) => c.routes ?? []).map((r) => [r.name, r]));
export const railSections = contributions.flatMap((c) => c.rail ?? []).sort((a, b) => a.order - b.order);
export const navItems = contributions.flatMap((c) => c.nav ?? []).sort((a, b) => a.order - b.order);
export const globals = contributions.flatMap((c) => c.global ?? []);
export const missionPanels = contributions.flatMap((c) => c.missionPanels ?? []).sort((a, b) => a.order - b.order);
export async function allCommands(): Promise<CommandDef[]> {
  const out: CommandDef[] = [];
  for (const c of contributions) if (c.commands) { try { out.push(...(await c.commands())); } catch {} }
  return out;
}
