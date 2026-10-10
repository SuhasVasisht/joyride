import { useNeedsYou, openNeedsYou } from "../../lib/needs-you";
// The chart: missions as regions on a pannable, zoomable plane with
// semantic zoom (far → mid → near adds workers, progress, then each worker's
// current action and last message). Live via SSE through useApi.
import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { href, go, parse, type Route } from "../../lib/router";
import { api, cleanTitle, post, repoLabel, useApi } from "../../lib/api";
import type { MissionProposal, WorkerView } from "../../lib/types";
import { HealthMark, VesselMark } from "../../components/Marks";
import { plural, shortPath, TimeAgo } from "../../components/primitives";
import { MetricsStrip } from "../metrics/MetricsStrip";
import { buildRegions, layoutRegions, levelOf, MAX_S, MIN_S, PRESETS, type Item, type RegionOut, type ZoomLevel } from "./layout";
import { offChart, rankOf, useSpec, useWorld, type MapArtifact, type MapMission, type MapWorker, type UnfiledSession } from "./world";
import { FirstmateNode } from "./FirstmateNode";
import { ArtifactChips } from "./ArtifactChips";
import { FleetChips } from "../fleet/chips";
import { groupUnfiled, holdInGroups, setAside } from "./place";
import { StartHereButton } from "../start/StartHereButton";
import { dragHint, homeRegion, kindLabel, menuTargets, missionTarget, moveBody, noteScopeOf, regionTarget, targetKey, targetLabel, type DragItem, type DropTarget, type MenuTarget } from "./regroup";
import { DragHandle, Grip } from "./DragHandle";
import { lensNames } from "../../../shared/lens-match";
import { loadView, saveView, useArchive, type View } from "./prefs";
import { useIntentions } from "../../lib/intentions";
import { AskBadge, AskCard } from "./AskCard";
import { goalOf, Landed, STATUS_TEXT, TaskCard, TaskList, TaskRow, WorkerLine, type Intents } from "./TaskCard";
import { BUCKETS, BUCKET_LABEL, glanceOf, glanceParts, inventory, sortIdea } from "./glance";
import { IdeaBriefView } from "../../components/nudges/IdeaBrief";
import { useIdeaBriefs } from "../../components/nudges/api";
import type { IdeaBrief as IdeaBriefT } from "../../../shared/nudges";
import { Replies } from "./ReplyNote";
import { askOrder } from "./plane";
import { MapSlot } from "./slots";
import { createGesture } from "./gesture";
import { onCamera } from "./culling";
import { createSemanticQueue, type SemanticQueue } from "./semantic";
import { onReveal, takeReveal } from "./reveal";
import { setCurrentGroup } from "./current";
import { markPlaced } from "../../components/notes/arriving";
import { arrangementAfterDrop, spread, toStored, type Pos } from "./arrange";
import { cssString, frame, largestFit, fly, focusKey, focusOf, focusPath, isOutward, NO_FOCUS, type Focus } from "./focus";
import { openComposer } from "../../components/compose/ghost";
import type { Landing } from "../../../shared/new-plan";
import type { ServerGroupView } from "../../../shared/servers";
import { ServerCard } from "../servers/ServersPage";
import "./map.css";
import "./plane.css";

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/**
 * The scale the chart is laid out at. Text keeps a constant screen size, so below MIN_S the layout
 * stops changing and the whole chart shrinks geometrically instead (CSS --k): zoom out never stalls
 * with part of the canvas out of reach, and Fit can always frame everything.
 */
const layoutScale = (s: number) => Math.max(s, MIN_S);
/** Never zoom out past this, however tall the chart. */
const FLOOR_S = 0.03;
/** Space Fit leaves at the top and sides; the bottom also clears the zoom controls, next ask and legend. */
const FIT_TOP = 40, FIT_SIDE = 64, FIT_GAP = 16;
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};
/** Set once the captain has seen how regrouping works (dismissed the tip, or made a move). */
const TIP_KEY = "joyride.map.regroup-tip";

