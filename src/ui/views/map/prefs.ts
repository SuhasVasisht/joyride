// Map preferences shared with palette commands: archive visibility and the last view.
import { useEffect, useState } from "react";

const ARCHIVE_KEY = "joyride.map.archive";
const VIEW_KEY = "joyride.map.view";

export function getArchive(): boolean | null {
  try { const v = localStorage.getItem(ARCHIVE_KEY); return v === null ? null : v === "1"; } catch { return null; }
}
export function setArchive(v: boolean) {
  try { localStorage.setItem(ARCHIVE_KEY, v ? "1" : "0"); } catch { /* storage blocked: still toggles for this page */ }
  window.dispatchEvent(new CustomEvent("joyride:archive", { detail: v }));
}
export function toggleArchive(fallback = false) { setArchive(!(getArchive() ?? fallback)); }

export function useArchive(defaultValue: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => getArchive() ?? defaultValue);
  useEffect(() => { if (getArchive() === null) setV(defaultValue); }, [defaultValue]);
  useEffect(() => {
    const f = (e: Event) => setV(Boolean((e as CustomEvent).detail));
    window.addEventListener("joyride:archive", f);
    return () => window.removeEventListener("joyride:archive", f);
  }, []);
  return [v, setArchive];
}

/** `user` marks a view the person panned or zoomed themselves (kept on return); otherwise the map refits. */
export type View = { s: number; tx: number; ty: number; user?: boolean };
export function loadView(): View | null {
  try { const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null"); return v && Number.isFinite(v.s) ? v : null; } catch { return null; }
}
let saveT: ReturnType<typeof setTimeout> | null = null;
export function saveView(v: View) {
  if (saveT) clearTimeout(saveT);
  saveT = setTimeout(() => { try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {} }, 250);
}

/** Ask the map to zoom to a level (palette commands). */
export function requestZoom(level: "far" | "mid" | "near" | "fit") { window.dispatchEvent(new CustomEvent("joyride:map-zoom", { detail: level })); }
