import { useEffect, useRef, useState } from "react";
import { useRoute, href, type Route } from "./lib/router";
import { routes, railSections, navItems, globals, type NavDef } from "./lib/registry";
import { useApi, useConnected } from "./lib/api";
import { useBuildUpdate } from "./lib/build";
import { NeedsYouProvider } from "./lib/needs-you";
import { CommandPalette } from "./components/CommandPalette";

/** Applies workspace.yaml `theme:` overrides as CSS variables. */
function useWorkspaceTheme() {
  const { data } = useApi<any>("/api/workspace/spec", ["workspace"]);
  useEffect(() => {
    const theme = data?.theme ?? {};
    for (const [k, v] of Object.entries(theme)) document.documentElement.style.setProperty(k.startsWith("--") ? k : `--${k}`, String(v));
  }, [data]);
  return data;
}

const navMatches = (n: NavDef, route: Route) => route.raw.startsWith(n.href.replace(/^#\//, ""));
/** The nav item with the longest matching href wins, so Artifacts (knowledge/artifacts) and Knowledge never light up together. */
const isActive = (n: NavDef, route: Route, overlay: boolean) =>
  (navMatches(n, route) && !navItems.some((o) => o.href.length > n.href.length && navMatches(o, route))) || (n.id === "map" && (route.name === "map" || overlay));

function NavLink({ n, active, menu }: { n: NavDef; active: boolean; menu?: boolean }) {
  const Badge = n.badge;
  return (
    <a href={n.href} className={active ? "active" : ""} role={menu ? "menuitem" : undefined} aria-current={active ? "page" : undefined}>
      {n.title}{Badge ? <Badge /> : null}
    </a>
  );
}

/**
 * Secondary nav items (tuning Joyride itself) live in a "More" menu so the bar
 * fits at 1280px. The menu stays mounted while closed, and any badge inside
 * puts a dot on the trigger.
 */
function NavMore({ items, route, overlay }: { items: NavDef[]; route: Route; overlay: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const current = items.find((n) => isActive(n, route, overlay));
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    window.addEventListener("mousedown", away);
    window.addEventListener("hashchange", close);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("hashchange", close); };
  }, [open]);
  const focusItem = (dir: 1 | -1 | 0) => {
    const els = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[dir === 0 ? 0 : (i + dir + els.length) % els.length]?.focus();
  };
  return (
    <div ref={box} className={`nav-more${current ? " has-active" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
        if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); setTimeout(() => focusItem(open ? 1 : 0), 0); }
        if (e.key === "ArrowUp" && open) { e.preventDefault(); focusItem(-1); }
      }}>
      <button ref={btn} type="button" className={`nav-more-btn${current ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {current ? current.title : "More"}
        <span className="nav-more-dot" aria-hidden />
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className="nav-menu sheet" role="menu" aria-label="More pages" hidden={!open}>
        {items.map((n) => <NavLink key={n.id} n={n} active={isActive(n, route, overlay)} menu />)}
      </div>
    </div>
  );
}

export function App() { return <NeedsYouProvider><Shell /></NeedsYouProvider>; }

function Shell() {
  const route = useRoute();
  const connected = useConnected();
  const spec = useWorkspaceTheme();
  const update = useBuildUpdate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
      if (e.key === "Escape") setPaletteOpen(false);
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "\\") setRailOpen((o) => !o);
    };
    const onToggleRail = () => setRailOpen((o) => !o);
    const onOpenRail = () => setRailOpen(true);
    const onCloseRail = () => setRailOpen(false);
    const onPalette = (e: Event) => { const show: unknown = (e as CustomEvent).detail; if (typeof show === "boolean") setPaletteOpen(show); };
    const showNeedsYou = () => {
      setRailOpen(true);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const section = document.querySelector<HTMLElement>('[data-rail="attention"]');
        section?.scrollIntoView({ block: "start" });
        section?.focus({ preventScroll: true });
      }));
    };
    window.addEventListener("joyride:show-needs-you", showNeedsYou);
    window.addEventListener("keydown", onKey);
    window.addEventListener("joyride:toggle-rail", onToggleRail);
    window.addEventListener("joyride:open-rail", onOpenRail);
    window.addEventListener("joyride:close-rail", onCloseRail);
    window.addEventListener("joyride:palette", onPalette);
    return () => { window.removeEventListener("joyride:show-needs-you", showNeedsYou); window.removeEventListener("keydown", onKey); window.removeEventListener("joyride:toggle-rail", onToggleRail); window.removeEventListener("joyride:open-rail", onOpenRail); window.removeEventListener("joyride:close-rail", onCloseRail); window.removeEventListener("joyride:palette", onPalette); };
  }, []);

  // Overlay routes (mission, worker, session panes) render as a sheet over the map.
  const def = routes.get(route.name) ?? routes.get("map");
  const overlay = def?.overlay ? def : null;
  const base = overlay ? routes.get("map") : def;
  const Main = base?.component;
  const Over = overlay?.component;
  // Rail sections follow workspace.yaml `home.rail` when the spec is available; New always sits directly above Approvals.
  const railOrder: string[] = spec?.home?.rail ?? [];
  const railRank = (id: string): number => { if (id === "start") return -1; if (id === "new") return railRank("approvals") - 0.5; const i = railOrder.indexOf(id); return i < 0 ? 100 : i; };
  const rail = [...railSections].sort((a, b) => railRank(a.id) - railRank(b.id) || a.order - b.order);
  return (
    <div className={`shell ${railOpen ? "rail-open" : ""}`}>
      <header className="topbar">
        <a className="brand" href={href("map")} aria-label="Joyride home">
          <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden><circle cx="16" cy="16" r="11" fill="none" stroke="currentColor" strokeWidth="3" /><circle cx="16" cy="16" r="4" fill="var(--signal)" /></svg>
          <span>{spec?.title ?? "Joyride"}</span>
        </a>
        <nav className="nav" aria-label="Main">
          {navItems.filter((n) => !n.secondary).map((n) => <NavLink key={n.id} n={n} active={isActive(n, route, !!overlay)} />)}
          {navItems.some((n) => n.secondary) ? <NavMore items={navItems.filter((n) => n.secondary)} route={route} overlay={!!overlay} /> : null}
        </nav>
        <div className="spacer" />
        <button className="btn palette-trigger" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
          <svg className="palette-trigger-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
          <span className="palette-trigger-label">Search or run a command</span><kbd>⌘K</kbd>
        </button>
        {update.stale ? (
          <button type="button" className="build-update" onClick={update.reload} title="A new version of Joyride is running. Reload this tab to use it.">
            Joyride updated <span aria-hidden>·</span> <b>Reload</b>
          </button>
        ) : null}
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "Live" : "Showing the last update while Joyride reconnects"}>{connected ? "Live" : "Reconnecting…"}</span>
        <button className="btn ghost" onClick={() => setRailOpen((o) => !o)} aria-pressed={railOpen} title="Toggle the attention rail (\\)">Rail</button>
      </header>
      <main className="main" data-route={route.name}>
        {Main ? <Main route={route} /> : <div className="empty">Nothing here yet.</div>}
        {Over ? <Over key={route.raw.split("?")[0]} route={route} /> : null}
      </main>
      <aside className="rail" aria-label="Needs you" hidden={!railOpen}>
        {rail.filter((s) => railOpen || s.id === "new").map((s) => <s.component key={s.id} />)}
      </aside>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <div className="shell-globals" hidden>{globals.map((G, i) => <G key={i} />)}</div>
    </div>
  );
}