export function MapView({ route }: { route: Route }) {
  const { items: needsYou, ready: needsReady } = useNeedsYou();
  const world = useWorld();
  const servers = useApi<ServerGroupView[]>("/api/servers?purpose=review", ["servers"], { pollMs: 3000 });
  const spec = useSpec();
  const [archive, setArchive] = useArchive(spec?.home?.show_archive ?? false);
  // Sessions a group holds directly (dropped on it), shown in the group whether or not they are live.
  const heldKeys = useMemo(() => [...new Set(world.lenses.flatMap((l) => l.sessions ?? []))].sort().join(","), [world.lenses]);
  const heldSessions = useApi<UnfiledSession[]>(heldKeys ? `/api/sessions?keys=${encodeURIComponent(heldKeys)}` : null, ["sessions", "missions", "lenses"]);
  // Unfiled work the captain set aside: off the chart until it does something new.
  const hidden = useApi<Record<string, string>>("/api/missions/hidden", ["missions"]);
  // What each agent is trying to do: shown instead of raw titles at mid and near zoom.
  const intents = useIntentions([...world.workers.map((w) => w.session), ...(heldKeys ? (heldSessions.data ?? []).slice(0, 8).map((s) => s.key) : [])]);
  const proposals = useApi<MissionProposal[]>("/api/missions/proposals", ["proposals"]);
  const overlayOpen = route.name !== "map";
  const briefs = useIdeaBriefs();
  // Where the captain placed groups (map/layout.yaml); a drop shows at once, before the server answers.
  const placedApi = useApi<Record<string, Pos>>("/api/missions/map/layout", ["map-layout"]);
  const [placing, setPlacing] = useState<Map<string, Pos> | null>(null);
  const positions = useMemo(() => placing ?? new Map(Object.entries(placedApi.data ?? {})), [placing, placedApi.data]);
  // Focus lives in the URL (#/map?focus=<group>&idea=<idea>); a sheet opened over the map keeps it.
  const mapFocus = useRef<Focus>(NO_FOCUS);
  if (route.name === "map") mapFocus.current = focusOf(route);
  const selected = route.name === "mission" ? route.params[0] : null;
  const selectedWorker = route.name === "worker" ? route.params[0] : null;
  // The task whose sheet is open keeps its card highlighted underneath.
  const selectedTask = route.name === "task" ? route.params[0] ?? null : null;

  const archivedCount = world.missions.filter(offChart).length;
  const [scale, setScale] = useState(() => loadView()?.s ?? 1);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number } | null>(null);
  const [screenSizes, setScreenSizes] = useState<Record<ZoomLevel, Map<string, number>>>(() => ({ far: new Map(), mid: new Map(), near: new Map() }));
  const { regions, visibleCount, dataKey, drags } = useMemo(() => {
    const visible = world.missions.filter((m) => archive || !offChart(m));
    const live = new Set(world.workers.map((w) => w.session).filter(Boolean) as string[]);
    const byLensGroups = (spec?.home?.group_by ?? "lens") === "lens";
    const now = Date.now();
    // Unfiled work stays only while there is something to act on; a group keeps what was dropped on it.
    const shown = world.unfiledWorkers.filter((w) => !setAside(w, hidden.data ?? {}));
    const kept = holdInGroups(byLensGroups ? world.lenses.map((l) => ({ id: l.id, sessions: l.sessions ?? [], projects: l.projects ?? [] })) : [],
      { workers: shown, sessions: heldKeys ? (heldSessions.data ?? []).filter((s) => !live.has(s.key) && !world.sessionMission.has(s.key)) : [] }, now, world.taskRepo);
    const unfiled = groupUnfiled<WorkerView, UnfiledSession>({ workers: kept.workers }, world.taskRepo);
    const regions = buildRegions(visible, world.lenses, spec, unfiled, world.firstmate, kept.byLens);
    for (const server of servers.data ?? []) if (server.canvas) regions.push({ id: `server:${server.id}`, title: server.name, kind: "server", missions: [], workers: [], sessions: [], server });
    const fmKey = `${world.firstmate.status?.running ?? "?"}`;
    const dataKey = regions.map((r) => `${r.id}:${r.missions.map((m) => `${m.id}/${m.tasks.length}`).join(",")}:${r.workers.length}:${r.sessions.length}:${r.quiet?.length ?? 0}`).join("|") + `|fm:${fmKey}:${world.firstmate.orphans.length}`;
    // What can be picked up: every session with a key, and missions while the chart groups by lens.
    const drags = new Map<string, DragItem>();
    const namedBy = new Map<string, string>();
    if (byLensGroups) for (const l of world.lenses) for (const k of l.sessions ?? []) if (!namedBy.has(k)) namedBy.set(k, l.id);
    for (const r of regions) {
      for (const m of r.missions) {
        if (byLensGroups) {
          const from = r.lens ?? null;
          const lens = from ? world.lenses.find((l) => l.id === from) : undefined;
          drags.set(`m:${m.id}`, { kind: "mission", id: m.id, label: m.title, from, home: homeRegion(m), explicit: Boolean(lens && lensNames(lens, m)) });
        }
        for (const w of m.workers) if (w.session) drags.set(`s:${w.session}`, { kind: "session", key: w.session, label: w.title || w.id, from: m.id });
        for (const t of m.tasks) drags.set(`t:${t.id}`, { kind: "task", id: t.id, label: t.title || t.id, from: m.id });
      }
      for (const t of r.firstmate?.orphans ?? []) drags.set(`t:${t.id}`, { kind: "task", id: t.id, label: t.title || t.id, from: null });
      for (const w of [...r.workers, ...(r.quiet ?? [])]) if (w.session) drags.set(`s:${w.session}`, { kind: "session", key: w.session, label: w.title || w.id, from: null, lens: namedBy.get(w.session) ?? null, region: r.id });
      for (const x of r.sessions) drags.set(`s:${x.key}`, { kind: "session", key: x.key, label: cleanTitle(x.title, x.key), from: null, lens: namedBy.get(x.key) ?? null, region: r.id });
    }
    return { regions, visibleCount: visible.length, dataKey, drags };
  }, [world.missions, world.lenses, world.unfiledWorkers, world.taskRepo, world.workers, world.sessionMission, world.firstmate, heldSessions.data, heldKeys, hidden.data, archive, spec, servers.data]);

  const wantFocus = mapFocus.current;
  const focus = useMemo<Focus>(() => {
    const r = wantFocus.group ? regions.find((x) => x.id === wantFocus.group && x.kind !== "firstmate") : undefined;
    if (!r) return NO_FOCUS;
    return { group: r.id, idea: wantFocus.idea && r.missions.some((m) => m.id === wantFocus.idea) ? wantFocus.idea : null };
  }, [regions, wantFocus.group, wantFocus.idea]);
  const focusK = focusKey(focus);
  const focusRef = useRef(focus);
  focusRef.current = focus;

  // ---------- view transform (kept out of React state for smooth pan/zoom) ----------
  const vpRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const saved = useRef(loadView());
  const view = useRef<View>(saved.current ?? { s: 1, tx: 0, ty: 0 });
  const moved = useRef(Boolean(saved.current?.user));
  const fittedKey = useRef<string | null>(saved.current?.user ? "saved" : null);
  const [level, setLevel] = useState<ZoomLevel>(levelOf(view.current.s));
  const layoutCache = useMemo(() => new Map<string, ReturnType<typeof layoutRegions>>(), [regions, screenSizes, viewportSize, positions, focusK]);
  /** The chart at a level and scale, with groups where the captain placed them and the focused group open. `arrange` overrides the placements. */
  const getLayout = useCallback((lv: ZoomLevel, s: number, arrange?: ReadonlyMap<string, Pos>, unfocused = false) => {
    const ls = layoutScale(s);
    const key = `${lv}:${ls}`;
    const cached = arrange || unfocused ? undefined : layoutCache.get(key);
    if (cached) return cached;
    const f = unfocused ? NO_FOCUS : focusRef.current;
    const result = layoutRegions(regions, lv, ls, screenSizes[lv], lv === "far" && vpRef.current ? ((viewportSize?.w ?? vpRef.current.clientWidth) - 128) / ls : undefined,
      { positions: arrange ?? positions, focus: f.group, focusSizes: screenSizes.near, idea: f.idea, focusViewport: viewportSize ?? undefined });
    if (arrange || unfocused) return result;
    if (layoutCache.size >= 64) layoutCache.clear();
    layoutCache.set(key, result);
    return result;
  }, [regions, screenSizes, viewportSize, layoutCache, positions]);
  const layoutsRef = useRef(getLayout);
  layoutsRef.current = getLayout;
  const layout = useMemo(() => getLayout(level, scale), [getLayout, level, scale]);

  const rendered = useRef({ layout, scale });
  const cameraViewport = useRef<{ w: number; h: number } | null>(null);
  const cameraNodes = useRef<{ el: HTMLElement | SVGElement; bounds: { x: number; y: number; w: number; h: number } }[]>([]);
  const [cameraItems, setCameraItems] = useState<Set<string> | null>(null);
  const cameraItemsRef = useRef<Set<string> | null>(null);
  const movingCamera = useRef(false);
  const revealedMission = useRef<string | null>(null);
  const flushMeasurements = useRef<() => void>(() => {});
  const semanticQueue = useMemo(() => createSemanticQueue(undefined, undefined, () => flushMeasurements.current()), []);
  const zoomAnchor = useRef<string | null>(null);
  const flight = useRef<{ cancel: () => void } | null>(null);
  const openingFocus = useRef(false);
  const paint = useCallback(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const { s, tx, ty } = view.current;
    const viewport = cameraViewport.current ?? { w: vp.clientWidth, h: vp.clientHeight };
    cameraViewport.current = viewport;
    const focused = document.activeElement;
    const shown = new Set<string>();
    for (const { el, bounds } of cameraNodes.current) {
      // Keep an editor and the card being carried alive even beyond the overscan.
      const hidden = !el.contains(focused) && !el.matches(".carried, :has(.carried)")
        && !onCamera(bounds, view.current, viewport);
      if (hidden !== el.hasAttribute("data-camera-hidden")) el.toggleAttribute("data-camera-hidden", hidden);
      if (!hidden && el instanceof HTMLElement && el.dataset.mapItem) shown.add(el.dataset.mapItem);
    }
    const previous = cameraItemsRef.current;
    if (!previous || previous.size !== shown.size || [...shown].some((id) => !previous.has(id))) {
      cameraItemsRef.current = shown;
      startTransition(() => setCameraItems(shown));
    }
    if (layerRef.current) {
      if (movingCamera.current && s !== rendered.current.scale) layerRef.current.style.willChange = "transform";
      layerRef.current.style.transform = `translate(${tx}px, ${ty}px) scale(${s / rendered.current.scale})`;
    }
    vp.style.setProperty("--s", String(s));
    vp.style.setProperty("--tx", String(tx));
    vp.style.setProperty("--ty", String(ty));
    vp.dataset.scale = s.toFixed(3);
    saveView({ ...view.current, user: moved.current });
  }, []);
  const settleRef = useRef<() => void>(() => {});
  const gesture = useMemo(() => createGesture(paint, () => settleRef.current(), undefined, (active) => {
    movingCamera.current = active;
    const layer = layerRef.current;
    // Keep the old raster until the final semantic layout has committed.
    if (layer && active && view.current.s !== rendered.current.scale) layer.style.willChange = "transform";
    if (!active) flushMeasurements.current();
    if (vpRef.current) vpRef.current.dataset.cameraMoving = String(active);
  }), [paint]);
  useEffect(() => () => gesture.cancel(), [gesture]);
  const apply = useCallback(() => {
    gesture.cancel();
    paint();
    startTransition(() => {
      setScale(view.current.s);
      setLevel(levelOf(view.current.s));
    });
    if (rendered.current.scale === view.current.s && layerRef.current) layerRef.current.style.willChange = "auto";
  }, [gesture, paint]);
  useLayoutEffect(() => {
    rendered.current = { layout, scale };
    const vp = vpRef.current, layer = layerRef.current;
    if (!vp || !layer) return;
    layer.style.setProperty("--s", String(scale));
    layer.style.setProperty("--ls", String(layoutScale(scale)));
    layer.style.setProperty("--k", String(scale / layoutScale(scale)));
    layer.style.setProperty("--tx", "0");
    layer.style.setProperty("--ty", "0");
    gRef.current?.setAttribute("transform", `scale(${scale})`);
    const nodes: typeof cameraNodes.current = [];
    for (const el of layer.querySelectorAll<HTMLElement>(".map-plane > .map-node")) {
      const it = el.dataset.mapItem ? layout.items.get(el.dataset.mapItem) : undefined;
      const r = el.dataset.region ? layout.regions.find((r) => r.id === el.dataset.region) : undefined;
      if (it) nodes.push({ el, bounds: it });
      else if (r) {
        const h = Math.max(150, screenSizes[level].get(`region:${r.id}`) ?? 150) / scale;
        nodes.push({ el, bounds: { x: r.labelX, y: r.labelY - h, w: r.labelW, h } });
      }
    }
    for (const el of layer.querySelectorAll<SVGElement>(".contour")) {
      const r = layout.regions.find((r) => r.id === el.dataset.region);
      if (r) nodes.push({ el, bounds: r });
    }
    cameraNodes.current = nodes;
    vp.dataset.zoom = level;
    paint();
    if (!movingCamera.current && scale === view.current.s) layer.style.willChange = "auto";
  }, [layout, scale, level, paint, screenSizes]);

  // Focusing a field on a card (a note, an answer) makes the browser scroll the clipped viewport to show it,
  // which drags the zoom controls and legend along. Turn that scroll into a pan of the chart instead.
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onScroll = () => {
      const { scrollLeft: x, scrollTop: y } = vp;
      if (!x && !y) return;
      vp.scrollLeft = 0; vp.scrollTop = 0;
      view.current = { ...view.current, tx: view.current.tx - x, ty: view.current.ty - y };
      moved.current = true;
      apply();
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [apply]);

  /** Nearest item (screen space) to a point, in the layout for `lv` under view `v`. */
  const nearest = (lv: ZoomLevel, v: View, x: number, y: number) => {
    let best: Item | null = null, bd = Infinity;
    for (const it of layoutsRef.current(lv, v.s).items.values()) {
      const cx = (it.x + Math.min(it.w, 300) / 2) * v.s + v.tx, cy = (it.y + 20) * v.s + v.ty;
      const d = Math.hypot(cx - x, cy - y);
      if (d < bd) { bd = d; best = it; }
    }
    return best;
  };

  /** Bottom margin for Fit: above the tallest overlay on the chart's bottom edge (zoom controls, next ask, legend). */
  const fitBottom = () => {
    if (focusRef.current.group) return 24;
    const vp = vpRef.current;
    if (!vp) return 84;
    let edge = vp.clientHeight;
    for (const el of vp.querySelectorAll<HTMLElement>(".zoom-controls, .next-ask, .map-legend")) if (el.offsetParent) edge = Math.min(edge, el.offsetTop);
    return Math.max(84, vp.clientHeight - edge + FIT_GAP);
  };
  /** The scale Fit last chose; zoom out always reaches it, with room to spare. */
  const fitS = useRef(MIN_S);
  const minScale = () => Math.max(FLOOR_S, Math.min(MIN_S, fitS.current * 0.8));

  /** Fit everything: pick the most detailed level whose layout still fits. */
  const fit = useCallback((maxLevel?: ZoomLevel) => {
    zoomAnchor.current = null;
    const vp = vpRef.current;
    if (!vp) return;
    const W = vp.clientWidth, H = vp.clientHeight;
    const top = FIT_TOP, bottom = fitBottom(), side = FIT_SIDE;
    // Far goes below MIN_S when it must: there the chart shrinks as a whole, so some scale always fits.
    const ranges: [ZoomLevel, number, number][] = [["near", 0.88, 1], ["mid", 0.56, 0.879], ["far", FLOOR_S, 0.559]];
    let pick: [ZoomLevel, number] = ["far", FLOOR_S];
    for (const [lv, lo, hi] of ranges) {
      if (maxLevel && PRESETS[lv] > PRESETS[maxLevel]) continue;
      const fits = (s: number) => { const b = layoutsRef.current(lv, s).bounds; return b.w * s <= W - side * 2 + 1 && b.h * s <= H - top - bottom + 1; };
      if (fits(hi)) { pick = [lv, hi]; break; }
      if (!fits(lo)) continue;
      // The largest scale in the range that fits. Cell sizes depend on the scale, so search rather than solve.
      let a = lo, z = hi;
      for (let i = 0; i < 18 && z - a > 0.0005; i++) { const m = (a + z) / 2; if (fits(m)) a = m; else z = m; }
      pick = [lv, a]; break;
    }
    const [lv, s] = pick;
    fitS.current = s;
    const b = layoutsRef.current(lv, s).bounds;
    view.current = { s, tx: (W - b.w * s) / 2 - b.x * s, ty: top + Math.max(0, (H - top - bottom - b.h * s) / 2) - b.y * s };
    apply();
  }, [apply]);

  const zoomPoint = useRef({ x: 0, y: 0 });
  settleRef.current = () => {
    const v = view.current;
    if (v.s === rendered.current.scale) { apply(); return; }
    const { x, y } = zoomPoint.current;
    let anchor: Item | null = null, distance = Infinity;
    for (const it of rendered.current.layout.items.values()) {
      const d = Math.hypot((it.x + Math.min(it.w, 300) / 2) * v.s + v.tx - x, (it.y + 20) * v.s + v.ty - y);
      if (d < distance) { anchor = it; distance = d; }
    }
    const next = layoutsRef.current(levelOf(v.s), v.s);
    const after = anchor ? next.items.get(anchor.id) : undefined;
    zoomAnchor.current = after?.id ?? null;
    if (anchor && after) view.current = { ...v, tx: v.tx + (anchor.x - after.x) * v.s, ty: v.ty + (anchor.y - after.y) * v.s };
    apply();
  };
  /** Gesture input changes only the view; the chart's layout stays fixed until it settles. */
  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const vp = vpRef.current;
    if (!vp) return;
    const v = view.current;
    const x = cx ?? vp.clientWidth / 2, y = cy ?? vp.clientHeight / 2;
    const s = clamp(v.s * factor, minScale(), MAX_S), k = s / v.s;
    view.current = { s, tx: x - (x - v.tx) * k, ty: y - (y - v.ty) * k };
    vp.dataset.scale = s.toFixed(3);
    zoomPoint.current = { x, y };
    moved.current = true;
    gesture.update();
  }, [gesture]);

  /** Keep the chart in view after a jump: whole if it fits, else no empty margin past its edges. */
  const keepInView = (v: View, lv: ZoomLevel): View => {
    const vp = vpRef.current;
    if (!vp) return v;
    const b = layoutsRef.current(lv, v.s).bounds;
    const axis = (t: number, lo: number, size: number, avail: number, pad0: number, pad1: number) => {
      const a = pad0 - lo * v.s, z = avail - pad1 - (lo + size) * v.s;
      return a <= z ? clamp(t, a, z) : clamp(t, z, a);
    };
    return { s: v.s, tx: axis(v.tx, b.x, b.w, vp.clientWidth, 48, 48), ty: axis(v.ty, b.y, b.h, vp.clientHeight, 40, 84) };
  };

  /** Jump to a level preset, centring the last focused (or selected) node, else the one nearest the middle. */
  const lastFocused = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected ?? selectedWorker;
  const zoomTo = useCallback((s: number) => {
    zoomAnchor.current = null;
    const vp = vpRef.current;
    if (!vp) return;
    const W = vp.clientWidth, H = vp.clientHeight;
    const v = view.current;
    const cur = layoutsRef.current(levelOf(v.s), v.s).items;
    const pinned = [lastFocused.current, selectedRef.current].map((id) => (id ? cur.get(id) : undefined)).find(Boolean);
    const target = pinned ?? nearest(levelOf(v.s), v, W / 2, H / 2);
    const lv = levelOf(s);
    const it = target ? layoutsRef.current(lv, s).items.get(target.id) : null;
    if (it) view.current = keepInView({ s, tx: W / 2 - (it.x + Math.min(it.w, 340) / 2) * s, ty: H * 0.3 - it.y * s }, lv);
    else { const k = s / v.s; view.current = keepInView({ s, tx: W / 2 - (W / 2 - v.tx) * k, ty: H / 2 - (H / 2 - v.ty) * k }, lv); }
    moved.current = true;
    apply();
  }, [apply]);
  const pan = useCallback((dx: number, dy: number) => {
    view.current = { ...view.current, tx: view.current.tx + dx, ty: view.current.ty + dy };
    moved.current = true;
    gesture.update();
  }, [gesture]);

  /** Ease the view to (tx, ty) at the current scale, then settle; `done` runs once it is there. Reduced motion jumps. */
  const glideFrame = useRef(0);
  const glide = useCallback((tx: number, ty: number, done?: () => void) => {
    cancelAnimationFrame(glideFrame.current);
    const from = { ...view.current };
    const ms = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : Math.min(620, 260 + Math.hypot(tx - from.tx, ty - from.ty) * 0.35);
    moved.current = true;
    if (!ms) { view.current = { ...from, tx, ty }; apply(); done?.(); return; }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      view.current = { ...view.current, tx: from.tx + (tx - from.tx) * e, ty: from.ty + (ty - from.ty) * e };
      gesture.update();
      if (k < 1) glideFrame.current = requestAnimationFrame(step);
      else { apply(); done?.(); }
    };
    glideFrame.current = requestAnimationFrame(step);
  }, [apply, gesture]);
  useEffect(() => () => cancelAnimationFrame(glideFrame.current), []);

  useLayoutEffect(() => { apply(); }, [apply]);
  useLayoutEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const observer = new ResizeObserver(() => {
      const w = vp.clientWidth, h = vp.clientHeight;
      cameraViewport.current = { w, h };
      setViewportSize((previous) => previous?.w === w && previous.h === h ? previous : { w, h });
    });
    observer.observe(vp);
    return () => observer.disconnect();
  }, []);
  const previousLayout = useRef({ layout, scale, focusK });
  useLayoutEffect(() => {
    const previous = previousLayout.current.layout, previousScale = previousLayout.current.scale, previousFocus = previousLayout.current.focusK;
    previousLayout.current = { layout, scale, focusK };
    // Opening focus is framed by its flight. Once settled, a measured reflow
    // keeps the interacting idea in place, just as it does elsewhere on the map.
    if ((focusK && (openingFocus.current || flight.current)) || !moved.current || previous.level !== layout.level || previousScale !== scale || previousFocus !== focusK) return;
    const id = zoomAnchor.current ?? lastFocused.current ?? selectedRef.current;
    const before = id ? previous.items.get(id) : undefined;
    const after = id ? layout.items.get(id) : undefined;
    if (before && after && scale === view.current.s) {
      // A chip or title can wrap after a preset jump. Keep the focused node
      // in place while its measured neighbours are packed again.
      view.current = { ...view.current, tx: view.current.tx + (before.x - after.x) * scale, ty: view.current.ty + (before.y - after.y) * scale };
      apply();
    }
  }, [layout, scale, focusK, apply]);
  useLayoutEffect(() => {
    const nodes = vpRef.current?.querySelectorAll<HTMLElement>(".map-plane > .map-node");
    if (!nodes) return;
    // Heights wait in `pending` (per level and id) until the camera stops; a focused group is measured for Near.
    const pending = new Map<string, { lv: ZoomLevel; id: string; height: number }>();
    const flush = () => {
      if (movingCamera.current || semanticQueue.busy() || !pending.size) return;
      const measured = [...pending.values()];
      pending.clear();
      startTransition(() => setScreenSizes((previous) => {
        const next = { ...previous };
        let changed = false;
        for (const { lv, id, height } of measured) {
          if (next[lv].get(id) === height) continue;
          if (next[lv] === previous[lv]) next[lv] = new Map(previous[lv]);
          next[lv].set(id, height); changed = true;
        }
        return changed ? next : previous;
      }));
    };
    flushMeasurements.current = flush;
    const observer = new ResizeObserver((entries) => {
      const measured = entries.flatMap((entry) => {
        const node = entry.target;
        if (!(node instanceof HTMLElement) || node.hasAttribute("data-camera-simplified") || node.hasAttribute("data-semantic-pending")) return [];
        const id = node.dataset.sizeKey ?? node.dataset.mapItem ?? (node.dataset.region ? `region:${node.dataset.region}` : undefined);
        const lv: ZoomLevel = node.dataset.lv === "far" || node.dataset.lv === "mid" || node.dataset.lv === "near" ? node.dataset.lv : focus.group && (node.dataset.group ?? node.dataset.region) === focus.group ? "near" : level;
        const size = entry.borderBoxSize[0];
        return id && size ? [{ lv, id, height: Math.round(size.blockSize) }] : [];
      });
      for (const m of measured) pending.set(`${m.lv}\n${m.id}`, m);
      flush();
    });
    for (const node of nodes) observer.observe(node);
    return () => { observer.disconnect(); flushMeasurements.current = () => {}; };
  }, [regions, level, scale, focusK]);
  // A group just made from the strip comes into view, so it can be dragged onto.
  useLayoutEffect(() => {
    const vp = vpRef.current, id = reveal.current;
    const r = id ? layout.regions.find((x) => x.id === id) : undefined;
    if (!vp || !r) return;
    reveal.current = null;
    const s = view.current.s;
    view.current = { s, tx: vp.clientWidth / 2 - (r.x + r.w / 2) * s, ty: vp.clientHeight / 2 - (r.y + r.h / 2) * s };
    moved.current = true;
    apply();
  }, [layout, apply]);
  // "Show on map" (New's result, the Board page): glide to where it landed and mark it for a moment, once it is charted.
  const [landing, setLanding] = useState<Landing | null>(() => takeReveal());
  const landingMission = landing?.kind === "item"
    ? landing.board?.startsWith("mission:") ? landing.board.slice(8) : landing.place?.kind === "idea" ? landing.place.id : null
    : null;
  useEffect(() => onReveal(() => { const l = takeReveal(); if (l) setLanding(l); }), []);
  /** Mark what landed for a moment. A data attribute, not a class: React owns the node's className. */
  const mark = (el: HTMLElement | null) => {
    if (!el) return;
    delete el.dataset.landed;
    void el.offsetWidth;
    el.dataset.landed = "";
    setTimeout(() => { delete el.dataset.landed; }, 2000);
  };
  useLayoutEffect(() => {
    const vp = vpRef.current;
    if (!landing || !vp || !world.ready) return;
    if (landing.kind === "item") {
      revealedMission.current = landingMission;
      // A board item: zoom to where its card reads, then glide its card (or chip) to the middle.
      const want = landing.zoom;
      if (want && PRESETS[want] > view.current.s + 0.001) { zoomTo(PRESETS[want]); return; }
      const it = landing;
      let tries = 0, timer = 0;
      const sel = `.map-plane ${it.board ? `[data-note-board="${CSS.escape(it.board)}"] ` : ""}[data-board-item="${CSS.escape(it.id)}"]`;
      const find = () => {
        const el = vp.querySelector<HTMLElement>(sel);
        if (!el) {
          if (++tries < 40) { timer = window.setTimeout(find, 60); return; }
          setLanding(it.place ?? null);
          return;
        }
        setLanding(null);
        const done = () => { revealedMission.current = null; if (!it.quiet) mark(vp.querySelector<HTMLElement>(sel)); window.dispatchEvent(new CustomEvent("joyride:landed", { detail: { id: it.id } })); };
        // Glide the card to the upper middle; the chart may re-pack under it (its place grows), so look again
        // once there and correct, gliding at most three times.
        const settle = (left: number) => {
          const card = vp.querySelector<HTMLElement>(sel);
          if (!card) { done(); return; }
          const b = vp.getBoundingClientRect(), r = card.getBoundingClientRect();
          const inView = r.left > b.left + 24 && r.right < b.right - 24 && r.top > b.top + 24 && r.bottom < b.bottom - 84;
          if (inView || left === 0) { done(); return; }
          const dx = b.left + b.width / 2 - (r.left + Math.min(r.width, b.width - 96) / 2), dy = b.top + Math.max(FIT_TOP + 24, b.height * 0.3) - r.top;
          glide(view.current.tx + dx, view.current.ty + dy, () => requestAnimationFrame(() => requestAnimationFrame(() => settle(left - 1))));
        };
        settle(3);
      };
      find();
      return () => window.clearTimeout(timer);
    }
    revealedMission.current = null;
    const items = layout.regions.flatMap((r) => r.items);
    const hub = items.find((it) => it.kind === "firstmate");
    const box: { x: number; y: number; w: number; h: number; sel: string } | undefined = (() => {
      if (landing.kind === "region") { const r = layout.regions.find((x) => x.id === landing.id); return r ? { ...r, sel: `[data-region="${CSS.escape(r.id)}"].region-label` } : undefined; }
      const it = landing.kind === "idea" ? items.find((x) => x.kind === "mission" && x.id === landing.id)
        : landing.kind === "task" ? items.find((x) => x.kind === "mission" && [...x.m.tasks, ...x.m.landed].some((t) => t.id === landing.id)) ?? hub
        : hub;
      return it ? { ...it, sel: `[data-map-item="${CSS.escape(it.id)}"]` } : undefined;
    })();
    if (!box) return;
    setLanding(null);
    const s = view.current.s;
    glide(vp.clientWidth / 2 - (box.x + box.w / 2) * s, Math.max(FIT_TOP, (vp.clientHeight - box.h * s) / 2) - box.y * s, () => mark(vp.querySelector<HTMLElement>(box.sel)));
  }, [layout, landing, landingMission, glide, world.ready]);
  // Fit on first data, and again when the chart's contents change while the user hasn't moved it.
  useLayoutEffect(() => {
    if (!world.ready) return;
    if (fittedKey.current === null && moved.current) {
      // Zoomed before the chart loaded: keep that zoom and centre the chart under it.
      zoomTo(view.current.s); fittedKey.current = dataKey;
    } else if (fittedKey.current === null || (!moved.current && fittedKey.current !== dataKey)) {
      fit(); fittedKey.current = dataKey;
    } else if (!moved.current && vpRef.current && !focusRef.current.group) {
      // Refit when the chart no longer fits where it sits (it grew, or the window narrowed under it).
      const v = view.current, b = getLayout(levelOf(v.s), v.s).bounds, vp = vpRef.current;
      const left = b.x * v.s + v.tx, top = b.y * v.s + v.ty;
      if (left < -1 || top < -1 || left + b.w * v.s > vp.clientWidth + 1 || top + b.h * v.s > vp.clientHeight - fitBottom() + FIT_GAP + 1
        || b.w * v.s > vp.clientWidth - FIT_SIDE * 2 + 1 || b.h * v.s > vp.clientHeight - FIT_TOP - fitBottom() + 1) fit(levelOf(v.s));
    }
  }, [dataKey, world.ready, fit, zoomTo, getLayout]);

  // ---------- focus: a group (or an idea in it) opens in place and the camera flies to frame it ----------
  /** The view to come back to at each focus (keyed by focusKey; "" is the whole map). */
  const returnTo = useRef(new Map<string, View>());
  const shownFocus = useRef<Focus>(NO_FOCUS);
  const flyTo = useCallback((target: () => View | null, user = true, arrived?: () => void) => {
    const vp = vpRef.current;
    if (!vp || !target()) return;
    flight.current?.cancel();
    gesture.cancel();
    moved.current = true;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let mine = view.current;
    let finished = false;
    const running = fly({ ...view.current }, () => target() ?? view.current, { w: vp.clientWidth, h: vp.clientHeight }, reduce ? 0 : 560, (v) => {
      // A pan, zoom or focus pan since the last frame wins over the flight.
      if (view.current !== mine) { flight.current = null; openingFocus.current = false; return false; }
      view.current = mine = v;
      // The camera path: painted once per frame, promoted while it moves, measured and re-rastered when it settles.
      gesture.update();
    }, () => { finished = true; flight.current = null; moved.current = user; apply(); arrived?.(); });
    flight.current = finished ? null : running;
  }, [gesture, apply]);
  useEffect(() => () => flight.current?.cancel(), []);
  /** Frame the whole reading layout; text keeps its screen size while columns and spacing fit the canvas. */
  const framing = useCallback((): View | null => {
    const vp = vpRef.current, f = focusRef.current;
    if (!vp || !f.group) return null;
    const viewport = { w: vp.clientWidth, h: vp.clientHeight };
    const pad = { top: 32, bottom: 32 };
    const rect = (s: number) => {
      const l = layoutsRef.current(levelOf(s), s);
      return f.idea ? l.items.get(f.idea) : l.regions.find((x) => x.id === f.group);
    };
    const s = largestFit((s) => {
      const r = rect(s);
      return !!r && r.w * s <= viewport.w - 64 && r.h * s <= viewport.h - pad.top - pad.bottom;
    }, MIN_S, 1);
    const r = rect(s);
    return r ? frame(r, s, viewport, pad) : null;
  }, []);
  const [focusArrived, setFocusArrived] = useState(0);
  useEffect(() => {
    if (!focus.group || !openingFocus.current || flight.current) return;
    const timer = setTimeout(() => {
      openingFocus.current = false;
      flyTo(framing);
    }, 120);
    return () => clearTimeout(timer);
  }, [layout, focusArrived, framing, flyTo, focus.group]);
  useLayoutEffect(() => {
    if (!world.ready) return;
    const from = shownFocus.current, to = focus;
    if (focusKey(from) === focusK) return;
    shownFocus.current = to;
    openingFocus.current = false;
    returnTo.current.set(focusKey(from), { ...view.current, user: moved.current });
    const first = to.group ? layout.regions.find((r) => r.id === to.group)?.items[0] : undefined;
    zoomAnchor.current = to.idea ?? first?.id ?? null;
    const back = isOutward(from, to) ? returnTo.current.get(focusK) : undefined;
    if (back) flyTo(() => back, back.user !== false);
    else if (to.group) {
      openingFocus.current = true;
      flyTo(framing, true, () => setFocusArrived((n) => n + 1));
    }
  }, [focusK, world.ready, layout, flyTo, framing]);
  const enterFocus = useCallback((f: Focus) => { if (focusKey(f) !== focusKey(focusRef.current) || route.name !== "map") go(focusPath(f)); }, [route.name]);
  const stepOut = useCallback(() => {
    // The hash, not the last render: two quick presses step out twice.
    const f = focusOf(parse());
    if (!f.group) return false;
    go(focusPath(f.idea ? { group: f.group, idea: null } : NO_FOCUS));
    return true;
  }, []);
  /** The region under a point in the viewport (world hit test on the laid-out rectangles). */
  const regionAt = (x: number, y: number) => {
    const vp = vpRef.current;
    if (!vp) return undefined;
    const b = vp.getBoundingClientRect(), v = view.current;
    const wx = (x - b.left - v.tx) / v.s, wy = (y - b.top - v.ty) / v.s;
    return rendered.current.layout.regions.find((q) => q.kind !== "firstmate" && wx >= q.x && wx <= q.x + q.w && wy >= q.y && wy <= q.y + q.h);
  };

  // Scrolling pans the canvas, both ways (shift+wheel pans sideways on a mouse). A trackpad pinch
  // (which browsers deliver as ctrl+wheel) and ctrl or cmd+wheel zoom around the cursor.
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".map-ui")) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.clientHeight : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        const r = vp.getBoundingClientRect();
        // A pinch sends small deltas; a ctrl-held mouse wheel sends ~100 per notch.
        zoomAt(Math.exp(-dy * (e.ctrlKey && Math.abs(dy) < 50 ? 0.01 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      if (e.shiftKey && !dx) pan(-dy, 0);
      else pan(-dx, -dy);
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomAt, pan]);

  // ---------- regrouping: drag a session or a mission to another group ----------
  const dragsRef = useRef(drags);
  dragsRef.current = drags;
  const missionsById = useMemo(() => new Map(world.missions.map((m) => [m.id, m])), [world.missions]);
  const missionsRef = useRef(missionsById);
  missionsRef.current = missionsById;
  const carry = useRef<{ item: DragItem; id: number; x: number; y: number; active: boolean; target: DropTarget | null; edge?: { dx: number; dy: number; x: number; y: number } } | null>(null);
  const drift = useRef<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [carrying, setCarrying] = useState<{ item: DragItem; target: DropTarget | null } | null>(null);
  /** The last change and how to take it back: a commit (moves and group changes), or a set-aside or accepted suggestion. */
  const [toast, setToast] = useState<{ text: string; commit: string | null; error?: boolean; revert?: { label: string; run: () => Promise<string> } } | null>(null);
  const [naming, setNaming] = useState<Exclude<DragItem, { kind: "task" }> | null>(null);
  /** A group just made from the strip: the chart pans to it once it is laid out. */
  const reveal = useRef<string | null>(null);
  /** The Move to menu, opened from a card's grip: the keyboard (and no-drag) path to every move a drag makes. */
  const [menu, setMenu] = useState<{ item: DragItem; anchor: HTMLElement; left: number; top: number } | null>(null);
  const [tip, setTip] = useState(() => { try { return localStorage.getItem(TIP_KEY) !== "1"; } catch { return true; } });
  const dismissTip = () => { setTip(false); try { localStorage.setItem(TIP_KEY, "1"); } catch { /* storage blocked: hidden for this page */ } };

  /** What a press on `el` picks up: the nearest enclosing card the chart knows how to move. */
  const pickUp = (el: HTMLElement | null): DragItem | undefined => {
    for (let n = el?.closest<HTMLElement>("[data-drag]"); n; n = n.parentElement?.closest<HTMLElement>("[data-drag]") ?? null) {
      const key = n.dataset.drag!;
      // Board items carry what a move needs on the card itself: they come from the notes, not the world.
      const item = dragsRef.current.get(key) ?? (key.startsWith("n:") && n.dataset.dragFrom ? { kind: "note" as const, id: key.slice(2), label: n.dataset.dragLabel || "Note", from: n.dataset.dragFrom } : undefined);
      if (item) return item;
    }
    return undefined;
  };

  /** The drop target under a screen point: a dock zone, then (for sessions) a mission card, then a region. */
  const targetAt = (item: DragItem, x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const zone = el?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
    if (zone === "unfiled" && item.kind === "session" && (item.from || item.lens)) return { kind: "unfiled" };
    if (zone === "unfiled" && item.kind === "note" && item.from !== "global") return { kind: "unfiled" };
    if (zone === "new-group" && item.kind !== "task" && item.kind !== "note") return { kind: "new-group" };
    if (zone && zone.startsWith("region:")) {
      const r = rendered.current.layout.regions.find((x) => x.id === zone.slice(7));
      if (r) return regionTarget(item, r);
    }
    if (el?.closest(".map-ui")) return null;
    const mid = el?.closest<HTMLElement>("[data-mission]")?.dataset.mission;
    const m = mid ? missionsRef.current.get(mid) : undefined;
    if (m && (item.kind === "session" || item.kind === "task" || item.kind === "note")) return missionTarget(item, m);
    const vp = vpRef.current;
    if (!vp) return null;
    const b = vp.getBoundingClientRect(), v = view.current;
    const wx = (x - b.left - v.tx) / v.s, wy = (y - b.top - v.ty) / v.s;
    const r = rendered.current.layout.regions.find((q) => wx >= q.x && wx <= q.x + q.w && wy >= q.y && wy <= q.y + q.h);
    return r ? regionTarget(item, r) : null;
  };

  /** Make a move. From the keyboard, focus lands on Undo so the move can be taken back at once. */
  async function runMove(body: Record<string, unknown>, focusUndo = false) {
    try {
      const r = await post<{ commit: string | null; message: string }>("/api/missions/move", body);
      setToast({ text: r.message, commit: r.commit });
      if (r.commit) dismissTip();
      if (focusUndo) requestAnimationFrame(() => vpRef.current?.closest(".map-root")?.querySelector<HTMLElement>(".map-toast .btn")?.focus({ preventScroll: true }));
    } catch (e: any) { setToast({ text: `That move didn't happen: ${e.message}`, commit: null, error: true }); }
  }
  async function undo(commit: string) {
    try { const r = await post<{ message: string }>("/api/missions/move/undo", { commit }); setToast({ text: r.message, commit: null }); }
    catch (e: any) { setToast({ text: `Undo didn't work: ${e.message}`, commit: null, error: true }); }
  }
  async function revert(run: () => Promise<string>) {
    try { setToast({ text: await run(), commit: null }); }
    catch (e: any) { setToast({ text: `Undo didn't work: ${e.message}`, commit: null, error: true }); }
  }
  /** A group change (create, rename, delete, merge): one commit, undone like a move. */
  async function groupOp(op: "create" | "rename" | "delete" | "merge", body: Record<string, unknown>) {
    try {
      const r = await post<{ commit: string | null; message: string; lens?: string | null }>(`/api/lenses/${op}`, body);
      setToast({ text: r.message, commit: r.commit });
      if (op === "create" && r.lens) reveal.current = `lens:${r.lens}`;
      if (r.commit) dismissTip();
      return true;
    } catch (e: any) { setToast({ text: `That didn't happen: ${e.message}`, commit: null, error: true }); return false; }
  }
  /** Set unfiled work aside: off the chart until it does something new. */
  async function hideOnMap(key: string) {
    try {
      const r = await post<{ message: string }>("/api/missions/hide", { key });
      setToast({ text: r.message, commit: null, revert: { label: "Undo", run: async () => (await post<{ message: string }>("/api/missions/unhide", { key })).message } });
    } catch (e: any) { setToast({ text: `It's still on the chart: ${e.message}`, commit: null, error: true }); }
  }
  /** Accept the idea Joyride suggested for this work; Undo puts the suggestion back and gives its sessions back. */
  async function acceptSuggestion(p: MissionProposal) {
    try {
      const r = await post<{ mission: { title: string } }>(`/api/missions/proposals/${encodeURIComponent(p.id)}/accept`, { edits: {} });
      setToast({ text: `Filed into ${r.mission.title}.`, commit: null, revert: { label: "Undo", run: async () => (await post<{ message: string }>(`/api/missions/proposals/${encodeURIComponent(p.id)}/reopen`, {})).message } });
    } catch (e: any) { setToast({ text: `The suggestion wasn't accepted: ${e.message}`, commit: null, error: true }); }
  }
  /** A board item to another place (PUT its note's scope); Undo puts it back where it was. */
  async function moveItem(item: Extract<DragItem, { kind: "note" }>, t: DropTarget, focusUndo: boolean) {
    const scope = noteScopeOf(t);
    if (!scope) return;
    const put = (to: string) => api(`/api/notes/${encodeURIComponent(item.id)}`, { method: "PUT", json: { scope: to } });
    const name = t.kind === "unfiled" ? "Unfiled" : t.kind === "mission" || t.kind === "lens" ? t.title : "";
    try {
      markPlaced(item.id);
      await put(scope);
      setToast({ text: `Moved “${item.label}” to ${name}.`, commit: null, revert: { label: "Undo", run: async () => { await put(item.from); setLanding({ kind: "item", id: item.id, board: item.from }); return `“${item.label}” is back where it was.`; } } });
      setLanding({ kind: "item", id: item.id, board: scope });
      if (focusUndo) requestAnimationFrame(() => vpRef.current?.closest(".map-root")?.querySelector<HTMLElement>(".map-toast .btn")?.focus({ preventScroll: true }));
    } catch (e: any) { setToast({ text: `That move didn't happen: ${e.message}`, commit: null, error: true }); }
  }
  function drop(item: DragItem, t: DropTarget, fromMenu = false) {
    if (item.kind === "note") { void moveItem(item, t, fromMenu); return; }
    if (t.kind === "new-group" && item.kind !== "task") { setNaming(item); return; }
    const body = moveBody(item, t);
    if (body) void runMove(body, fromMenu);
  }
  /** A click on a card's grip (not the end of a drag: that click is suppressed) opens Move to beside it. */
  const openMenu = (handle: HTMLElement) => {
    const item = pickUp(handle);
    const vp = vpRef.current;
    if (!item || !vp) return;
    if (menu?.anchor === handle) { setMenu(null); return; }
    const b = vp.getBoundingClientRect(), r = handle.getBoundingClientRect();
    const W = 300, H = 360;
    const left = clamp(r.right - b.left + 6, 12, Math.max(12, b.width - W - 12));
    const top = r.bottom - b.top + H + 12 > b.height ? Math.max(12, r.top - b.top - H + r.height) : r.top - b.top;
    setMenu({ item, anchor: handle, left, top });
  };
  const closeMenu = useCallback((refocus: boolean) => {
    setMenu((m) => { if (m && refocus && m.anchor.isConnected) m.anchor.focus({ preventScroll: true }); return null; });
  }, []);
  /** The idea Joyride suggests for a session (a pending proposal that holds it): accepted in place on its card. */
  const suggestFor = useMemo(() => {
    const at = new Map<string, MissionProposal>();
    for (const p of proposals.data ?? []) if ((p.status ?? "pending") === "pending") for (const r of p.sessions) { const k = `${r.source}:${r.id}`; if (!at.has(k)) at.set(k, p); }
    return at;
  }, [proposals.data]);
  const whereOf = useMemo(() => {
    const at = new Map<string, string>();
    for (const r of regions) for (const m of r.missions) at.set(m.id, r.title);
    return at;
  }, [regions]);
  const menuList = useMemo<MenuTarget[]>(() => {
    if (!menu) return [];
    const item = menu.item;
    const home = item.kind === "mission" ? regions.find((r) => r.id === item.home)?.title : undefined;
    const open = world.missions.filter((m) => archive || !offChart(m));
    return menuTargets(item, open, world.lenses, (id) => whereOf.get(id), home);
  }, [menu, regions, world.missions, world.lenses, whereOf, archive]);
  useEffect(() => {
    if (!toast || toast.error) return;
    const t = setTimeout(() => setToast((x) => (x === toast ? null : x)), toast.commit || toast.revert ? 12000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Drag to pan; two pointers pinch; a pointer that starts on a session or mission carries it instead.
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number } | null>(null);
  const suppressClick = useRef(false);
  // ---------- moving groups: drag a group by its name; it lands on the free spot nearest the drop ----------
  const groupCarry = useRef<{ id: string; pointer: number; x: number; y: number; tx: number; ty: number; active: boolean; gx: number; gy: number; els: (HTMLElement | SVGGElement)[]; edge?: { dx: number; dy: number } } | null>(null);
  const [movingGroup, setMovingGroup] = useState<string | null>(null);
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearShift = useRef<(HTMLElement | SVGGElement)[]>([]);
  const groupEls = (id: string): (HTMLElement | SVGGElement)[] => {
    const vp = vpRef.current;
    if (!vp) return [];
    const q = cssString(id);
    return [...vp.querySelectorAll<HTMLElement>(`.map-plane > .map-node[data-group=${q}], .map-plane > .map-node[data-region=${q}]`), ...vp.querySelectorAll<SVGGElement>(`.map-svg g[data-group=${q}]`)];
  };
  const shiftGroup = (c: NonNullable<typeof groupCarry.current>) => {
    for (const el of c.els) {
      if (el instanceof SVGGElement) el.setAttribute("transform", `translate(${c.gx} ${c.gy})`);
      else { el.style.setProperty("--gx", String(c.gx)); el.style.setProperty("--gy", String(c.gy)); }
    }
  };
  const unshift = (els: (HTMLElement | SVGGElement)[]) => {
    for (const el of els) {
      el.removeAttribute("data-lifted");
      if (el instanceof SVGGElement) el.removeAttribute("transform");
      else { el.style.removeProperty("--gx"); el.style.removeProperty("--gy"); }
    }
  };
  /** Follow the pointer in world units, including any drift the chart made under it. */
  const followPointer = (c: NonNullable<typeof groupCarry.current>, x: number, y: number) => {
    const v = view.current;
    c.gx = (x - c.x - (v.tx - c.tx)) / v.s;
    c.gy = (y - c.y - (v.ty - c.ty)) / v.s;
    shiftGroup(c);
  };
  const moveGroupCarry = (e: React.PointerEvent) => {
    const c = groupCarry.current!, vp = vpRef.current!;
    if (!c.active) {
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 5) return;
      c.active = true;
      c.els = groupEls(c.id);
      for (const el of c.els) el.setAttribute("data-lifted", "");
      try { vp.setPointerCapture(e.pointerId); } catch {}
      vp.classList.add("moving-group");
      setMovingGroup(c.id);
    }
    const b = vp.getBoundingClientRect();
    const edge = (p: number, lo: number, hi: number) => (p < lo + 36 ? 12 : p > hi - 36 ? -12 : 0);
    c.edge = { dx: edge(e.clientX, b.left, b.right), dy: edge(e.clientY, b.top, b.bottom) };
    const px = e.clientX, py = e.clientY;
    if ((c.edge.dx || c.edge.dy) && drift.current === null) {
      const step = () => {
        const cc = groupCarry.current;
        if (!cc?.active || !cc.edge || (!cc.edge.dx && !cc.edge.dy)) { drift.current = null; return; }
        pan(cc.edge.dx, cc.edge.dy);
        followPointer(cc, px, py);
        drift.current = requestAnimationFrame(step);
      };
      drift.current = requestAnimationFrame(step);
    }
    followPointer(c, px, py);
  };
  /** Put a group at a world position: the whole arrangement is kept, so every group stays where the captain sees it. */
  async function placeGroup(id: string, at: Pos, title: string) {
    const lv = level, ls = layoutScale(scale), sp = spread(lv, ls);
    // The arrangement is kept without any focus: a focused group's neighbours only stand aside while it is open.
    const base = focusRef.current.group ? layoutsRef.current(lv, scale, undefined, true) : rendered.current.layout;
    const here = base.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, movable: r.kind !== "firstmate" }));
    const next = arrangementAfterDrop(here, id, at, sp);
    // Where it really lands (the nearest free spot), so the stored arrangement is what the chart shows.
    const landed = layoutsRef.current(lv, scale, next, true).regions.find((r) => r.id === id);
    if (landed) next.set(id, toStored(landed, sp));
    const vp = vpRef.current;
    if (vp) {
      vp.classList.add("settling");
      if (settling.current) clearTimeout(settling.current);
      settling.current = setTimeout(() => vp.classList.remove("settling"), 480);
    }
    setPlacing(next);
    try {
      const r = await post<{ commit: string | null; message: string }>("/api/missions/map/layout", { positions: Object.fromEntries(next), moved: id, title });
      setToast({ text: r.message, commit: r.commit });
      if (r.commit) dismissTip();
      await placedApi.reload();
    } catch (e: any) {
      setToast({ text: `${title} didn't move: ${e.message}`, commit: null, error: true });
    } finally { setPlacing(null); }
  }
  const endGroupCarry = (e: React.PointerEvent | null, cancel = false) => {
    const c = groupCarry.current;
    groupCarry.current = null;
    if (!c?.active) return;
    const vp = vpRef.current;
    vp?.classList.remove("moving-group");
    if (e) try { vp?.releasePointerCapture(e.pointerId); } catch {}
    setMovingGroup(null);
    suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0);
    const r = rendered.current.layout.regions.find((x) => x.id === c.id);
    if (cancel || !r || (Math.abs(c.gx) < 1 && Math.abs(c.gy) < 1)) { unshift(c.els); return; }
    // The shift stays until the chart is laid out with the new position, so the group never jumps back.
    clearShift.current = c.els;
    void placeGroup(c.id, { x: r.x + c.gx, y: r.y + c.gy }, r.title);
  };
  useLayoutEffect(() => {
    if (!clearShift.current.length) return;
    unshift(clearShift.current);
    clearShift.current = [];
  }, [layout]);
  // Escape puts a group being moved back where it was.
  useEffect(() => {
    if (!movingGroup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !groupCarry.current) return;
      e.preventDefault(); e.stopPropagation();
      endGroupCarry(null, true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [movingGroup]);
  /** Alt and an arrow key on a group's name moves it a step (the keyboard path to moving groups). */
  const nudgeGroup = (id: string, dx: number, dy: number) => {
    const r = rendered.current.layout.regions.find((x) => x.id === id);
    if (!r) return;
    const step = 120 / Math.max(view.current.s, 0.2);
    clearShift.current = [];
    void placeGroup(id, { x: r.x + dx * step, y: r.y + dy * step }, r.title);
  };
  const resetGroup = async (id: string) => {
    try {
      const r = await post<{ commit: string | null; message: string }>("/api/missions/map/layout", { group: id, reset: true });
      setToast({ text: r.message, commit: r.commit });
    } catch (e: any) { setToast({ text: `That didn't happen: ${e.message}`, commit: null, error: true }); }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (e.button === 0 && !el.closest(".map-ui")) trackGroup(e.clientX, e.clientY, true);
    // A group is picked up by its name (not its menu or rename field); a click without moving focuses it.
    const label = e.button === 0 && pointers.current.size === 0 ? el.closest<HTMLElement>(".region-label[data-region]") : null;
    if (label && !el.closest(".rl-menu, .rl-form, a, input, textarea, button:not(.rl-focus)") && label.dataset.region !== "firstmate") {
      groupCarry.current = { id: label.dataset.region!, pointer: e.pointerId, x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, active: false, gx: 0, gy: 0, els: [] };
      return;
    }
    // Controls on a card keep their clicks; a card's grip is the one button that also carries the card.
    if (e.button !== 0 || (!el.closest("[data-drag-handle]") && el.closest(".map-ui, .ask-card, button, input, textarea, select, label"))) return;
    const item = pointers.current.size === 0 ? pickUp(el) : undefined;
    if (item) { carry.current = { item, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, target: null }; return; }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.current.s };
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty, moved: false };
  };
  const moveCarry = (e: React.PointerEvent) => {
    const c = carry.current!;
    const vp = vpRef.current!;
    if (!c.active) {
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 5) return;
      c.active = true;
      try { vp.setPointerCapture(e.pointerId); } catch {}
      vp.classList.add("carrying");
      setCarrying({ item: c.item, target: null });
    }
    // Near an edge, the chart keeps drifting (even while the pointer rests there) so far groups come into reach.
    const b = vp.getBoundingClientRect();
    const edge = (p: number, lo: number, hi: number) => (p < lo + 36 ? 12 : p > hi - 36 ? -12 : 0);
    c.edge = { dx: edge(e.clientX, b.left, b.right), dy: edge(e.clientY, b.top, b.bottom), x: e.clientX, y: e.clientY };
    if ((c.edge.dx || c.edge.dy) && drift.current === null) {
      const step = () => {
        const cc = carry.current;
        if (!cc?.active || !cc.edge || (!cc.edge.dx && !cc.edge.dy)) { drift.current = null; return; }
        pan(cc.edge.dx, cc.edge.dy);
        const t = targetAt(cc.item, cc.edge.x, cc.edge.y);
        if (targetKey(t) !== targetKey(cc.target)) { cc.target = t; setCarrying({ item: cc.item, target: t }); }
        drift.current = requestAnimationFrame(step);
      };
      drift.current = requestAnimationFrame(step);
    }
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX - b.left + 16}px, ${e.clientY - b.top - 74}px)`;
    const t = targetAt(c.item, e.clientX, e.clientY);
    if (targetKey(t) !== targetKey(c.target)) { c.target = t; setCarrying({ item: c.item, target: t }); }
  };
  const endCarry = (e: React.PointerEvent, cancel = false) => {
    const c = carry.current;
    carry.current = null;
    if (!c?.active) return;
    vpRef.current?.classList.remove("carrying");
    try { vpRef.current?.releasePointerCapture(e.pointerId); } catch {}
    setCarrying(null);
    suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0);
    if (!cancel && c.target) drop(c.item, c.target);
  };
  /**
   * The group the captain rests the pointer on (or clicks in) becomes the current group, New's default home for a
   * note. Crossing a group on the way to the rail doesn't count: it must hold the pointer for a moment. Open water
   * keeps the last; a place that isn't a group (the hub, a repo or Unfiled group) clears it.
   */
  const hoverFrame = useRef(0);
  const dwell = useRef<{ key: string; timer: number } | null>(null);
  const groupAt = (x: number, y: number) => {
    const vp = vpRef.current;
    if (!vp) return undefined;
    const b = vp.getBoundingClientRect(), v = view.current;
    const wx = (x - b.left - v.tx) / v.s, wy = (y - b.top - v.ty) / v.s;
    return rendered.current.layout.regions.find((q) => wx >= q.x && wx <= q.x + q.w && wy >= q.y && wy <= q.y + q.h);
  };
  const asCurrent = (r: RegionOut) => (r.lens && (r.kind === "lens" || r.kind === "spec") ? { id: r.lens, title: r.title } : null);
  const trackGroup = (x: number, y: number, now = false) => {
    if (hoverFrame.current && !now) return;
    const run = () => {
      hoverFrame.current = 0;
      const r = groupAt(x, y);
      if (!r) return;
      if (now) { if (dwell.current) window.clearTimeout(dwell.current.timer); dwell.current = null; setCurrentGroup(asCurrent(r)); return; }
      if (dwell.current?.key === r.id) return;
      if (dwell.current) window.clearTimeout(dwell.current.timer);
      dwell.current = { key: r.id, timer: window.setTimeout(() => { dwell.current = null; setCurrentGroup(asCurrent(r)); }, 450) };
    };
    if (now) run(); else hoverFrame.current = requestAnimationFrame(run);
  };
  useEffect(() => () => { cancelAnimationFrame(hoverFrame.current); if (dwell.current) window.clearTimeout(dwell.current.timer); }, []);
  const onPointerMove = (e: React.PointerEvent) => {
    if (groupCarry.current?.pointer === e.pointerId) { moveGroupCarry(e); return; }
    if (e.pointerType === "mouse" && !carry.current && !drag.current?.moved) trackGroup(e.clientX, e.clientY);
    if (carry.current?.id === e.pointerId) { moveCarry(e); return; }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const vp = vpRef.current!;
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const r = vp.getBoundingClientRect();
      zoomAt((pinch.current.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.d) / view.current.s, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; try { vp.setPointerCapture(e.pointerId); } catch {} vp.classList.add("dragging"); }
    view.current = { ...view.current, tx: d.tx + dx, ty: d.ty + dy };
    moved.current = true;
    gesture.update();
  };
  const endPointer = (e: React.PointerEvent) => {
    if (groupCarry.current?.pointer === e.pointerId) { endGroupCarry(e, e.type === "pointercancel"); return; }
    if (carry.current?.id === e.pointerId) { endCarry(e, e.type === "pointercancel"); return; }
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (drag.current?.moved) { suppressClick.current = true; setTimeout(() => { suppressClick.current = false; }, 0); }
    drag.current = null;
    vpRef.current?.classList.remove("dragging");
    if (pointers.current.size === 0 && gesture.active()) gesture.finish();
  };
  // Escape puts a carried item back where it was.
  useEffect(() => {
    if (!carrying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !carry.current) return;
      e.preventDefault(); e.stopPropagation();
      // Let the pointer go too, so the click that ends the press lands on the card, not the open chart.
      try { vpRef.current?.releasePointerCapture(carry.current.id); } catch {}
      carry.current = null;
      vpRef.current?.classList.remove("carrying");
      setCarrying(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [carrying]);

  // ---------- next ask: walk every open ask on the chart, the captain's calls first ----------
  const askHome = useMemo(() => {
    const at = new Map<string, string>();
    for (const m of world.missions) {
      if (!archive && offChart(m)) continue;
      for (const a of m.asks) at.set(a.id, m.id);
      for (const t of m.tasks) for (const a of t.asks) at.set(a.id, m.id);
    }
    for (const a of world.firstmate.asks) at.set(a.id, "firstmate");
    for (const t of world.firstmate.orphans) for (const a of t.asks) at.set(a.id, "firstmate:orphans");
    return at;
  }, [world.missions, world.firstmate, archive]);
  const asksInOrder = useMemo(() => askOrder(world.asks.filter((a) => askHome.has(a.id))), [world.asks, askHome]);
  const [askFocus, setAskFocus] = useState<string | null>(null);
  const asksRef = useRef({ list: asksInOrder, home: askHome, focus: askFocus });
  asksRef.current = { list: asksInOrder, home: askHome, focus: askFocus };
  const nextAsk = useCallback(() => {
    const { list, home, focus } = asksRef.current;
    if (!list.length) return;
    const i = focus ? list.findIndex((a) => a.id === focus) : -1;
    const ask = list[(i + 1) % list.length];
    const item = home.get(ask.id)!;
    lastFocused.current = item;
    setAskFocus(ask.id);
    // Near zoom shows the answer controls; centre the item, then bring the ask itself into view.
    zoomTo(PRESETS.near);
    const settle = (tries: number) => requestAnimationFrame(() => {
      const vp = vpRef.current;
      const el = vp?.querySelector<HTMLElement>(`.map-plane [data-ask="${CSS.escape(ask.id)}"]`);
      if (!vp || !el) { if (tries > 0) settle(tries - 1); return; }
      const b = vp.getBoundingClientRect(), r = el.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (r.left + r.width / 2), dy = b.top + b.height * 0.32 - r.top;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pan(dx, dy);
      el.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    });
    settle(12);
  }, [zoomTo, pan]);
  useEffect(() => { if (askFocus && !askHome.has(askFocus)) setAskFocus(null); }, [askFocus, askHome]);

  // Keyboard: + / - zoom, 0 fits, arrows pan (when no pane is open over the map).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector(".palette-backdrop")) return;
      const inMap = !e.target || e.target === document.body || vpRef.current?.contains(e.target as Node);
      switch (e.key) {
        case "+": case "=": e.preventDefault(); zoomAt(1.25); break;
        case "-": case "_": e.preventDefault(); zoomAt(0.8); break;
        case "0": e.preventDefault(); moved.current = false; fit(); break;
        case "Escape": if (!e.defaultPrevented && !carry.current && stepOut()) e.preventDefault(); break;
        case "ArrowLeft": if (inMap) { e.preventDefault(); pan(90, 0); } break;
        case "ArrowRight": if (inMap) { e.preventDefault(); pan(-90, 0); } break;
        case "ArrowUp": if (inMap) { e.preventDefault(); pan(0, 90); } break;
        case "ArrowDown": if (inMap) { e.preventDefault(); pan(0, -90); } break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpen, zoomAt, fit, pan, stepOut]);

  // Palette commands can ask for a zoom level.
  useEffect(() => {
    const restore = (e: Event) => {
      const v = (e as CustomEvent<View>).detail;
      if (!v || !Number.isFinite(v.s) || !Number.isFinite(v.tx) || !Number.isFinite(v.ty)) return;
      view.current = v; moved.current = true; apply();
    };
    const f = (e: Event) => {
      const lv = (e as CustomEvent).detail as ZoomLevel | "fit";
      if (lv === "fit") { moved.current = false; fit(); } else zoomTo(PRESETS[lv]);
    };
    window.addEventListener("joyride:map-zoom", f);
    window.addEventListener("joyride:map-view", restore);
    return () => { window.removeEventListener("joyride:map-zoom", f); window.removeEventListener("joyride:map-view", restore); };
  }, [fit, zoomTo, apply]);

  // Keyboard focus on an off-screen node pans it into view.
  const onFocusNode = (it: Item) => (e: React.FocusEvent) => {
    zoomAnchor.current = null;
    lastFocused.current = it.id;
    const home = rendered.current.layout.regions.find((r) => r.items.some((x) => x.id === it.id));
    if (home) setCurrentGroup(asCurrent(home));
    const vp = vpRef.current;
    if (!vp || !(e.target as HTMLElement).matches(":focus-visible")) return;
    const { s, tx, ty } = view.current;
    const x = it.x * s + tx, y = it.y * s + ty, w = it.w * s;
    if (x < 24 || y < 24 || x + w > vp.clientWidth - 24 || y + 80 > vp.clientHeight - 24) {
      view.current = { s, tx: vp.clientWidth / 2 - (it.x + it.w / 2) * s, ty: vp.clientHeight / 3 - it.y * s };
      moved.current = true;
      apply();
    }
  };

  /** A click on an idea's card (not its links or controls) focuses it in place: everything about it, on the canvas. */
  const openMission = (id: string, group: string) => (e: React.MouseEvent) => {
    if (suppressClick.current || (e.target as HTMLElement).closest("a, button, input, textarea, select, label, .ask-card, .map-notes")) return;
    e.stopPropagation();
    enterFocus({ group, idea: id });
  };

  /** The detail a node in a region shows: a focused group opens at Near whatever the zoom. */
  const lvOf = (region: string): ZoomLevel => (region === focus.group ? "near" : level);
  // Everything outside the focus steps back. A style rule, so nodes need no focus prop and new ones follow.
  const dimRule = focus.group ? (() => {
    const g = cssString(focus.group), keep = focus.idea ? `[data-mission=${cssString(focus.idea)}], .region-label[data-region=${g}]` : `[data-group=${g}], [data-region=${g}]`;
    return `.map-viewport[data-focus] .map-plane > .map-node:not(${keep}) { opacity: var(--dim-node); }
