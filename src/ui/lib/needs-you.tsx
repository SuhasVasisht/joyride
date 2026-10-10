import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { post, useApi } from "./api";
import { nativeNeedsYou } from "./native";
import type { Ask, AsksResponse } from "../../shared/asks";

const NeedsYouContext = createContext<{ items: Ask[]; ready: boolean; error: string | null; acknowledge: (id: string) => Promise<void>; undoAck: (id: string) => Promise<void> }>({ items: [], ready: false, error: null, acknowledge: async () => {}, undoAck: async () => {} });

export function NeedsYouProvider({ children }: { children: ReactNode }) {
  const { data, error } = useApi<AsksResponse>("/api/asks", ["asks"]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const acknowledge = async (id: string) => {
    setHidden((prev) => new Set(prev).add(id));
    setSaveError(null);
    try { await post(`/api/attention/${encodeURIComponent(id)}/label`, { label: "ack" }); }
    catch (e) {
      setHidden((prev) => { const next = new Set(prev); next.delete(id); return next; });
      setSaveError(`That didn't save: ${e instanceof Error ? e.message : String(e)}. Try again.`);
    }
  };
  const undoAck = async (id: string) => {
    await post(`/api/attention/${encodeURIComponent(id)}/undo-ack`);
    setHidden((prev) => { const next = new Set(prev); next.delete(id); return next; });
  };
  const items = (data?.asks ?? []).filter((a) => a.needs_you && !hidden.has(String(a.ref.attention))).sort((a, b) =>
    Number(b.level.slice(1)) - Number(a.level.slice(1)) || String(b.opened ?? "").localeCompare(String(a.opened ?? "")));
  const nativeSnapshot = JSON.stringify(items);
  useEffect(() => { if (data && !error) nativeNeedsYou(items); }, [nativeSnapshot, !!data, error]);
  return <NeedsYouContext.Provider value={{ items, ready: !!data && !error, error: error ?? saveError, acknowledge, undoAck }}>{children}</NeedsYouContext.Provider>;
}

export const useNeedsYou = () => useContext(NeedsYouContext);
export function openNeedsYou() {
  window.dispatchEvent(new Event("joyride:show-needs-you"));
}
