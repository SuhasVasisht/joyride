// Stale tab guard: hash routes never reload the page, so after a rebuild and restart an open tab keeps
// running the old bundle. The served index.html carries the build it was cut from
// (<meta name="joyride-build">) and /api/health reports the build on disk now. When they differ the
// tab reloads itself, unless the captain has something in flight; then the shell offers a reload.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useConnected } from "./api";

export type BuildDecision = "none" | "reload" | "offer";

/**
 * What to do about the served build. `reloadedFor` is the build this tab last reloaded to reach:
 * landing on the old bundle again offers the reload instead of trying again, so it never loops.
 */
export function decideBuild(s: { own: string | null; served: string | null; reloadedFor: string | null; busy: boolean }): BuildDecision {
  if (!s.own || !s.served || s.own === s.served) return "none";
  if (s.reloadedFor === s.served) return "offer";
  return s.busy ? "offer" : "reload";
}

// ---------- in flight: what a reload would lose ----------

const checks = new Map<string, () => boolean>();
/** Other surfaces report work a reload would lose (the composer's ghosts that have not been sent yet). */
export function addInFlightCheck(name: string, fn: () => boolean) { checks.set(name, fn); }

const typed = new WeakSet<Element>();
const typedList: WeakRef<Element>[] = [];
let pressed = 0;
let dragging = false;
const isText = (el: Element) =>
  el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable ||
  (el instanceof HTMLInputElement && !/^(checkbox|radio|range|color|file|button|submit|reset|hidden)$/.test(el.type));
const hasText = (el: Element) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent ?? "").trim() !== "";

if (typeof window !== "undefined") {
  window.addEventListener("input", (e) => {
    const el = e.target as Element | null;
    if (el && isText(el) && !typed.has(el)) { typed.add(el); typedList.push(new WeakRef(el)); }
  }, true);
  window.addEventListener("pointerdown", () => { pressed++; }, true);
  const up = () => { pressed = Math.max(0, pressed - 1); };
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  window.addEventListener("blur", () => { pressed = 0; });
  window.addEventListener("dragstart", () => { dragging = true; }, true);
  window.addEventListener("dragend", () => { dragging = false; }, true);
}

/** True while a reload would lose something: typed text still on screen, a held pointer or drag, or a reported check. */
export function inFlight(): boolean {
  if (pressed > 0 || dragging) return true;
  for (let i = typedList.length - 1; i >= 0; i--) {
    const el = typedList[i].deref();
    if (!el || !el.isConnected) { typedList.splice(i, 1); continue; }
    if (hasText(el)) return true;
  }
  for (const fn of checks.values()) { try { if (fn()) return true; } catch { /* a broken check never blocks */ } }
  return false;
}

// ---------- the watcher ----------

const KEY = "joyride:reloaded-for";
const POLL_MS = 60_000;
const ownBuild = () => (typeof document !== "undefined" ? document.querySelector<HTMLMetaElement>('meta[name="joyride-build"]')?.content || null : null);
const readKey = () => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
const writeKey = (v: string | null) => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } };

/** Watches the served build: on a daemon reconnect, on focus, and every minute. `stale` shows the reload control. */
export function useBuildUpdate() {
  const [stale, setStale] = useState(false);
  const connected = useConnected();
  const served = useRef<string | null>(null);
  const checking = useRef(false);
  const own = useRef(ownBuild());

  const reload = useCallback(() => { writeKey(served.current); location.reload(); }, []);
  const check = useCallback(async () => {
    if (!own.current || checking.current) return;
    checking.current = true;
    try {
      const h = await api<{ build?: string | null }>("/api/health", { cache: "no-store" });
      served.current = h?.build ?? null;
      // Once the control is up it stays the captain's call; it never turns into a reload under them.
      const d = decideBuild({ own: own.current, served: served.current, reloadedFor: readKey(), busy: stale || inFlight() });
      if (d === "reload") { writeKey(served.current); location.reload(); return; }
      setStale(d === "offer");
    } catch { /* daemon down: the reconnect checks again */ } finally { checking.current = false; }
  }, [stale]);

  useEffect(() => { if (own.current && readKey() === own.current) writeKey(null); }, []);
  useEffect(() => { if (connected) void check(); }, [connected, check]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    const t = setInterval(() => void check(), POLL_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); window.removeEventListener("focus", onVisible); document.removeEventListener("visibilitychange", onVisible); };
  }, [check]);
  return { stale, reload };
}
