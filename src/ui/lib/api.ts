// Tiny data layer: fetch JSON + live invalidation over SSE (/api/stream).
// useApi(path, entities) refetches whenever the daemon reports a change to
// one of the listed entities.
import { useEffect, useRef, useState, useCallback } from "react";

class DaemonUnavailable extends Error {}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const method = init?.method ?? (init?.json !== undefined ? "POST" : "GET");
  let r: Response;
  try { r = await fetch(path, {
    ...init,
    method,
    signal: init?.signal ?? (method === "GET" ? AbortSignal.timeout(5000) : undefined),
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  }); } catch (e) {
    if (method === "GET" && (e instanceof TypeError || e instanceof DOMException && e.name === "TimeoutError")) throw new DaemonUnavailable("Reconnecting to Joyride…");
    throw e;
  }
  if (r.status === 503) throw new DaemonUnavailable("Reconnecting to Joyride…");
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}
export const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });

// Several mounted cards read the same URL. Share only concurrent GETs, never old responses.
const pendingGets = new Map<string, Promise<unknown>>();
function sharedGet<T>(path: string): Promise<T> {
  const pending = pendingGets.get(path);
  if (pending) return pending as Promise<T>;
  const request = api<T>(path);
  pendingGets.set(path, request);
  void request.finally(() => { if (pendingGets.get(path) === request) pendingGets.delete(path); }).catch(() => {});
  return request;
}

type Change = { entity: string; id?: string };
const listeners = new Set<(c: Change) => void>();
let es: EventSource | null = null;
let connected = false;
const connListeners = new Set<(b: boolean) => void>();
function ensureStream() {
  if (es || typeof EventSource === "undefined") return;
  es = new EventSource("/api/stream");
  es.addEventListener("change", (ev) => { try { const c = JSON.parse((ev as MessageEvent).data); listeners.forEach((l) => l(c)); } catch {} });
  es.onopen = () => { connected = true; connListeners.forEach((l) => l(true)); listeners.forEach((l) => l({ entity: "*" })); };
  es.onerror = () => { connected = false; connListeners.forEach((l) => l(false)); };
}
export function onChange(fn: (c: Change) => void) { ensureStream(); listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => { ensureStream(); connListeners.add(setC); return () => { connListeners.delete(setC); }; }, []);
  return c;
}

export function useApi<T = any>(path: string | null, entities: string[] = [], opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    try { const d = await sharedGet<T>(path); if (my === seq.current) {
      setData(d); setError(null); failures.current = 0;
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    } }
    catch (e: unknown) { if (my === seq.current) {
      if (e instanceof DaemonUnavailable) {
        if (retry.current) clearTimeout(retry.current);
        retry.current = setTimeout(() => { retry.current = null; void load(); }, Math.min(2000, 250 * 2 ** failures.current++));
      } else setError(e instanceof Error ? e.message : String(e));
    } }
    finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => {
    setData(null); setError(null); setLoading(true); failures.current = 0; void load();
    return () => { seq.current++; if (retry.current) clearTimeout(retry.current); retry.current = null; };
  }, [load]);
  useEffect(() => {
    let t: any = null;
    const off = onChange((c) => {
      if (c.entity === "*" || entities.includes(c.entity)) {
        // A response started before connection/change may have missed a completed refresh.
        if (path) pendingGets.delete(path);
        clearTimeout(t); t = setTimeout(load, 120);
      }
    });
    return () => { off(); clearTimeout(t); };
  }, [load, entities.join(",")]);
  useEffect(() => {
    if (!opts.pollMs) return;
    const i = setInterval(load, opts.pollMs);
    return () => clearInterval(i);
  }, [load, opts.pollMs]);
  return { data, error, loading, reload: load, setData };
}

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const repoLabel = (repo: string | null | undefined) => (repo ? repo.split("/").filter(Boolean).pop() : "no repo");

/** A display title: drops HTML comments and markup some harnesses put at the top of a prompt, and collapses whitespace. */
export function cleanTitle(s: string | null | undefined, fallback = ""): string {
  const t = String(s ?? "").replace(/<!--[\s\S]*?(-->|$)/g, " ").replace(/<\/?[a-z][^>]*>/gi, " ").replace(/\s+/g, " ").trim();
  return t || fallback;
}
