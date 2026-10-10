import { z } from "zod";
import { BrowserState, type BrowserState as State } from "./commands";

const key = "joyride:new:history";
const Entry = z.object({ id: z.string(), applied: z.number().nonnegative(), view: BrowserState.nullable() });
type Entry = z.infer<typeof Entry>;
function load(): Entry[] {
  try { return z.array(Entry).max(30).parse(JSON.parse(sessionStorage.getItem(key) ?? "[]")); } catch { return []; }
}
const entries = load();
const save = () => { try { sessionStorage.setItem(key, JSON.stringify(entries)); } catch {} };
export const history = {
  ids: () => entries.map((e) => e.id),
  remember(id: string, view: State | null) {
    if (entries.some((e) => e.id === id)) return;
    entries.unshift({ id, applied: 0, view }); entries.splice(30); save();
  },
  applied: (id: string) => entries.find((e) => e.id === id)?.applied ?? 0,
  didApply(id: string, count: number) { const entry = entries.find((e) => e.id === id); if (entry) { entry.applied = count; save(); } },
  view: (id: string) => entries.find((e) => e.id === id)?.view ?? null,
};
