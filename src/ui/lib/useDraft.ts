import { useCallback, useRef, useSyncExternalStore } from "react";
import { draftKey, draftStore, type DraftTarget } from "./drafts";

export function useDraft(target: DraftTarget, initial = "") {
  const key = draftKey(target);
  const fallback = useRef({ key, text: initial });
  if (fallback.current.key !== key) fallback.current = { key, text: initial };
  const draft = useSyncExternalStore(draftStore.subscribe, () => draftStore.read(key));
  const setText = useCallback((text: string) => { fallback.current.text = ""; draftStore.update(key, { text }); }, [key]);
  // A callback ref runs when a box is restored, without moving the cursor on each keystroke.
  const boxRef = useCallback((box: HTMLTextAreaElement | HTMLInputElement | null) => {
    if (box) box.setSelectionRange(box.value.length, box.value.length);
  }, [key]);
  return { text: draft.updated ? draft.text : fallback.current.text, setText, boxRef, key, clear: () => { fallback.current.text = ""; draftStore.clear(key); } };
}
