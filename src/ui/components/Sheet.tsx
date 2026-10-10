// A sheet over the map (mission, worker and session panes). Esc returns to
// where you came from; clicking the uncovered map closes it.
import { useEffect, useRef, type ReactNode } from "react";
import { go } from "../lib/router";
import "./components.css";

// In-app back stack for hash routes, so Esc returns to the previous pane
// (session → worker → mission → map) without ever leaving the app. Closing
// updates the stack synchronously, so fast repeated Esc presses can't race
// the asynchronous hashchange event.
const cur = () => location.hash.replace(/^#\/?/, "") || "map";
const stack: string[] = [cur()];
const expected: string[] = []; // navigations started by closeOverlay, already applied to the stack
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const now = cur();
    if (expected.length) { const e = expected.shift(); if (e === now) return; expected.length = 0; }
    if (stack.length >= 2 && stack[stack.length - 2] === now) stack.pop();
    else if (stack[stack.length - 1] !== now) stack.push(now);
    if (stack.length > 50) stack.splice(0, stack.length - 50);
  });
}

/** Close the current overlay: back to the previous in-app route, else the map. */
export function closeOverlay() {
  const here = cur();
  while (stack.length && stack[stack.length - 1] === here) stack.pop();
  if (!stack.length) stack.push("map");
  const prev = stack[stack.length - 1];
  if (prev === here) return;
  expected.push(prev);
  go(prev);
}

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export function Sheet({ label, children, onClose = closeOverlay, wide }: { label: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const h = ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("h1");
    if (h) { if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".palette-backdrop")) return; // the palette closes first
      if (isTyping(e.target)) { (e.target as HTMLElement).blur(); ref.current?.focus(); return; }
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, [onClose]);
  return (
    <div className="sheet-layer">
      <div className="sheet-scrim" onMouseDown={onClose} aria-hidden />
      <div ref={ref} className={`pane-sheet${wide ? " wide" : ""}`} role="dialog" aria-label={label} tabIndex={-1}>
        <div className="sheet-header">
          <button type="button" className="btn sheet-close" onClick={onClose} aria-label="Close and return" aria-keyshortcuts="Escape" title="Close and return (Esc)">
            Close <kbd>Esc</kbd>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
