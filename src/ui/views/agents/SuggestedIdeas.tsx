// Suggested ideas (the Agents page's "Suggested ideas" filter): backfill's proposed missions with
// enough context to decide each in a few seconds. Every row carries the brief's verdict; opening a row
// shows what the sessions did. Recommended proposals come first, obvious noise
// is hidden (and can be rejected in one go). Accept (optionally renamed), merge
// into a suggested mission, reject, or do it in bulk.
import { useMemo, useRef, useState } from "react";
import { post, repoLabel, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import type { MissionProposal } from "../../lib/types";
import { EmptyState, plural, shortPath } from "../../components/primitives";
import type { MissionH } from "../map/world";
import { LiveChip, OutcomeChip, ProposalContextPanel, type Summary, type SummaryItem } from "./ProposalContext";
import "./suggested-ideas.css";

type Proposal = MissionProposal & { created?: string };
type Group = { key: string; label: string; note?: string; path?: string; items: Proposal[] };
type Order = "recommended" | "repo";
const enc = encodeURIComponent;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const span = (p: Proposal) => { const a = day(p.first_ts), b = day(p.last_ts); return a === b ? a : `${a} to ${b}`; };
const placeOf = (p: Proposal) => /\bin (.+?) on /.exec(p.reason)?.[1] ?? null;
const PREFS = "joyride.proposals";
const loadPrefs = (): { hideNoise: boolean; order: Order } => {
  try { const v = JSON.parse(localStorage.getItem(PREFS) ?? "{}"); return { hideNoise: v.hideNoise !== false, order: v.order === "repo" ? "repo" : "recommended" }; }
  catch { return { hideNoise: true, order: "recommended" }; }
};
const savePrefs = (v: { hideNoise: boolean; order: Order }) => { try { localStorage.setItem(PREFS, JSON.stringify(v)); } catch { /* private mode */ } };

export function ProposalsView() {
  const { data, error, reload } = useApi<Proposal[]>("/api/missions/proposals", ["proposals"]);
  const { data: summary, error: summaryError } = useApi<Summary>("/api/missions/proposals/summary", ["proposals", "proposal_briefs"]);
  const { data: missions } = useApi<MissionH[]>("/api/missions", ["missions"]);
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPrefs = (patch: Partial<typeof prefs>) => setPrefsState((p) => { const n = { ...p, ...patch }; savePrefs(n); return n; });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmNoise, setConfirmNoise] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const all = data ?? [];
  const titleOf = (id: string) => missions?.find((m) => m.id === id)?.title ?? id;
  const info = useMemo(() => new Map((summary?.items ?? []).map((i) => [i.id, i])), [summary]);
  const noise = all.filter((p) => info.get(p.id)?.noise);
  const items = prefs.hideNoise ? all.filter((p) => !info.get(p.id)?.noise) : all;
  const visibleIds = new Set(items.map((p) => p.id));
  const selVisible = [...sel].filter((id) => visibleIds.has(id));

  const groups = useMemo<Group[]>(() => {
    const newest = (a: Proposal, b: Proposal) => b.last_ts.localeCompare(a.last_ts);
    if (prefs.order === "recommended") {
      const by = (f: (i: SummaryItem | undefined) => boolean) => items.filter((p) => f(info.get(p.id))).sort(newest);
      return [
        { key: "yes", label: "Worth tracking", note: "Real work with a goal. Accept these, or merge them into the idea they continue.", items: by((i) => !i?.noise && i?.recommended === true) },
        { key: "wait", label: "Waiting for a brief", note: "The brief is still being written. The sessions and files below are ready now.", items: by((i) => !i?.noise && (i?.recommended ?? null) === null) },
        { key: "no", label: "Probably not an idea", note: "One-off questions, lookups and finished chores. Reject unless you want a record.", items: by((i) => !i?.noise && i?.recommended === false) },
        { key: "noise", label: "Noise", note: "Smoke tests and quick exchanges with nothing changed.", items: by((i) => Boolean(i?.noise)) },
      ].filter((g) => g.items.length);
    }
    const m = new Map<string, Group & { last: string }>();
    for (const p of items) {
      const repo = p.repos[0] ?? "";
      const g = m.get(repo) ?? { key: repo || "none", label: repo ? repoLabel(repo)! : "No repo", path: repo || undefined, items: [], last: "" };
      g.items.push(p);
      if (p.last_ts > g.last) g.last = p.last_ts;
      m.set(repo, g);
    }
    for (const g of m.values()) g.items.sort(newest);
    return [...m.values()].sort((a, b) => b.items.length - a.items.length || b.last.localeCompare(a.last));
  }, [items, info, prefs.order]);
  const sessionCount = all.reduce((a, p) => a + p.sessions.length, 0);
  const recommended = all.filter((p) => info.get(p.id)?.recommended === true && !info.get(p.id)?.noise).length;

  async function each(ids: string[], verb: "accept" | "reject", body: (id: string) => unknown = () => ({})) {
    setBusy("bulk"); setNote(null);
    let ok = 0; const failed: string[] = [];
    for (const id of ids) {
      try { await post(`/api/missions/proposals/${enc(id)}/${verb}`, body(id)); ok++; }
      catch (e: any) { failed.push(`${all.find((p) => p.id === id)?.title ?? id}: ${e.message}`); }
    }
    setBusy(null); setSel(new Set()); reload();
    if (failed.length) setNote({ kind: "error", text: `${verb === "accept" ? "Accepted" : "Rejected"} ${ok}, but ${failed.length} failed. ${failed.slice(0, 2).join("; ")}. Refresh and retry the rest.` });
    else setNote({ kind: "ok", text: verb === "accept" ? `Accepted ${plural(ok, "proposal")}. They're on the map now.` : `Rejected ${plural(ok, "proposal")}.` });
  }
  async function one(id: string, verb: "accept" | "reject", body: unknown = {}) {
    setBusy(id); setNote(null);
    try {
      const r = await post<any>(`/api/missions/proposals/${enc(id)}/${verb}`, body);
      setEditing(null);
      setSel((s) => { const n = new Set(s); n.delete(id); return n; });
      if (verb === "accept" && r?.mission) setNote({ kind: "ok", text: `Accepted as “${r.mission.title}”.` });
      reload();
    } catch (e: any) { setNote({ kind: "error", text: `${verb === "accept" ? "Accepting" : "Rejecting"} failed: ${e.message}` }); }
    finally { setBusy(null); }
  }
  async function backfill() {
    setBusy("backfill"); setNote(null);
    try {
      const r = await post<any>("/api/missions/backfill");
      if (r?.ok === false) setNote({ kind: "error", text: `Backfill stopped: ${r.error ?? "unknown error"}. Check the daemon log, then run it again.` });
      else setNote({ kind: "ok", text: `Backfill read ${plural(r?.considered ?? 0, "session")} and found ${plural(r?.clusters ?? 0, "cluster")}: ${r?.created?.length ?? 0} new, ${r?.kept?.length ?? 0} kept${r?.merge_suggestions ? `, ${r.merge_suggestions} with a merge suggestion` : ""}.` });
      reload();
    } catch (e: any) { setNote({ kind: "error", text: `Backfill failed: ${e.message}. Check that the daemon is running.` }); }
    finally { setBusy(null); }
  }
  const toggle = (id: string, on?: boolean) => setSel((s) => { const n = new Set(s); (on ?? !n.has(id)) ? n.add(id) : n.delete(id); return n; });
  const toggleOpen = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const acceptBody = (id: string) => (all.find((p) => p.id === id)?.merge_into ? { edits: { merge_into: null } } : {});

  // j/k move between proposals, o or Enter opens the brief, x selects, a accepts, r rejects, e edits.
  function onKey(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox" || t.tagName === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("li.prop") ?? [])];
    const row = t.closest<HTMLElement>("li.prop");
    const i = row ? rows.indexOf(row) : -1;
    const id = row?.dataset.proposal;
    if (e.key === "j" || e.key === "k") { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "j" ? 1 : -1)))]?.focus(); return; }
    if (!id) return;
    if (e.key === "o" || (e.key === "Enter" && t === row)) { e.preventDefault(); toggleOpen(id); return; }
    if (busy) return;
    if (e.key === "x") { e.preventDefault(); toggle(id); }
    else if (e.key === "a") { e.preventDefault(); one(id, "accept", acceptBody(id)); rows[i + 1]?.focus(); }
    else if (e.key === "r") { e.preventDefault(); one(id, "reject", { reason: "rejected in triage" }); rows[i + 1]?.focus(); }
    else if (e.key === "e") { e.preventDefault(); setEditing(id); }
  }

  const batch = summary?.batch;
  return (
    <section className="proposals-page" aria-labelledby="pp-title" data-testid="suggested-ideas">
      <header className="pp-header">
        <h2 id="pp-title">Suggested ideas</h2>
        <p className="pp-lede">
          {all.length
            ? <>Backfill grouped {plural(sessionCount, "session")} from your history into {plural(all.length, "proposed idea")}. Each one carries a short brief of what the work was; open it for the sessions, files and commits behind it. Nothing becomes an idea until you accept it.</>
            : <>Backfill reads your Claude Code and Codex history and proposes ideas for sessions that don't belong to one yet.</>}
        </p>
        {all.length ? (
          <p className="pp-tally" aria-live="polite">
            {!summary ? (summaryError ? <span className="pp-tally-warn">Briefs and noise checks are unavailable: {summaryError}.</span> : <span>Reading transcripts for context…</span>) : (
              <>
                <span><strong>{recommended}</strong> worth tracking</span>
                <span><strong>{items.length}</strong> to decide</span>
                {prefs.hideNoise && noise.length ? <span><strong>{noise.length}</strong> hidden as noise</span> : null}
                {batch?.running ? <span className="pp-tally-live">Writing briefs, {batch.done} of {batch.total} done</span> : null}
              </>
            )}
          </p>
        ) : null}
      </header>

      <div className="pp-toolbar" role="toolbar" aria-label="Bulk actions">
        <label className="pp-all">
          <input type="checkbox" checked={!!items.length && selVisible.length === items.length} ref={(el) => { if (el) el.indeterminate = selVisible.length > 0 && selVisible.length < items.length; }}
            onChange={(e) => setSel(e.target.checked ? new Set(items.map((p) => p.id)) : new Set())} disabled={!items.length} />
          <span>{selVisible.length ? `${selVisible.length} selected` : "Select all"}</span>
        </label>
        <button type="button" className="btn primary" disabled={!selVisible.length || !!busy} onClick={() => each(selVisible, "accept", acceptBody)}>Accept selected</button>
        <button type="button" className="btn" disabled={!selVisible.length || !!busy} onClick={() => each(selVisible, "reject", () => ({ reason: "rejected in bulk triage" }))}>Reject selected</button>
        <span className="pp-noise">
          <label className="pp-hide">
            <input type="checkbox" checked={prefs.hideNoise} onChange={(e) => setPrefs({ hideNoise: e.target.checked })} />
            <span>Hide noise</span>
            <span className="pp-count" aria-label={`${noise.length} noise proposals`}>{noise.length}</span>
          </label>
          {noise.length ? (
            confirmNoise ? (
              <span className="pp-confirm">
                Reject {plural(noise.length, "noise proposal")}?
                <button type="button" className="btn small" disabled={!!busy} onClick={() => { setConfirmNoise(false); each(noise.map((p) => p.id), "reject", (id) => ({ reason: `noise: ${info.get(id)?.noise_reason ?? "obvious noise"}` })); }}>Reject {noise.length}</button>
                <button type="button" className="btn ghost small" onClick={() => setConfirmNoise(false)}>Keep them</button>
              </span>
            ) : <button type="button" className="btn link" disabled={!!busy} onClick={() => setConfirmNoise(true)}>Reject all noise</button>
          ) : null}
        </span>
        <span className="spacer" />
        <span className="pp-order" role="radiogroup" aria-label="Order">
          <button type="button" role="radio" aria-checked={prefs.order === "recommended"} className={prefs.order === "recommended" ? "on" : ""} onClick={() => setPrefs({ order: "recommended" })}>Recommended first</button>
          <button type="button" role="radio" aria-checked={prefs.order === "repo"} className={prefs.order === "repo" ? "on" : ""} onClick={() => setPrefs({ order: "repo" })}>By repo</button>
        </span>
        <button type="button" className="btn" disabled={!!busy} onClick={backfill}>{busy === "backfill" ? "Running backfill…" : "Run backfill again"}</button>
      </div>
      {busy === "bulk" ? <p className="pp-note" role="status">Working through the selection…</p> : null}
      {note ? <p className={note.kind === "ok" ? "pp-note" : "inline-error"} role={note.kind === "ok" ? "status" : "alert"}>{note.text}</p> : null}
      {error && !data ? <p className="inline-error" role="alert">Proposals can't load: {error}. Check that the daemon is running.</p> : null}

      {data && !all.length ? (
        <EmptyState title="Nothing left to triage" action={<a className="btn" href={href("map")}>Go to the map</a>}>
          <p>Every proposal has been accepted or rejected. New ones appear when sessions pile up outside any idea; run backfill to look now.</p>
        </EmptyState>
      ) : null}
      {data && all.length && !items.length ? (
        <EmptyState title="Only noise is left" action={<button type="button" className="btn" onClick={() => setPrefs({ hideNoise: false })}>Show the {plural(noise.length, "noise proposal")}</button>}>
          <p>Everything still pending looks like a smoke test or a quick exchange. Reject them all, or show them to check first.</p>
        </EmptyState>
      ) : null}

      <div className="pp-groups" ref={listRef} onKeyDown={onKey}>
        {groups.map((g) => {
          const allOn = g.items.every((p) => sel.has(p.id));
          return (
            <section key={g.key} className={`pp-group pp-group-${prefs.order === "recommended" ? g.key : "repo"}`} aria-labelledby={`g-${g.key}`}>
              <header className="pp-group-head">
                <input type="checkbox" checked={allOn} onChange={(e) => g.items.forEach((p) => toggle(p.id, e.target.checked))} aria-label={`Select all in ${g.label}`} />
                <h3 id={`g-${g.key}`}>{g.label}</h3>
                <span className="meta">{plural(g.items.length, "proposal")}</span>
                {g.path ? <span className="meta mono" title={g.path}>{shortPath(g.path)}</span> : null}
              </header>
              {g.note ? <p className="pp-group-note">{g.note}</p> : null}
              <ul className="pp-list">
                {g.items.map((p) => {
                  const i = info.get(p.id);
                  const isOpen = open.has(p.id);
                  const repo = p.repos[0] ? repoLabel(p.repos[0])! : "No repo";
                  const place = placeOf(p);
                  return (
                    <li key={p.id} className={`prop${sel.has(p.id) ? " selected" : ""}${isOpen ? " open" : ""}${i?.noise ? " is-noise" : ""}`} data-proposal={p.id} tabIndex={0} aria-label={p.title} aria-expanded={isOpen}>
                      <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.title}`} tabIndex={-1} />
                      <div className="prop-main">
                        {editing === p.id ? (
                          <EditForm p={p} busy={busy === p.id} onCancel={() => setEditing(null)} onAccept={(title, goal) => one(p.id, "accept", { edits: { title, goal, merge_into: null } })} />
                        ) : (
                          <>
                            <h3 className="prop-title">
                              <button type="button" className="prop-toggle" aria-expanded={isOpen} aria-controls={`ctx-${p.id}`} onClick={() => toggleOpen(p.id)} tabIndex={-1}>{p.title}</button>
                            </h3>
                            <p className="prop-goal">{i?.brief?.summary ?? p.goal}</p>
                          </>
                        )}
                        <Verdict i={i} />
                        <p className="prop-meta">
                          {prefs.order === "recommended" ? <span>{place && place !== repo ? place : repo}</span> : place && place !== repo ? <span className="mono">{place}</span> : null}
                          <span>{plural(p.sessions.length, "session")}</span>
                          <span>{span(p)}</span>
                          {p.branches.length ? <span className="mono">{p.branches.join(", ")}</span> : null}
                          {i?.files ? <span>{plural(i.files, "file")} changed</span> : null}
                          {i?.commits ? <span>{plural(i.commits, "commit")}</span> : null}
                        </p>
                        {p.merge_into ? (
                          <p className="prop-merge">
                            Looks like part of <a href={href(`mission/${enc(p.merge_into)}`)}>{titleOf(p.merge_into)}</a>.
                            <button type="button" className="btn small" disabled={!!busy} onClick={() => one(p.id, "accept", { edits: { merge_into: p.merge_into } })}>Merge into it</button>
                          </p>
                        ) : null}
                        <button type="button" className="prop-more" aria-expanded={isOpen} aria-controls={`ctx-${p.id}`} onClick={() => toggleOpen(p.id)} tabIndex={-1}>
                          {isOpen ? "Hide the context" : "Show sessions, files and commits"}
                        </button>
                      </div>
                      {editing !== p.id ? (
                        <div className="prop-actions">
                          <button type="button" className="btn small accept" disabled={!!busy} onClick={() => one(p.id, "accept", acceptBody(p.id))}>{busy === p.id ? "Working" : p.merge_into ? "Accept as new" : "Accept"}</button>
                          <button type="button" className="btn small" disabled={!!busy} onClick={() => setEditing(p.id)}>Edit</button>
                          <button type="button" className="btn ghost small" disabled={!!busy} onClick={() => one(p.id, "reject", { reason: i?.noise ? `noise: ${i.noise_reason}` : "rejected in triage" })}>Reject</button>
                        </div>
                      ) : null}
                      {isOpen ? <div className="prop-context" id={`ctx-${p.id}`}><ProposalContextPanel id={p.id} /></div> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {all.length ? <p className="pp-keys meta">Keyboard: <kbd>j</kbd> <kbd>k</kbd> move, <kbd>o</kbd> opens the context, <kbd>x</kbd> selects, <kbd>a</kbd> accepts, <kbd>r</kbd> rejects, <kbd>e</kbd> edits.</p> : null}
    </section>
  );
}

/** One line a decision can rest on: outcome, recommendation and its reason, or why it is noise. */
function Verdict({ i }: { i: SummaryItem | undefined }) {
  if (!i) return null;
  if (i.noise) return <p className="prop-verdict"><span className="verdict noise">Noise</span><span className="verdict-why">{i.noise_reason}</span></p>;
  const b = i.brief;
  if (!b) {
    if (i.brief_status === "failed") return <p className="prop-verdict"><span className="verdict-why">No brief yet: {i.brief_error ?? "the model call failed"}. Open it to try again.</span></p>;
    return <p className="prop-verdict pending"><span className="verdict-why">Brief on its way</span>{i.running ? <LiveChip live="working" /> : null}</p>;
  }
  return (
    <p className="prop-verdict">
      <OutcomeChip outcome={b.outcome} />
      <span className={`verdict ${b.worth_tracking ? "yes" : "no"}`}>{b.worth_tracking ? "Worth tracking" : "Probably not an idea"}</span>
      {b.reason ? <span className="verdict-why">{b.reason}</span> : null}
      {i.running ? <LiveChip live="working" /> : null}
    </p>
  );
}

function EditForm({ p, busy, onCancel, onAccept }: { p: Proposal; busy: boolean; onCancel: () => void; onAccept: (title: string, goal: string) => void }) {
  const [title, setTitle] = useState(p.title);
  const [goal, setGoal] = useState(p.goal);
  return (
    <form className="prop-edit" onSubmit={(e) => { e.preventDefault(); if (title.trim()) onAccept(title.trim(), goal.trim()); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onCancel(); } }}>
      <input className="input prop-edit-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Idea title" autoFocus />
      <textarea className="input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Idea goal" />
      <div className="row">
        <button className="btn primary small" type="submit" disabled={busy || !title.trim()}>{busy ? "Accepting" : "Accept as idea"}</button>
        <button className="btn ghost small" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
