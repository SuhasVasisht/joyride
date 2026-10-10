// Board items a landing ghost is still flying in (components/compose/LandingGhost): their card renders hidden
// until the ghost reaches it, so the item never pops in ahead of its own arrival.
const arriving = new Set<string>();
export const isArriving = (id: string) => arriving.has(id);
export function setArriving(id: string, on: boolean) {
  if (on) arriving.add(id); else arriving.delete(id);
  for (const el of document.querySelectorAll<HTMLElement>(`[data-board-item="${CSS.escape(id)}"]`)) {
    if (on) el.dataset.arriving = ""; else delete el.dataset.arriving;
  }
}

// Items just moved, or asked for by Show on map: a board orders them as new as of then, so a full board still
// draws them and the chart can bring the card into view.
const placed = new Map<string, number>();
export function markPlaced(id: string) { placed.set(id, Date.now()); }
/** When an item counts as new on its board: when it was placed (moved, asked for), else when it was made. */
export const placedAt = (n: { id: string; created: string }) => Math.max(Date.parse(n.created) || 0, placed.get(n.id) ?? 0);
