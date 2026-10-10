import { StandaloneChoices } from "./StandaloneChoices";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { NewReceipt, ScreenContext, StandaloneChoice } from "../../../shared/freeform";
import { useDraft } from "../../lib/useDraft";
import { draftKey, draftStore } from "../../lib/drafts";
import { post, api } from "../../lib/api";
import { ghostStore, takeOpenRequest, type OpenRequest } from "../../components/compose/ghost";
import { captureScreen, trackScreen } from "./screen";
import { applyUi, browserState, restoreBrowser } from "./commands";
import { history } from "./history";
import { animateResult } from "./animation";
import { revealOnMap } from "../map/reveal";
import { useCurrentGroup } from "../map/current";
import "./new.css";

let lastReceipt: NewReceipt | null = null;
const seenStates = new Map<string, NewReceipt["state"]>();
const placeKey = (p: ScreenContext["place"]) => p?.kind === "idea" ? p.id : p?.kind === "group" ? `group:${p.id}` : "new";

export function NewBox() {
  const [place, setPlace] = useState<ScreenContext["place"]>(null);
  const current = useCurrentGroup();
  const draft = useDraft({ kind: "composer", id: placeKey(place) });
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<NewReceipt | null>(lastReceipt);
  const [recent, setRecent] = useState<NewReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [railHidden, setRailHidden] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const focusRequested = useRef(false);
  const pending = useRef<{ request: string; text: string; context: ScreenContext } | null>(null);
  const focusBox = useCallback(() => {
    const el = box.current;
    if (!focusRequested.current || !el || el.closest("aside")?.hidden) return;
    el.focus();
    focusRequested.current = false;
  }, []);
  useEffect(trackScreen, []);
  useEffect(() => {
    const rail = box.current?.closest("aside");
    if (!rail) return;
    const update = () => {
      setRailHidden(Boolean(rail.hidden));
      if (!rail.hidden && focusRequested.current) requestAnimationFrame(focusBox);
    };
    const observer = new MutationObserver(update);
    observer.observe(rail, { attributes: true, attributeFilter: ["hidden"] });
    update();
    return () => observer.disconnect();
  }, [focusBox]);
  useEffect(() => {
    const open = (o: OpenRequest | null) => {
      if (!o) return;
      focusRequested.current = true;
      const p: ScreenContext["place"] = o.idea ? { kind: "idea", id: o.idea, title: o.idea } : o.board ?? null;
      if (o.text) draftStore.update(draftKey({ kind: "composer", id: placeKey(p) }), { text: o.text });
      setPlace(p);
      if (o.idea) void api<{ title: string }>(`/api/missions/${encodeURIComponent(o.idea)}`).then((idea) => setPlace((p) => p?.kind === "idea" && p.id === o.idea ? { ...p, title: idea.title } : p)).catch(() => {});
      requestAnimationFrame(focusBox);
    };
    open(takeOpenRequest());
    const on = () => open(takeOpenRequest() ?? {});
    window.addEventListener("joyride:compose", on);
    return () => window.removeEventListener("joyride:compose", on);
  }, [focusBox, draft.setText]);
  useEffect(() => {
    const el = box.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`; }
  }, [draft.text]);
  const receive = useCallback((r: NewReceipt, select = false, input = pending.current) => {
    history.remember(r.id, r.ui.length ? browserState() : null);
    if (input?.request === r.id && r.route === "firstmate" && r.request && r.state === "done" && !ghostStore.list().some((g) => g.id === r.id)) {
      const idea = r.landing?.kind === "idea" ? r.landing : null;
      ghostStore.add({ id: r.id, text: input.text, created: Date.now(), phase: "sent", as: "task", intent: r.request,
        ...(idea ? { target: { kind: "idea", id: idea.id, title: idea.title, p: r.confidence ?? 0 }, mission: idea, idea: idea.id, ideaTitle: idea.title } : {}) });
    }
    for (const command of r.ui.slice(history.applied(r.id))) applyUi(command);
    history.didApply(r.id, r.ui.length);
    if ((select || seenStates.has(r.id)) && seenStates.get(r.id) !== r.state) animateResult(r);
    seenStates.set(r.id, r.state);
    if (select || lastReceipt?.id === r.id) { lastReceipt = r; setReceipt(r); }
    setRecent((list) => [r, ...list.filter((e) => e.id !== r.id)].sort((a, b) => history.ids().indexOf(a.id) - history.ids().indexOf(b.id)));
  }, []);
  useEffect(() => { let live = true; for (const id of history.ids()) void api<NewReceipt>(`/api/new/${encodeURIComponent(id)}`).then((r) => { if (live) receive(r, !lastReceipt && id === history.ids()[0]); }).catch(() => {}); return () => { live = false; }; }, [receive]);
  useEffect(() => {
    const active = recent.filter((r) => r.state === "running");
    if (!active.length) return;
    let live = true;
    const t = setInterval(() => { for (const r of active) void api<NewReceipt>(`/api/new/${encodeURIComponent(r.id)}`).then((r) => { if (live) receive(r); }).catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); }); }, 1000);
    return () => { live = false; clearInterval(t); };
  }, [recent, receive]);

  async function submit(standalone?: StandaloneChoice) {
    if (busy || !draft.text.trim()) return;
    setBusy(true); setError(null); setReceipt(null);
    const payload = !standalone && pending.current?.text === draft.text ? pending.current : { request: crypto.randomUUID(), text: draft.text, context: pending.current?.text === draft.text ? pending.current.context : captureScreen(place), ...(standalone ? { standalone } : {}) };
    pending.current = payload;
    history.remember(payload.request, browserState());
    try {
      const r = await post<NewReceipt>("/api/new", payload);
      receive(r, true, payload);
      if (r.state !== "failed" && r.state !== "choose" && draftStore.read(draft.key).text === payload.text) draft.clear();
      if (r.state !== "choose") pending.current = null;
    } catch (e) { setError(`New could not complete this request: ${e instanceof Error ? e.message : String(e)}. Your words are kept; retry uses the same request.`); }
    finally { setBusy(false); }
  }
  async function undo(r = receipt) {
    if (!r || busy) return;
    setBusy(true); setError(null);
    try {
      const restored = await post<NewReceipt>(`/api/new/${encodeURIComponent(r.id)}/undo`, {});
      const view = history.view(r.id); if (r.ui.length && view) restoreBrowser(view);
      receive(restored, true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function show() {
    if (!receipt?.landing) return;
    const e = receipt.landing;
    revealOnMap(e.kind === "note" ? { kind: "item", id: e.id, board: e.scope, zoom: "mid" } : e.kind === "group" ? { kind: "region", id: `lens:${e.id}` } : e.kind === "idea" ? { kind: "idea", id: e.id } : { kind: "hub" });
  }
  const result = receipt ? <div key={`${receipt.id}:${receipt.state}`} className={`nb-result nb-effect-${receipt.animation}`} role="status" data-new-result data-route={receipt.route} data-animation={receipt.animation} data-state={receipt.state}>
      <span className={`nb-action-mark ${receipt.state === "running" ? "is-running" : ""}`} aria-hidden>{receipt.state === "failed" ? "!" : receipt.state === "running" ? "◌" : receipt.state === "undone" ? "↶" : "✓"}</span>
      <p>{receipt.message}</p>
      {receipt.worker ? <a href={`#/worker/${encodeURIComponent(receipt.worker)}`} className="nb-job-link">{receipt.route === "standalone" ? "Open my session" : "Open agent"}</a> : null}
      {receipt.request ? <a href="#/map" className="nb-job-link">Firstmate request sent</a> : null}
      {receipt.session && receipt.route === "standalone" ? <a className="nb-job-link" href={`#/session/${encodeURIComponent(receipt.session)}`}>View saved session</a> : null}
      {receipt.standalone && receipt.state === "choose" ? <StandaloneChoices key={receipt.id} offer={receipt.standalone} busy={busy} launch={choice => void submit(choice)} /> : null}
      {receipt.undoLimit ? <p className="meta nb-limit">{receipt.undoLimit}</p> : null}
      <div className="nb-actions">
        {receipt.landing && receipt.state !== "undone" ? <button className="btn small" onClick={show}>Show on map</button> : null}
        {receipt.undo && receipt.state !== "undone" ? <button className="btn small" disabled={busy || receipt.state === "running"} onClick={() => void undo()}>Undo</button> : null}
        {receipt.state !== "running" && receipt.state !== "choose" ? <button className="btn ghost small nb-dismiss" onClick={() => { lastReceipt = null; setReceipt(null); }}>Done</button> : null}
      </div>
    </div> : null;
  return <><section className="rail-sec new-box" data-rail="new" aria-labelledby="rail-new">
    <h3 id="rail-new">New <kbd title="Press N to start typing">N</kbd></h3>
    {place ? <p className="nb-scope">{place.kind === "unfiled" ? "On Unfiled" : `In ${place.title}`}</p> : current ? <p className="nb-scope">In <span data-current-group>{current.title}</span></p> : null}
    <textarea ref={(el) => { box.current = el; draft.boxRef(el); }} className="input nb-input" rows={2} value={draft.text}
      aria-label="New" aria-describedby="nb-hint" placeholder="Tell Joyride what you want to do"
      onChange={(e) => { draft.setText(e.target.value); pending.current = null; setError(null); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
    <p id="nb-hint" className="meta nb-hint">Notes, lists, links, work or your own repo session. Enter sends. Shift+Enter adds a line.</p>
    {draft.text.trim() ? <div className="nb-actions"><button type="button" className="btn primary small" disabled={busy} onClick={() => void submit()}>{busy ? "Understanding…" : "Send"}</button></div> : null}
    {busy && !receipt ? <div className="nb-working" role="status"><span className="nb-orbit" aria-hidden />Understanding your request…</div> : null}
    {!railHidden ? result : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    {recent.some((r) => r.id !== receipt?.id) ? <details className="nb-history"><summary>Recent requests</summary>{recent.filter((r) => r.id !== receipt?.id).map((r) => <div key={r.id} data-new-history={r.id}><p>{r.message}</p>{r.worker ? <a href={`#/worker/${encodeURIComponent(r.worker)}`}>Open agent</a> : null}{r.undo && r.state !== "undone" ? <button className="btn small" disabled={busy || r.state === "running"} onClick={() => void undo(r)}>Undo</button> : null}</div>)}</details> : null}
  </section>{railHidden && (result || error) ? createPortal(<div className="nb-floating" data-new-floating>{result}{error ? <p className="inline-error" role="alert">{error}</p> : null}</div>, document.body) : null}</>;
}
