import { z } from "zod";

export const DRAFT_TTL = 7 * 864e5;
const PREFIX = "joyride:draft:v1:";
export type DraftTarget = { kind: "session" | "ask" | "task" | "composer" | "prompt"; id: string };
export const draftKey = (target: DraftTarget) => PREFIX + JSON.stringify([target.kind, target.id]);
const imageSchema = z.object({ key: z.string(), name: z.string(), bytes: z.number(), path: z.string(), url: z.string().nullable() });
const draftSchema = z.object({ text: z.string(), images: z.array(imageSchema), updated: z.number() });
export type DraftImage = z.infer<typeof imageSchema>;
export type Draft = z.infer<typeof draftSchema>;
const EMPTY: Draft = { text: "", images: [], updated: 0 };

/** Browser-local drafts. Storage failure leaves a usable in-memory box. Reads never renew expiry. */
export function createDraftStore(storage: () => Storage | null, now = Date.now) {
  const cache = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  function remove(key: string) {
    cache.set(key, EMPTY);
    try { storage()?.removeItem(key); } catch { /* Browser storage may be disabled. */ }
  }
  function read(key: string): Draft {
    const cached = cache.get(key);
    if (cached && (!cached.updated || now() - cached.updated < DRAFT_TTL)) return cached;
    let draft = EMPTY;
    try {
      const raw = storage()?.getItem(key);
      const parsed = raw ? draftSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success && now() - parsed.data.updated < DRAFT_TTL) draft = parsed.data;
      else if (raw) remove(key);
    } catch { /* Bad or unavailable storage must not break chat. */ }
    cache.set(key, draft);
    return draft;
  }
  function update(key: string, patch: Partial<Pick<Draft, "text" | "images">>) {
    const draft = { ...read(key), ...patch, updated: now() };
    if (!draft.text && !draft.images.length) remove(key);
    else {
      cache.set(key, draft);
      try { storage()?.setItem(key, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
    }
    emit();
  }
  function prune() {
    try {
      const s = storage();
      if (!s) return;
      const keys = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((key): key is string => Boolean(key?.startsWith(PREFIX)));
      keys.forEach(read);
    } catch { /* Storage unavailable. */ }
  }
  return {
    read, update, prune,
    clear(key: string) { remove(key); emit(); },
    invalidate(key: string | null) { if (key) cache.delete(key); else cache.clear(); emit(); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
export const draftStore = createDraftStore(() => typeof localStorage === "undefined" ? null : localStorage);
draftStore.prune();
if (typeof window !== "undefined") window.addEventListener("storage", (e) => draftStore.invalidate(e.key));
