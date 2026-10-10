import type { Ask } from "../../shared/asks";

type NativeMessage =
  | { kind: "needs-you"; items: { id: string; title: string; route: string; level: Ask["level"] }[] }
  | { kind: "route"; route: string };

declare global {
  interface Window {
    joyrideNative?: { postMessage(message: NativeMessage): void };
  }
}

export function nativeNeedsYou(items: Ask[]) {
  window.joyrideNative?.postMessage({
    kind: "needs-you",
    items: items.map((a) => ({
      id: a.id, title: a.title, level: a.level,
      route: a.task ? `/task/${encodeURIComponent(a.task)}`
        : a.worker ? `/worker/${encodeURIComponent(a.worker)}`
        : a.session ? `/session/${encodeURIComponent(a.session)}`
        : a.mission ? `/mission/${encodeURIComponent(a.mission)}` : "/agents?show=needs-you",
    })),
  });
}
