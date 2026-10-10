// The order of the idea page's panels: the workspace's `mission_panels`, else this default.
export const DEFAULT_PANEL_ORDER = ["done_when", "notes", "workers", "crew", "evidence", "sessions", "decisions", "artifacts", "timeline", "dependencies"];

/**
 * Where a panel sits: its place in the workspace's `mission_panels`; a panel that list doesn't name
 * (a newer one, such as notes) goes right after its nearest listed predecessor in the default order.
 */
export function panelRank(order: string[], pid: string): number {
  const i = order.indexOf(pid);
  if (i >= 0) return i;
  const d = DEFAULT_PANEL_ORDER.indexOf(pid);
  for (let k = d - 1; k >= 0; k--) { const j = order.indexOf(DEFAULT_PANEL_ORDER[k]); if (j >= 0) return j + 0.5; }
  return d >= 0 ? -0.5 : 100;
}
