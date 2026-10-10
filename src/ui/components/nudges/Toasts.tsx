// "Tidied" toasts: when housekeeping commits a change while the captain is looking, a toast says what
// changed with Undo. Only runs that appear after mount toast; older ones remain in map history. Toasts hold
// while hovered or focused, and leave after 10 s otherwise. Several surfaces mount it (the rail tray, the
// map overlay); a host with reserved inline space takes precedence, else the latest mount shows them.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { post, useApi } from "../../lib/api";
import type { UndoNotice } from "../../../shared/nudges";

type Toast = { n: UndoNotice; state: "open" | "busy" | "undone" | "error"; message?: string };
const LIFE_MS = 10_000;

let hosts: { key: symbol; inline: boolean }[] = [];
const hostSubs = new Set<() => void>();
const hostStore = {
  add(key: symbol, inline: boolean) { hosts = [...hosts, { key, inline }]; hostSubs.forEach((f) => f()); return () => { hosts = hosts.filter((x) => x.key !== key); hostSubs.forEach((f) => f()); }; },
  subscribe(f: () => void) { hostSubs.add(f); return () => { hostSubs.delete(f); }; },
  shown: () => hosts.filter((h) => h.inline).at(-1)?.key ?? hosts.at(-1)?.key ?? null,
};

export function TidiedToasts({ inline = false }: { inline?: boolean }) {
  const { data: nudges } = useApi<UndoNotice[]>("/api/nudges/undo-toasts", ["nudges", "ideas", "missions", "map-layout"]);
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [held, setHeld] = useState(false);
  const [me] = useState(() => Symbol("toasts"));
  useEffect(() => hostStore.add(me, inline), [me, inline]);
  const shown = useSyncExternalStore(hostStore.subscribe, hostStore.shown) === me;

  useEffect(() => {
    if (!nudges) return;
    const tidied = nudges;
    if (!seen.current) { seen.current = new Set(tidied.map((n) => n.id)); return; } // what was there at mount is not news
    const fresh = tidied.filter((n) => !seen.current!.has(n.id));
    for (const n of fresh) seen.current.add(n.id);
    if (fresh.length) setToasts((ts) => [...ts, ...fresh.map((n) => ({ n, state: "open" as const }))].slice(-3));
  }, [nudges]);

  useEffect(() => {
    if (held || !toasts.length) return;
    const t = setTimeout(() => setToasts((ts) => ts.filter((x) => x.state === "busy")), LIFE_MS);
    return () => clearTimeout(t);
  }, [toasts, held]);

  const set = (id: string, patch: Partial<Toast>) => setToasts((ts) => ts.map((t) => (t.n.id === id ? { ...t, ...patch } : t)));
  async function undo(n: UndoNotice) {
    set(n.id, { state: "busy" });
    try { const r = await post<{ message: string }>(`/api/nudges/undo-toasts/${encodeURIComponent(n.id)}/undo`, {}); set(n.id, { state: "undone", message: r.message }); }
    catch (e: any) { set(n.id, { state: "error", message: `Undo didn't go through: ${e.message}` }); }
  }
  const close = (id: string) => setToasts((ts) => ts.filter((t) => t.n.id !== id));

  if (!shown || !toasts.length || typeof document === "undefined") return null;
  const content = (
    <div className="nd-toasts" role="status" aria-live="polite" onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      {toasts.map((t) => (
        <div key={t.n.id} className={`nd-toast state-${t.state}`} data-toast={t.n.id}>
          <div className="nd-toast-body">
            <strong>{t.state === "undone" ? "Undone" : t.n.title}</strong>
            <span>{t.message ?? t.n.why}</span>
          </div>
          {t.state === "open" || t.state === "busy" ? (
            <button type="button" className="btn small" disabled={t.state === "busy"} onClick={() => undo(t.n)}>{t.state === "busy" ? "Undoing…" : "Undo"}</button>
          ) : null}
          <button type="button" className="btn small ghost nd-toast-x" aria-label="Close" onClick={() => close(t.n.id)}>×</button>
        </div>
      ))}
    </div>
  );
  return inline ? content : createPortal(content, document.body);
}