.map-viewport[data-focus] .map-plane > .map-node:not(${keep}):hover { opacity: var(--dim-hover); }
.map-viewport[data-focus] .map-svg g[data-group]:not([data-group=${g}]) { opacity: var(--dim-contour); }`;
  })() : "";
  const crumbs = focus.group ? (() => {
    const r = layout.regions.find((x) => x.id === focus.group);
    const m = focus.idea ? r?.missions.find((x) => x.id === focus.idea) : undefined;
    return { group: r?.title ?? focus.group, idea: m?.title ?? null };
  })() : null;
  /** A click on a group's open water (inside its outline, not on a card) focuses that group. */
  const onCanvasClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const h = t.closest<HTMLElement>("[data-drag-handle]");
    if (h) { e.stopPropagation(); openMenu(h); return; }
    if (suppressClick.current || t.closest(".map-node, .map-ui")) return;
    const r = regionAt(e.clientX, e.clientY);
    if (r && (r.id !== focus.group || focus.idea)) enterFocus({ group: r.id, idea: null });
  };

  const s0 = view.current;
  const vpStyle = { "--s": s0.s, "--tx": s0.tx, "--ty": s0.ty } as CSSProperties;
  const workerCount = world.workers.length;
  const blockedWorkers = world.workers.filter((w) => w.status === "blocked").length;
  const pendingProposals = proposals.data?.length ?? 0;
  const grouping = spec?.home?.group_by ?? "lens";
  const groupedBy = (world.lenses.length && grouping === "lens" ? "Ideas in their groups, else by repo" : `Grouped by ${grouping === "lens" ? "repo" : grouping}`) + "; unfiled work by project";

  // While carrying: which regions and missions take the item, and the one under the pointer.
  const held = carrying?.item ?? null;
  const hover = targetKey(carrying?.target ?? null);
  const regionDrop = (r: RegionOut) => {
    if (!held) return "";
    const t = regionTarget(held, r);
    return t ? (hover === targetKey(t) ? " drop-hover" : " drop-ok") : "";
  };
  const missionDrop = (m: MapMission) => {
    if (!held) return "";
    const t = missionTarget(held, m);
    return t ? (hover === targetKey(t) ? " drop-hover" : " drop-ok") : "";
  };
  /** What the captain can do to a region's name and the group itself: lens groups rename, merge and delete; Unfiled and repo groups rename into a group. */
  const regionEdit = (r: RegionOut): RegionEdit | undefined => {
    if (grouping !== "lens") return undefined;
    if (r.kind === "lens" && r.lens) {
      const id = r.lens;
      return {
        rename: (title) => groupOp("rename", { lens: id, title }),
        others: world.lenses.filter((l) => l.id !== id).map((l) => ({ id: l.id, title: l.title })),
        merge: (into) => void groupOp("merge", { lens: id, into }),
        remove: () => void groupOp("delete", { lens: id }),
      };
    }
    if (r.kind === "unfiled") return { rename: (title) => groupOp("rename", { unfiled: r.project ?? "", title }), hint: "Name it to make it a group that keeps this project's unfiled work" };
    if (r.kind === "repo" && r.missions.length) return { rename: (title) => groupOp("rename", { repo: r.path ?? "", title }), hint: "Name it to make it a group with these ideas" };
    return undefined;
  };
  const homeOf = held?.kind === "mission" && held.from && held.explicit ? layout.regions.find((r) => r.id === held.home) : undefined;
  /** The hovered target says what letting go there does, right on the target. */
  const dropLabelOf = (t: DropTarget | null) => (t && hover === targetKey(t) ? targetLabel(t) : undefined);

  const mapToast = toast && !held ? (
    <div className={`map-toast map-ui${toast.error ? " error" : ""}`} role={toast.error ? "alert" : "status"} data-testid="map-toast">
      <span>{toast.text}</span>
      {toast.commit ? <button className="btn small" onClick={() => undo(toast.commit!)}>Undo</button> : toast.revert ? <button className="btn small" onClick={() => revert(toast.revert!.run)}>{toast.revert.label}</button> : null}
      <button className="mt-close" onClick={() => setToast(null)} aria-label="Dismiss">×</button>
    </div>
  ) : null;

  const chartControls = <>
    {crumbs ? (
      <nav className="map-crumbs map-ui" aria-label="Focus" data-testid="map-crumbs" key={focus.group}>
        <button type="button" className="mc-step" onClick={() => go("map")} title="Back to the whole map (Esc)">Map</button>
        <span className="mc-sep" aria-hidden>›</span>
        {crumbs.idea ? (
          <>
            <button type="button" className="mc-step" onClick={() => enterFocus({ group: focus.group, idea: null })} title={`Back to ${crumbs.group} (Esc)`}>{crumbs.group}</button>
            <span className="mc-sep" aria-hidden>›</span>
            <span className="mc-here" aria-current="location">{crumbs.idea}</span>
          </>
        ) : <span className="mc-here" aria-current="location">{crumbs.group}</span>}
        <kbd className="mc-esc" title="Esc steps back out">Esc</kbd>
      </nav>
    ) : null}
    <ZoomControls focused={!!focus.group} level={level} onZoom={zoomAt} onPreset={(l) => zoomTo(PRESETS[l])} onFit={() => { if (focus.group) flyTo(framing); else { moved.current = false; fit(); } }} />
    {needsReady && needsYou.length ? (
      <button type="button" className="next-ask map-ui needs-you" onClick={openNeedsYou} data-testid="next-ask"
        title="Open every item waiting on you." aria-label={`${needsYou.length} items need you`}>
        <span className="na-n">{needsYou.length}</span><span>need you</span>
        <span className="na-go">Open items</span>
      </button>
    ) : needsReady && asksInOrder.length ? (
      <button type="button" className="next-ask map-ui" onClick={nextAsk} data-testid="next-ask"
        title="Jump to the next open ask" aria-label={`Next ask, ${plural(asksInOrder.length, "open ask")}`}>
        <span className="na-n">{asksInOrder.length}</span><span>open</span><span className="na-go">Next ask</span>
      </button>
    ) : null}
  </>;

  return (
    <div className={`map-root${focus.group ? " is-focused" : ""}`}>
      <div className="map-strip">
        <MetricsStrip />
        <span className="metric" data-metric="world">
          {plural(visibleCount, "idea")} charted, {plural(workerCount, "worker")}
          {blockedWorkers ? <>, <span className="signal-text">{blockedWorkers} blocked</span></> : null}
        </span>
        <span className="spacer" />
        <a className="btn small" href="#/servers">Servers</a>
        {grouping === "lens" ? <NewGroup onCreate={(title) => groupOp("create", { title })} /> : null}
        <span className="metric quiet" title={grouping === "lens" ? "Drag a session onto an idea, or an idea onto a group, to regroup" : "Drag a session onto an idea to regroup it"}>{groupedBy}</span>
        <label className="toggle">
          <input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} />
          <span>Show archive{archivedCount ? ` (${archivedCount})` : ""}</span>
        </label>
      </div>

      {focus.group ? <div className="map-focus-bar">{chartControls}</div> : null}
      <div className={focus.group ? "map-focus-feedback" : undefined}>
        {focus.group ? mapToast : null}<MapSlot name="map-overlay" focused={!!focus.group} />
      </div>

      <div
        ref={vpRef}
        className={`map-viewport lvl-${level}`}
        style={vpStyle}
        data-zoom={level}
        data-focus={focus.group ?? undefined}
        data-focus-idea={focus.idea ?? undefined}
        tabIndex={0}
        role="application"
        aria-roledescription="idea chart"
        data-carry={held?.kind}
        aria-label="Idea chart. Scroll pans; pinch or Ctrl or Cmd with the wheel zooms. Plus and minus zoom, arrow keys pan, 0 fits everything, N focuses New. Tab moves between ideas. To regroup, drag a card by its grip onto another idea or group, or press Enter on its grip for Move to."
        onPointerDown={onPointerDown}
        onPointerDownCapture={(e) => {
          const item = (e.target as HTMLElement).closest<HTMLElement>("[data-map-item]");
          if (item?.dataset.mapItem) zoomAnchor.current = item.dataset.mapItem;
          if ((flight.current || openingFocus.current) && (e.target as HTMLElement).closest("a, button, input, textarea, select")) {
            flight.current?.cancel(); flight.current = null; openingFocus.current = false; apply();
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDragStart={(e) => e.preventDefault()}
        onClickCapture={(e) => { if (suppressClick.current) { e.preventDefault(); e.stopPropagation(); } }}
        onClick={onCanvasClick}
      >
        <div className="neatline" aria-hidden><i className="n-top" /><i className="n-bottom" /><i className="n-left" /><i className="n-right" /></div>
        <div ref={layerRef} className="map-layer">
          <svg className="map-svg" aria-hidden>
            <g ref={gRef}>
              {layout.regions.map((r) => (
                <g key={r.id} data-region={r.id} data-group={r.id} className={`contour k-${r.kind}${regionDrop(r)}${r.id === focus.group ? " focused" : ""}`}>
                  <path className="c-outer" d={r.outer} vectorEffect="non-scaling-stroke" />
                  <path className="c-inner" d={r.contour} vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </g>
          </svg>

          <div className="map-plane">
            {layout.regions.filter((r) => r.kind !== "firstmate").map((r) => (
              <RegionLabel key={r.id} r={r} level={lvOf(r.id)} drop={regionDrop(r)} dropLabel={dropLabelOf(held && regionTarget(held, r))} edit={regionEdit(r)}
                focused={r.id === focus.group} placed={positions.has(r.id)} moving={movingGroup === r.id}
                onFocus={() => enterFocus({ group: r.id, idea: null })} onReset={() => void resetGroup(r.id)} onNudge={(dx, dy) => nudgeGroup(r.id, dx, dy)} />
            ))}
            {layout.regions.flatMap((r) => r.items.map((it) => [r.id, it] as const)).map(([region, it]) =>
              it.kind === "server" ? (
                <div key={it.id} className="map-node server-node" style={nodeStyle(it)} data-map-item={it.id} data-group={region}>
                  <ServerCard group={it.server} compact />
                </div>
              ) : it.kind === "mission" ? (
                <MissionNode key={it.id} queue={semanticQueue} titleLevel={level} it={it} m={it.m} detail={focus.idea === it.id ? "full" : lvOf(region)} group={region} brief={briefs.data?.[it.id]}
                  simplified={focus.idea !== it.id && cameraItems !== null && !cameraItems.has(it.id) && it.id !== (landingMission ?? revealedMission.current)} selected={selected === it.id || focus.idea === it.id} onClick={openMission(it.id, region)} onFocus={onFocusNode(it)} intents={intents}
                  draggable={drags.has(`m:${it.id}`)} drop={missionDrop(it.m)} dropLabel={dropLabelOf(held && missionTarget(held, it.m))} carried={held?.kind === "mission" && held.id === it.id} carriedSession={held?.kind === "session" ? held.key : null}
                  carriedTask={held?.kind === "task" ? held.id : null} askFocus={askFocus} selectedTask={selectedTask} />
              ) : it.kind === "worker" ? (
                <WorkerNode key={it.id} it={it} region={region} w={it.wk} level={lvOf(region)} selected={selectedWorker === it.id} onFocus={onFocusNode(it)} intents={intents} carried={held?.kind === "session" && held.key === it.wk.session}
                  suggestion={it.wk.session ? suggestFor.get(it.wk.session) : undefined} onAccept={acceptSuggestion} onSetAside={hideOnMap} />
              ) : it.kind === "firstmate" ? (
                <FirstmateNode key={it.id} it={it} f={it.fm} level={level} selected={!!selectedWorker && selectedWorker === it.fm.status?.pane?.worker} onFocus={onFocusNode(it)} onStarted={world.reloadFirstmate} suppress={suppressClick} style={nodeStyle(it)} />
              ) : it.kind === "orphans" ? (
                <OrphansNode key={it.id} it={it} level={level} intents={intents} carriedTask={held?.kind === "task" ? held.id : null} carriedSession={held?.kind === "session" ? held.key : null} selectedTask={selectedTask} />
              ) : it.kind === "quiet" ? (
                <QuietNode key={it.id} it={it} region={region} workers={it.workers} level={lvOf(region)} intents={intents} />
              ) : it.kind === "empty" ? (
                <EmptyGroupNode key={it.id} it={it} region={region} />
              ) : (
                <SessionsNode key={it.id} it={it} region={region} sessions={it.sessions} level={lvOf(region)} intents={intents} artifacts={world.artifactsBySession} />
              ),
            )}
          </div>
        </div>

        {world.ready && visibleCount === 0 && !(servers.data ?? []).some((g) => g.canvas) ? (
          <aside className="cartouche map-ui" aria-label="Getting started">
            <h2>Nothing charted yet</h2>
            {pendingProposals ? (
              <p>Backfill grouped your recent sessions into {plural(pendingProposals, "proposed idea")}. Accept the ones worth tracking and they appear here as regions.</p>
            ) : (
              <p>Ideas you create or accept appear here, in their group, else by repo.</p>
            )}
            <div className="row">
              {pendingProposals ? <a className="btn primary" href={href("agents?show=suggested")}>Triage {plural(pendingProposals, "proposal")}</a> : null}
              <button type="button" className="btn" onClick={() => openComposer()} title="Type a new idea, a task or a note in New">Start in New</button>
              {archivedCount && !archive ? <button className="btn" onClick={() => setArchive(true)}>Show {archivedCount} archived</button> : null}
            </div>
          </aside>
        ) : null}
        {world.error && !world.ready ? (
          <aside className="cartouche map-ui" role="alert"><h2>The chart can't load</h2><p>{world.error}. Start the daemon with <code>./bin/joyride up</code>; the map reconnects on its own.</p></aside>
        ) : null}

        {held ? (
          <>
            <div className="carry-ghost" ref={ghostRef} aria-hidden>
              <span className="cg-kind">{kindLabel(held)}</span>
              <span className="cg-label">{held.label}</span>
              {carrying?.target ? <span className="cg-target">{targetLabel(carrying.target)}</span> : <span className="cg-none">Not a drop spot. Let go to cancel, or press Esc.</span>}
            </div>
            <div className="drop-dock" role="status" aria-live="polite">
              <p className="dd-hint">{dragHint(held)}</p>
              <div className="dd-zones">
                {(held.kind === "session" && (held.from || held.lens)) || (held.kind === "note" && held.from !== "global") ? <span className={`dd-zone${hover === "unfiled" ? " drop-hover" : ""}`} data-drop-zone="unfiled">Move to Unfiled</span> : null}
                {held.kind !== "task" && held.kind !== "note" ? <span className={`dd-zone new${hover === "new-group" ? " drop-hover" : ""}`} data-drop-zone="new-group">+ New group</span> : null}
                {homeOf ? <span className={`dd-zone${hover === `region:${homeOf.id}` ? " drop-hover" : ""}`} data-drop-zone={`region:${homeOf.id}`}>Back to {homeOf.title}</span> : null}
              </div>
            </div>
          </>
        ) : null}
        {menu ? (
          <MoveMenu item={menu.item} targets={menuList} anchor={menu.anchor} style={{ left: menu.left, top: menu.top }}
            onPick={(t) => { const item = menu.item; closeMenu(false); drop(item, t, true); }} onClose={closeMenu} />
        ) : null}
        {tip && world.ready && drags.size && !held && !focus.group ? (
          <aside className="regroup-tip map-ui" aria-label="How to regroup" data-testid="regroup-tip">
            <p><strong>Regroup by dragging.</strong> Grab a task or session by its grip <Grip size={12} /> and drop it on an idea, or a session or idea on a group. Clicking the grip opens Move to; click a group's name to open it. Double-click the name or use ⋯ to rename it. Every move can be undone.</p>
            <button type="button" className="btn small" onClick={dismissTip}>Got it</button>
          </aside>
        ) : null}
        {naming ? <NameGroup item={naming} onCancel={() => setNaming(null)} onCreate={(name) => { const b = moveBody(naming, { kind: "new-group" }, name); setNaming(null); if (b) void runMove(b, true); }} /> : null}
        {!focus.group ? mapToast : null}

        {dimRule ? <style>{dimRule}</style> : null}
        {!focus.group ? chartControls : null}
        {!focus.group ? <Legend /> : null}
      </div>
    </div>
  );
}

/** New group, named in place: the button turns into a name field; Enter makes the group, Esc puts the button back. */
function NewGroup({ onCreate }: { onCreate: (title: string) => Promise<boolean> }) {
  const [name, setName] = useState<string | null>(null);
  if (name === null) return <button type="button" className="btn small map-new-group" onClick={() => setName("")} title="Start an empty group, then drag ideas or sessions onto it">New group</button>;
  return (
    <form className="map-new-group-form" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await onCreate(name.trim()))) setName(null); }}>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Group name" aria-label="New group name"
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setName(null); } }} />
      <button type="submit" className="btn small primary" disabled={!name.trim()}>Create</button>
      <button type="button" className="btn small" onClick={() => setName(null)}>Cancel</button>
    </form>
  );
}

/** Move to: every place a drag could take the item, as buttons. Arrow keys walk the list; Esc closes it. */
function MoveMenu({ item, targets, anchor, style, onPick, onClose }: {
  item: DragItem; targets: MenuTarget[]; anchor: HTMLElement; style: CSSProperties; onPick: (t: DropTarget) => void; onClose: (refocus: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = needle ? targets.filter((t) => `${targetLabel(t.target)} ${t.where ?? ""}`.toLowerCase().includes(needle)) : targets;
  useEffect(() => { ref.current?.querySelector<HTMLElement>(".mm-find, .mm-opt")?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => { const t = e.target as Node; if (!ref.current?.contains(t) && !anchor.contains(t)) onClose(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [anchor, onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // the chart's own keys (arrows pan, n, 0) stay out of the menu
    if (e.key === "Escape") { e.preventDefault(); onClose(true); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const opts = [...ref.current!.querySelectorAll<HTMLElement>(".mm-opt")];
      if (!opts.length) return;
      const i = opts.indexOf(document.activeElement as HTMLElement);
      opts[e.key === "ArrowDown" ? (i + 1) % opts.length : i <= 0 ? opts.length - 1 : i - 1].focus();
      e.preventDefault();
    }
    if (e.key === "Enter" && (e.target as HTMLElement).classList.contains("mm-find") && shown.length) { e.preventDefault(); onPick(shown[0].target); }
  };
  const noun = item.kind === "mission" ? "group" : "idea";
  return (
    <div ref={ref} className="move-menu map-ui" role="dialog" aria-label={`Move ${item.label}`} style={style} onKeyDown={onKey} data-testid="move-menu">
      <p className="mm-kicker">Move {kindLabel(item).toLowerCase()}</p>
      <p className="mm-label">{item.label}</p>
      {targets.length > 6 ? <input className="mm-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find an ${noun}`} aria-label={`Find an ${noun}`} /> : null}
      {shown.length ? (
        <ul className="mm-list">
          {shown.map((t) => (
            <li key={targetKey(t.target)}>
              <button type="button" className={`mm-opt${t.target.kind === "new-group" ? " new" : ""}`} onClick={() => onPick(t.target)}>
                <span className="mm-to">{targetLabel(t.target)}</span>
                {t.where ? <span className="mm-where">{t.where}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mm-empty">{targets.length ? `No ${noun} matches "${q.trim()}".` : "There's no other open idea to move it to. Start one with New idea."}</p>
      )}
      <p className="mm-foot">You can also drag the card by its grip. Esc closes.</p>
    </div>
  );
}

/** Name the group a dropped idea or session starts. */
function NameGroup({ item, onCancel, onCreate }: { item: Exclude<DragItem, { kind: "task" }>; onCancel: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form className="name-group cartouche map-ui" role="dialog" aria-label="Name the new group" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate(name); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <h2>New group</h2>
      <p>{item.label} will be the first {item.kind === "mission" ? "idea" : "session"} in it. Groups change how the chart is sorted, never who works on what.</p>
      <label className="ng-field"><span>Group name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Q4 bets" /></label>
      <div className="row">
        <button type="submit" className="btn primary" disabled={!name.trim()}>Create group</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---------- pieces ----------
function nodeStyle(it: { x: number; y: number; w: number; h?: number }) {
  return { "--x": it.x, "--y": it.y, "--w": it.w, "--h": it.h } as CSSProperties;
}

/** Inline editing on a region's name: rename (all), and merge or delete (a group). */
type RegionEdit = {
  rename: (title: string) => Promise<boolean>;
  hint?: string;
  others?: { id: string; title: string }[];
  merge?: (into: string) => void;
  remove?: () => void;
};

/** Renaming a group in place: Enter saves, Esc cancels, leaving the field saves. */
function RenameField({ r, edit, onDone }: { r: RegionOut; edit: RegionEdit; onDone: () => void }) {
  const [draft, setDraft] = useState(r.kind === "unfiled" ? "" : r.title);
  const done = useRef(false);
  const save = async () => {
    if (done.current) return;
    done.current = true;
    const t = draft.trim();
    if (!t || t === r.title) { onDone(); return; }
    if (await edit.rename(t)) onDone(); else done.current = false;
  };
  return (
    <form className="rl-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="rl-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void save()} maxLength={80}
        placeholder={r.kind === "unfiled" ? `Name a group for ${r.title}` : "Group name"} aria-label={`New name for ${r.title}`}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); done.current = true; onDone(); } }} />
    </form>
  );
}

