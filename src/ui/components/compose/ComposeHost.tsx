// The ghost tray (control plane CP5), mounted once at shell level (a global, see views/compose/contribute.tsx)
// and portaled over every page: the cards for requests, notes and lists made in New (views/new).
// A `#/compose[?idea=<id>]` link opens New in the rail (on that idea) without leaving the page underneath.
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { parse } from "../../lib/router";
import { GhostCard } from "./GhostCard";
import { LandingGhost } from "./LandingGhost";
import { openComposer, targetRect, useGhosts } from "./ghost";
import "./compose.css";

function GhostTray() {
  const all = useGhosts();
  if (!all.length) return null;
  // A board item New saved is only a flight, from the box into its card.
  const flights = all.filter((g) => g.landing && g.saved);
  const ghosts = all.filter((g) => !(g.landing && g.saved));
  const docked = ghosts.filter((g) => !targetRect(g.target, g));
  const anchored = ghosts.filter((g) => targetRect(g.target, g));
  return (
    <>
      {docked.length ? <section className="ghost-tray" aria-label="Requests, notes and lists">{docked.map((g) => <GhostCard key={g.id} g={g} />)}</section> : null}
      {anchored.map((g) => <GhostCard key={g.id} g={g} />)}
      {flights.map((g) => <LandingGhost key={g.id} g={g} />)}
    </>
  );
}

/** Mounted once by the shell: the ghost tray, portaled over every page, and #/compose links. */
export function ComposeHost() {
  useEffect(() => {
    const ideaOf = (href: string) => new URLSearchParams(href.split("?")[1] ?? "").get("idea") ?? undefined;
    // A #/compose link opens New in place rather than navigating away from the page underneath.
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href^='#/compose']") as HTMLAnchorElement | null;
      if (!a || e.metaKey || e.ctrlKey || e.button !== 0) return;
      e.preventDefault();
      const idea = ideaOf(a.getAttribute("href")!);
      openComposer(idea ? { idea } : {});
    };
    const fromHash = () => {
      const r = parse();
      if (r.name !== "compose") return;
      const idea = r.query.get("idea") ?? undefined;
      history.replaceState(null, "", "#/map");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      openComposer(idea ? { idea } : {});
    };
    fromHash();
    window.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", fromHash);
    return () => { window.removeEventListener("click", onClick, true); window.removeEventListener("hashchange", fromHash); };
  }, []);
  return createPortal(<GhostTray />, document.body);
}