/** A group's own menu: rename, merge or delete it, or put it back in its usual spot. Each can be undone, and no member is lost. */
function GroupMenu({ r, edit, placed, onRename, onReset }: { r: RegionOut; edit?: RegionEdit; placed: boolean; onRename: () => void; onReset: () => void }) {
  const [open, setOpen] = useState<"menu" | "merge" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  if (!edit && !placed) return null;
  const pick = (fn: () => void) => () => { setOpen(null); fn(); };
  return (
    <div className="rl-menu" ref={ref} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setOpen(null); }}>
      <button type="button" className="rl-more" aria-haspopup="menu" aria-expanded={!!open} aria-label={`More for ${r.title}`} title="Rename, merge, delete, start a session or put this group back" onClick={() => setOpen(open ? null : "menu")}>⋯</button>
      {open === "menu" ? (
        <div className="rl-pop" role="menu" data-testid="group-menu">
          {edit ? <button type="button" role="menuitem" onClick={pick(onRename)} title={edit.hint}>{r.kind === "lens" ? "Rename" : "Name this group…"}</button> : null}
          {edit?.others?.length && edit.merge ? <button type="button" role="menuitem" onClick={() => setOpen("merge")}>Merge into…</button> : null}
          {edit?.remove ? <button type="button" role="menuitem" onClick={pick(edit.remove)}>Delete group</button> : null}
          {placed ? <button type="button" role="menuitem" onClick={pick(onReset)}>Back to its usual spot</button> : null}
          {edit?.remove ? <p className="rl-pop-note">Deleting puts its ideas and sessions back where they were before. You can undo.</p> : null}
          {r.kind !== "server" ? <StartHereButton context={r.lens ? { kind: "group", id: r.lens } : { kind: "project", title: r.title, ...(r.path ? { cwd: r.path } : {}) }} className="btn small" /> : null}
        </div>
      ) : open === "merge" ? (
        <div className="rl-pop" role="menu" aria-label={`Merge ${r.title} into`}>
          <p className="rl-pop-note">Merge {r.title} into</p>
          {edit!.others!.map((o) => <button key={o.id} type="button" role="menuitem" onClick={pick(() => edit!.merge?.(o.id))}>{o.title}</button>)}
        </div>
      ) : null}
    </div>
  );
}

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** A group's name: click to open the group in place, drag to move it, double-click (or its menu) to rename. */
function RegionLabel({ r, level, drop, dropLabel, edit, focused, placed, moving, onFocus, onReset, onNudge }: {
  r: RegionOut; level: ZoomLevel; drop: string; dropLabel?: string; edit?: RegionEdit; focused: boolean; placed: boolean; moving: boolean;
  onFocus: () => void; onReset: () => void; onNudge: (dx: number, dy: number) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOpen = () => { if (clickTimer.current) clearTimeout(clickTimer.current); clickTimer.current = null; };
  useEffect(() => cancelOpen, []);
  const open = (e: React.MouseEvent) => {
    cancelOpen();
    if (e.detail > 1) return;
    if (!edit || e.detail === 0) onFocus();
    else clickTimer.current = setTimeout(onFocus, 500);
  };
  const missions = r.missions.length, workers = r.workers.length + r.missions.reduce((a, m) => a + m.workers.length, 0);
  const unfiled = r.kind === "unfiled";
  const sub = r.server ? `${plural(r.server.members.length, "terminal")} · ${r.server.state}` : unfiled
    ? [r.workers.length ? plural(r.workers.length, "worker") : null, r.quiet?.length ? plural(r.quiet.length, "quiet worker") : null, r.sessions.length ? plural(r.sessions.length, "recent session") : null].filter(Boolean).join(", ") + " not in an idea"
    : [missions || (!workers && !r.sessions.length) ? plural(missions, "idea") : null, workers ? plural(workers, "worker") : null, r.sessions.length ? plural(r.sessions.length, "session") : null].filter(Boolean).join(", ");
  const live = glanceParts(r.missions.reduce((g, m) => {
    const x = glanceOf(m);
    return { needsYou: g.needsYou + x.needsYou, stuck: g.stuck + x.stuck, moving: g.moving + x.moving, next: g.next + x.next, landed: 0, idle: 0 };
  }, glanceOf({ asks: [], tasks: [], workers: r.workers, landed: [] })));
  return (
    <div className={`map-node region-label k-${r.kind}${drop}${focused ? " focused" : ""}${moving ? " moving" : ""}`} style={nodeStyle({ x: r.labelX, y: r.labelY, w: r.labelW })}
      title={r.path ?? r.title} data-region={r.id} data-region-cwd={r.lens ? undefined : r.path} data-placed={placed || undefined} data-drop-label={dropLabel}>
      {unfiled ? <span className="rl-kicker">Unfiled</span> : null}
      <span className="rl-head">
        {renaming && edit ? <RenameField r={r} edit={edit} onDone={() => setRenaming(false)} /> : (
          <button type="button" className="rl-title rl-focus" onClick={open} onDoubleClick={edit ? () => { cancelOpen(); setRenaming(true); } : undefined} data-testid="region-title"
            aria-label={focused ? `${r.title}, open` : `Open ${r.title}`} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
            title={`Open ${r.title} in place. Drag to move it${edit ? "; double-click to rename" : ""}. Alt and an arrow key moves it a step.`}
            onKeyDown={(e) => { const d = NUDGE[e.key]; if (d && e.altKey) { e.preventDefault(); e.stopPropagation(); onNudge(d[0], d[1]); } }}>{r.title}</button>
        )}
        <GroupMenu r={r} edit={edit} placed={placed} onRename={() => setRenaming(true)} onReset={onReset} />
        {r.kind === "lens" && r.lens ? <MapSlot name="group-head" group={r.lens} title={r.title} level={level} /> : null}
      </span>
      {level !== "far" ? (
        <span className="rl-sub">
          {live.length ? <span className="rl-live">{live.map((p, i) => <span key={p.text} className={p.signal ? "signal-text" : undefined}>{i ? " · " : ""}{p.text}</span>)}</span> : null}
          <span className="rl-inv">{sub}</span>
          {unfiled && r.proposals ? <>, <a href={href("agents?show=suggested")} title="Idea proposals for this project, waiting for you to accept or reject">{plural(r.proposals, "proposal")}</a></> : null}
          {level === "near" && r.path ? <> <span className="rl-path">{shortPath(r.path)}</span></> : null}
        </span>
      ) : null}
      {r.kind === "lens" && r.lens ? <MapSlot name="group-board" group={r.lens} title={r.title} level={level} /> : null}
    </div>
  );
}

function Progress({ m }: { m: MapMission }) {
  const per = new Map((m.verdict?.per_criterion ?? []).map((c) => [c.id, c.verdict]));
  const pass = m.done_when.filter((c) => per.get(c.id) === "pass").length;
  const tw = Math.max(3, Math.min(13, Math.floor(110 / m.done_when.length) - 2));
  return (
    <span className="progress" title={m.verdict ? `Last verdict: ${m.verdict.verdict}` : "No verdict yet"}>
      <span className="ticks" aria-hidden>
        {m.done_when.map((c) => <i key={c.id} className={`t-${per.get(c.id) ?? "none"}`} style={{ width: tw }} />)}
      </span>
      <span className="progress-text">{m.verdict ? `${pass} of ${m.done_when.length} pass` : `${plural(m.done_when.length, "criterion", "criteria")}, no verdict`}</span>
    </span>
  );
}

/** How much an idea card shows: Far a glance line, Mid and Near what needs you and what is moving, Full (a focused idea) everything. */
export type Detail = ZoomLevel | "full";

/** Keep outgoing controls mounted until this card's turn. Each pair waits for
 * acknowledgement, so React cannot batch the whole queue into one frame. */
function useSemanticDetail(requested: Detail, simplified: boolean, queue: SemanticQueue): Detail {
  const [detail, setDetail] = useState(requested);
  const key = useRef({});
  const committed = useRef<(() => void) | null>(null);
  const previousSimplified = useRef(simplified);
  const restoring = previousSimplified.current;
  useLayoutEffect(() => { previousSimplified.current = simplified; }, [simplified]);
  useLayoutEffect(() => {
    committed.current?.();
    committed.current = null;
  }, [detail]);
  useLayoutEffect(() => {
    if (requested === detail) return;
    // A placeholder has no outgoing details. Restoring its remembered level
    // would mount obsolete Near controls before a Near-to-Far swap removes them.
    if (simplified || restoring) { startTransition(() => setDetail(requested)); return; }
    return queue.enqueue(key.current, (done) => {
      committed.current = done;
      startTransition(() => setDetail(requested));
    });
  }, [requested, detail, simplified, restoring, queue]);
  return simplified || restoring ? requested : detail;
}

function MissionNode({ it, m, detail: requested, queue, titleLevel, group, simplified, selected, onClick, onFocus, intents, draggable, drop, dropLabel, carried, carriedSession, carriedTask, askFocus, selectedTask, brief }: {
  it: Item; m: MapMission; detail: Detail; queue: SemanticQueue; titleLevel: ZoomLevel; group: string; simplified: boolean; selected: boolean; onClick: (e: React.MouseEvent) => void; onFocus: (e: React.FocusEvent) => void; intents: Intents;
  draggable: boolean; drop: string; dropLabel?: string; carried: boolean; carriedSession: string | null; carriedTask: string | null; askFocus: string | null; selectedTask: string | null;
  brief?: IdeaBriefT;
}) {
  const detail = useSemanticDetail(requested, simplified, queue);
  // The idea's count is what it owes: asks on its tasks and on the idea itself; attention when asks aren't served.
  const asks = [...m.asks, ...m.tasks.flatMap((t) => t.asks)];
  const counted = m.attention.filter((a) => rankOf(a.level) >= 2);
  const count = asks.length || counted.length;
  const urgent = asks.some((a) => a.needs_you) || counted.some((a) => rankOf(a.level) >= 3);
  const full = detail === "full";
  const level: ZoomLevel = full ? "near" : detail;
  const repo = m.repos[0] ? repoLabel(m.repos[0]) ?? null : null;
  const headline = glanceParts(glanceOf(m)).map((p) => p.text).join(" · ") || m.health_why;
  return (
    <div className={`map-node mission-node h-${m.health} d-${detail}${selected ? " selected" : ""}${offChart(m) ? " archived" : ""}${draggable ? " can-drag" : ""}${carried ? " carried" : ""}${askFocus && asks.some((a) => a.id === askFocus) ? " ask-focus" : ""}${drop}`}
      style={nodeStyle(it)} data-map-item={it.id} data-mission={m.id} data-group={group} data-lv={level} data-title-level={detail === requested || detail === "full" ? titleLevel : detail} data-semantic-pending={detail !== requested ? "" : undefined} data-size-key={full ? `${it.id}#full` : undefined} data-camera-simplified={simplified ? "" : undefined}
      data-drag={draggable ? `m:${m.id}` : undefined} data-drop-label={dropLabel} onClick={onClick}>
      <div className="mn-head">
        <HealthMark health={m.health} />
        <a className="mn-title" href={href(`mission/${encodeURIComponent(m.id)}`)} onFocus={onFocus} title={m.health_why ? `${m.title}: ${m.health_why}` : m.title} draggable={false}>{m.title}</a>
        {count ? (
          <span className={`mn-count${urgent ? " signal" : ""}`} title={`${plural(count, "open ask")}${urgent ? ", waiting on you" : ""}`} aria-label={`${count} open asks`}>{count}</span>
        ) : null}
        <MapSlot name="idea-composer" mission={m.id} level={level} />
        {draggable ? <DragHandle label={m.title} /> : null}
      </div>
      {/* Off camera, a card keeps only its glance line until the camera reaches it. */}
      {simplified ? <FarGlance m={m} /> : detail === "far" ? <><FarGlance m={m} /><MapSlot name="idea-notes" mission={m.id} level="far" /></> : full ? (
        <FullIdea m={m} intents={intents} carriedSession={carriedSession} carriedTask={carriedTask} selectedTask={selectedTask} brief={brief} repo={repo} />
      ) : (
        <div className="mn-detail">
          {level === "near" && headline ? <p className="mn-why">{headline}</p> : null}
          {/* The captain's own board (notes, lists, links) sits on top: it is the idea's context. */}
          <div className="mn-board"><MapSlot name="idea-notes" mission={m.id} level={level} /></div>
          <IdeaSections m={m} level={level} intents={intents} carriedSession={carriedSession} carriedTask={carriedTask} selectedTask={selectedTask} />
          <Replies list={m.replies} level={level} />
          <Landed list={m.landed} />
          <IdeaFoot m={m} level={level} repo={repo} />
        </div>
      )}
    </div>
  );
}

/** Far: one line that says whether the idea needs the captain, is stuck or is moving; else what it holds. */
function FarGlance({ m }: { m: MapMission }) {
  const parts = glanceParts(glanceOf(m));
  return (
    <div className="mn-summary" data-glance={parts.length ? "live" : "quiet"}>
      {parts.length ? parts.map((p, i) => <span key={p.text} className={p.signal ? "signal-text" : undefined}>{i ? " · " : ""}{p.text}</span>) : inventory(m)}
    </div>
  );
}

/** Mid and near: the idea's work sorted by what the captain asks of it, in reading order. */
function IdeaSections({ m, level, intents, carriedSession, carriedTask, selectedTask }: {
  m: MapMission; level: ZoomLevel; intents: Intents; carriedSession: string | null; carriedTask: string | null; selectedTask: string | null;
}) {
  const sorted = sortIdea(m.tasks, m.workers);
  const near = level === "near";
  const ideaAsks = { mine: m.asks.filter((a) => a.needs_you), others: m.asks.filter((a) => !a.needs_you) };
  return (
    <>
      {BUCKETS.map((b) => {
        const ts = sorted.tasks.get(b)!, ws = sorted.workers.get(b)!;
        const own = b === "needs-you" ? ideaAsks.mine : b === "stuck" ? ideaAsks.others : [];
        const nudges = b === "needs-you" ? m.nudges : [];
        if (!ts.length && !ws.length && !own.length && !(nudges.length && near)) return null;
        return (
          <section key={b} className={`mn-sec b-${b}`} data-bucket={b} aria-label={BUCKET_LABEL[b]}>
            {b === "needs-you" ? null : <p className="mn-k">{BUCKET_LABEL[b]}{ts.length + ws.length > 1 ? <span className="mn-kn">{ts.length + ws.length}</span> : null}</p>}
            {own.map((a) => (near && a.needs_you ? <AskCard key={a.id} ask={a} folded /> : <AskBadge key={a.id} ask={a} />))}
            {b === "needs-you" ? <MapSlot name="idea-nudges" mission={m.id} asks={m.nudges} level={level} /> : null}
            {ts.length ? (
              near ? <div className="task-cards">{ts.map((t) => <TaskCard key={t.id} t={t} intents={intents} carried={carriedTask === t.id} carriedSession={carriedSession} selected={selectedTask === t.id} full={false} />)}</div>
                : <ul className="task-rows">{ts.map((t) => <TaskRow key={t.id} t={t} intents={intents} carried={carriedTask === t.id} selected={selectedTask === t.id} />)}</ul>
            ) : null}
            {ws.length ? (
              <ul className={`mn-workers${near ? "" : " mid"}`}>
                {ws.map((w) => <WorkerLine key={w.id} w={w} goal={goalOf(intents, w.session)} carried={!!w.session && w.session === carriedSession} compact oneLine={!near} />)}
              </ul>
            ) : null}
          </section>
        );
      })}
      {!m.asks.some((a) => a.needs_you) && !m.tasks.length && !m.workers.some((w) => w.status !== "idle") ? <MapSlot name="idea-nudges" mission={m.id} asks={m.nudges} level={level} /> : null}
      {sorted.idle.length ? <p className="mn-idle" title={sorted.idle.map((w) => goalOf(intents, w.session) ?? (w.title || w.id)).join("\n")}>{plural(sorted.idle.length, "idle session")}</p> : null}
    </>
  );
}

/** The quiet line under an idea: its done-when progress, artifacts and (near) where it lives. */
function IdeaFoot({ m, level, repo }: { m: MapMission; level: ZoomLevel; repo: string | null }) {
  const where = level === "near" ? [repo, m.branches[0]].filter(Boolean) : [];
  return (
    <div className="mn-foot">
      <StartHereButton context={{ kind: "idea", id: m.id }} stop />
      {m.done_when.length ? <Progress m={m} /> : null}
      <ArtifactChips list={m.artifacts} max={2} more={href(`mission/${encodeURIComponent(m.id)}`)} />
      {where.length ? <span className="mn-where">{repo}{m.branches[0] ? <span className="mono"> · {m.branches[0]}</span> : null}</span> : null}
    </div>
  );
}

/** A focused idea, in full: its summary, every task card open with who runs it and its crew, every worker, every artifact. */
function FullIdea({ m, intents, carriedSession, carriedTask, selectedTask, brief, repo }: {
  m: MapMission; intents: Intents; carriedSession: string | null; carriedTask: string | null; selectedTask: string | null; brief?: IdeaBriefT; repo: string | null;
}) {
  const shown = m.workers.slice(0, 8);
  return (
    <div className="mn-detail full">
      <div className="mn-overview">
        <div className="mn-meta">
          {repo ? <span>{repo}</span> : null}
          {m.branches[0] ? <span className="mono">{m.branches[0]}</span> : null}
        </div>
        {brief?.headline ? <IdeaBriefView brief={{ ...brief, headline: glanceParts(glanceOf(m)).map((p) => p.text).join(" · ") || m.health_why || inventory(m) }} /> : null}
        {m.health_why ? <p className="mn-why">{m.health_why}</p> : null}
        <MapSlot name="idea-notes" mission={m.id} level="near" />
        <Replies list={m.replies} level="near" />
        {m.done_when.length ? <Progress m={m} /> : null}
        <ArtifactChips list={m.artifacts} max={6} more={href(`mission/${encodeURIComponent(m.id)}`)} />
        {shown.length ? (
          <ul className="mn-workers">
            {shown.map((w) => <WorkerLine key={w.id} w={w} goal={goalOf(intents, w.session)} carried={!!w.session && w.session === carriedSession} />)}
            {m.workers.length > shown.length ? <li className="more">and {m.workers.length - shown.length} more</li> : null}
          </ul>
        ) : null}
        <Landed list={m.landed} />
        <StartHereButton context={{ kind: "idea", id: m.id }} stop />
        </div>
      <div className="mn-work">
        {m.asks.map((a) => <AskCard key={a.id} ask={a} folded />)}
        <MapSlot name="idea-nudges" mission={m.id} asks={m.nudges} level="near" />
        <TaskList tasks={m.tasks} level="near" intents={intents} carriedTask={carriedTask} carriedSession={carriedSession} selected={selectedTask} full />
        </div>
    </div>
  );
}

/** Firstmate's open tasks that no idea names yet, beside the hub, until housekeeping files them. */
function OrphansNode({ it, level, intents, carriedTask, carriedSession, selectedTask }: { it: Extract<Item, { kind: "orphans" }>; level: ZoomLevel; intents: Intents; carriedTask: string | null; carriedSession: string | null; selectedTask: string | null }) {
  const list = it.fm.orphans;
  const asks = list.flatMap((t) => t.asks);
  return (
    <div className="map-node mission-node orphans-node" style={nodeStyle(it)} data-map-item={it.id} data-orphans={list.length}>
      <div className="mn-head">
        <span className="mn-title" title="Firstmate's tasks that no idea names yet. Drag one onto an idea to file it.">Not in an idea yet</span>
        {asks.length ? <span className={`mn-count${asks.some((a) => a.needs_you) ? " signal" : ""}`}>{asks.length}</span> : null}
      </div>
      {level === "far" ? <div className="mn-summary">{plural(list.length, "task")}</div> : (
        <div className="mn-detail">
          {/* Beside the hub (which never opens like a group), tasks waiting to be filed show in full. */}
          <TaskList tasks={list} level={level} intents={intents} carriedTask={carriedTask} carriedSession={carriedSession} selected={selectedTask} full />
        </div>
      )}
    </div>
  );
}

function WorkerNode({ it, region, w, level, selected, onFocus, intents, carried, suggestion, onAccept, onSetAside }: {
  it: Item; region: string; w: MapWorker; level: ZoomLevel; selected: boolean; onFocus: (e: React.FocusEvent) => void; intents: Intents; carried: boolean;
  suggestion?: MissionProposal; onAccept: (p: MissionProposal) => void; onSetAside: (key: string) => void;
}) {
  const goal = level !== "far" ? goalOf(intents, w.session) : null;
  const name = w.title || w.id;
  return (
    <div className={`map-node worker-node s-${w.status}${selected ? " selected" : ""}${w.session ? " can-drag" : ""}${carried ? " carried" : ""}`} style={nodeStyle(it)} data-map-item={it.id} data-worker={w.id} data-region={region} data-drag={w.session ? `s:${w.session}` : undefined}>
      <a className="wn-link" href={href(`worker/${encodeURIComponent(w.id)}`)} onFocus={onFocus} title={goal ? `${w.title || w.id}: ${goal}` : undefined} draggable={false}>
        <span className="wn-head">
          <VesselMark status={w.status} agent={w.agent} size={13} />
          <span className={`wn-title${goal ? " is-goal" : ""}`}>{goal ?? (w.title || w.id)}</span>
        </span>
        <FleetChips w={w} compact={level === "far"} task={level === "near"} className="wn-chips" />
        {level !== "far" ? (
          <span className="wn-meta">
            <span className={`wn-status s-${w.status}`}>{STATUS_TEXT[w.status] ?? w.status}</span>
            <span>{w.agent} in {repoLabel(w.repo ?? w.cwd)}</span>
            {level === "near" ? <TimeAgo iso={w.updated} /> : null}
          </span>
        ) : null}
        {level === "near" ? (
          <>
            <span className={`wl-action${w.current_action ? "" : " none"}`}>{w.current_action || (w.status === "blocked" ? "Waiting at a prompt in its terminal" : "No action reported")}</span>
            {w.last_message ? <span className="wl-msg">{w.last_message}</span> : null}
          </>
        ) : null}
      </a>
      {level !== "far" ? <span className="wn-art"><ArtifactChips list={w.artifacts} max={2} /></span> : null}
      {level !== "far" && suggestion ? (
        <span className="wn-suggest" data-suggestion={suggestion.id}>
          <span className="ws-text">Suggested idea: <strong>{suggestion.title}</strong></span>
          <button type="button" className="btn small" onClick={() => onAccept(suggestion)} title="Accept the suggested idea; it files this session and the others it groups">Accept</button>
        </span>
      ) : null}
      {level !== "far" ? (
        <span className="wn-actions">
          <a className="btn small" href={href(`worker/${encodeURIComponent(w.id)}`)} draggable={false}>Open</a>
          {w.session ? <button type="button" className="btn small" data-drag-handle aria-haspopup="dialog" aria-label={`File ${name} in an idea or group`}>File in…</button> : null}
          <button type="button" className="btn small quiet" onClick={() => onSetAside(w.session ?? w.id)} title="Take it off the chart until it does something new. The Agents page still lists it.">Set aside</button>
        </span>
      ) : null}
      {w.session ? <DragHandle label={name} /> : null}
    </div>
  );
}

/** An empty group's body: what to do with it. */
function EmptyGroupNode({ it, region }: { it: Item; region: string }) {
  return (
    <div className="map-node empty-group" style={nodeStyle(it)} data-map-item={it.id} data-region={region}>
      <span>No ideas or sessions here yet. Drag them onto this group, or pick it from a card's Move to.</span>
    </div>
  );
}

function SessionsNode({ it, region, sessions, level, intents, artifacts }: { it: Item; region: string; sessions: UnfiledSession[]; level: ZoomLevel; intents: Intents; artifacts: Map<string, MapArtifact[]> }) {
  return (
    <div className="map-node sessions-node" style={nodeStyle(it)} data-map-item={it.id} data-region={region}>
      <span className="sn-title">{plural(sessions.length, "recent session")} without an idea</span>
      {level !== "far" ? (
        <ul>
          {sessions.slice(0, 8).map((s) => (
            <li key={s.key} className="can-drag" data-drag={`s:${s.key}`} data-session={s.key}>
              <a href={href(`session/${encodeURIComponent(s.key)}`)} title={cleanTitle(s.title, s.key)} draggable={false}><span className="sn-name">{goalOf(intents, s.key) ?? cleanTitle(s.title, s.key)}</span><TimeAgo iso={s.updated} /></a>
              <ArtifactChips list={artifacts.get(s.key)} max={2} compact />
              <DragHandle label={cleanTitle(s.title, s.key)} />
            </li>
          ))}
          {sessions.length > 8 ? <li className="more"><a href={href("agents?show=suggested")}>{sessions.length - 8} more in proposals</a></li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function QuietNode({ it, region, workers, level, intents }: { it: Item; region: string; workers: WorkerView[]; level: ZoomLevel; intents: Intents }) {
  return (
    <div className="map-node sessions-node quiet-node" style={nodeStyle(it)} data-map-item={it.id} data-region={region} data-quiet-workers={workers.length}>
      <span className="sn-title" title="Idle for more than 12 hours, outside any idea">{plural(workers.length, "quiet worker")}</span>
      {level !== "far" ? (
        <ul>
          {workers.slice(0, 8).map((w) => (
            <li key={w.id} className={w.session ? "can-drag" : undefined} data-drag={w.session ? `s:${w.session}` : undefined}><a href={href(`worker/${encodeURIComponent(w.id)}`)} title={`${w.title || w.id}: ${w.agent} in ${repoLabel(w.repo ?? w.cwd)}`} draggable={false}>
              <span className="sn-name"><VesselMark status={w.status} agent={w.agent} size={10} /> {goalOf(intents, w.session) ?? (w.title || w.id)}</span><FleetChips w={w} compact /><TimeAgo iso={w.updated} />
            </a>{w.session ? <DragHandle label={w.title || w.id} /> : null}</li>
          ))}
          {workers.length > 8 ? <li className="more"><span>and {workers.length - 8} more; find them with <kbd>⌘K</kbd></span></li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function ZoomControls({ level, focused, onZoom, onPreset, onFit }: { level: ZoomLevel; focused: boolean; onZoom: (f: number) => void; onPreset: (l: ZoomLevel) => void; onFit: () => void }) {
  return (
    <div className="zoom-controls map-ui" role="group" aria-label="Zoom">
      <button className="zc-btn" onClick={() => onZoom(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button className="zc-btn" onClick={() => onZoom(0.8)} aria-label="Zoom out" title="Zoom out (−)">−</button>
      {focused ? <span className="zc-focus" title="Reading detail in the focused group">Focus</span> : <div className="zc-scale" role="radiogroup" aria-label="Detail level">
        {(["far", "mid", "near"] as const).map((l) => (
          <button key={l} role="radio" aria-checked={level === l} className={level === l ? "on" : ""} onClick={() => onPreset(l)}>
            {{ far: "Far", mid: "Mid", near: "Near" }[l]}
          </button>
        ))}
      </div>}
      <button className="zc-btn wide" onClick={onFit} title={focused ? "Frame the focus" : "Fit everything (0)"}>Fit</button>
    </div>
  );
}

function Legend() {
  return (
    <div className="map-legend map-ui" aria-label="Legend">
      <span><HealthMark health="active" size={11} /> Active</span>
      <span><HealthMark health="blocked" size={11} /> Blocked</span>
      <span><HealthMark health="needs-review" size={11} /> Review</span>
      <span><HealthMark health="idle" size={11} /> Idle</span>
      <span className="lg-sep" />
      <span><VesselMark status="working" size={11} /> Worker</span>
      <span><VesselMark status="blocked" size={11} /> Needs you</span>
      <span className="lg-sep" />
      <span><Grip size={11} /> Drag to regroup</span>
    </div>
  );
}
