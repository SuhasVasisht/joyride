// One captain request on its way to Firstmate: placed by Jev, sent on its own after AUTO_SEND_MS unless the
// captain clicks Change, then tracked through Firstmate's receipts until it morphs into the task it became.
// A note or a list saves itself on the map the same way, never reaching Firstmate; Change turns any of them
// into either of the others.
import { draftStore } from "../../lib/drafts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, onChange, post } from "../../lib/api";
import { href } from "../../lib/router";
import { saveNote } from "../notes/notes";
import { currentGroup, useCurrentGroup } from "../../views/map/current";
import { itemLabel } from "../../../shared/board";
import type { ComposeKind } from "../../../shared/compose";
import {
  AUTO_SEND_MS, SETTLED_MS, ghostStore, intentFor, noteInput, notePlace, pct, recastGhost, steps, targetKey, targetLabel, targetRect,
  type Ghost, type Placement, type Progress, type Target,
} from "./ghost";

const KINDS: { k: ComposeKind; label: string }[] = [{ k: "task", label: "Task" }, { k: "note", label: "Note" }, { k: "list", label: "List" }];
const NAME: Record<ComposeKind, string> = { task: "task", note: "note", list: "list" };

type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: any };

const lastRect = new Map<string, DOMRect>();
const lastSig = new Map<string, string>();
const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * FLIP keyed by the ghost's id: wherever the card was last (or the composer it flew from), it animates to where it
 * is now. It flies only when the card's state or target changes (`sig`); when its anchor merely moves (the chart
 * pans under it) the card follows without a flight.
 */
function useFlip(ref: React.RefObject<HTMLElement | null>, g: Ghost, sig: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    // Mid-flight the rect includes the transform; measure only once the card has landed.
    if (!el || el.getAnimations?.().some((a) => a.playState === "running")) return;
    const now = el.getBoundingClientRect();
    const prev = lastRect.get(g.id) ?? (g.from ? new DOMRect(g.from.x, g.from.y, g.from.w, g.from.h) : null);
    const same = lastSig.get(g.id) === sig;
    lastRect.set(g.id, now);
    lastSig.set(g.id, sig);
    if (!prev || same || reduceMotion() || !el.animate) return;
    const dx = prev.left - now.left, dy = prev.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const sx = prev.width / Math.max(1, now.width), sy = prev.height / Math.max(1, now.height);
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.55 }, { transform: "none", opacity: 1 }],
      { duration: 460, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
  });
  useEffect(() => () => { lastRect.delete(g.id); lastSig.delete(g.id); }, [g.id]);
}

export function GhostCard({ g }: { g: Ghost }) {
  const ref = useRef<HTMLDivElement>(null);
  const [changing, setChanging] = useState(false);
  const anchor = targetRect(g.target, g);
  useFlip(ref, g, `${g.phase}|${g.as ?? ""}|${g.target ? targetKey(g.target) : ""}|${g.progress?.stage ?? ""}|${anchor ? "on" : "tray"}`);
  const update = (patch: Partial<Ghost>) => ghostStore.update(g.id, patch);
  const kind: ComposeKind = g.as ?? "task";
  const local = kind !== "task";
  const current = useCurrentGroup();
  const place = notePlace(g, current);

  // Sent before the composer had the idea's title: name the idea, not its slug.
  useEffect(() => {
    if (!g.idea || g.ideaTitle) return;
    api<{ title: string }>(`/api/missions/${encodeURIComponent(g.idea)}`).then((m) => update({ ideaTitle: m.title })).catch(() => {});
  }, [g.idea, g.ideaTitle]);

  // placing: ask the daemon where this goes (and, when the words didn't say, whether it is a task at all).
  useEffect(() => {
    if (g.phase !== "placing") return;
    let live = true;
    post<Placement>("/api/firstmate/place", { text: g.text, ...(g.idea ? { idea: g.idea } : {}), ...(g.unsure ? { kinds: true } : {}) })
      .then((pl) => {
        if (!live) return;
        const k = pl.kind;
        if (k && k.choice !== "task" && k.auto) return update({ ...recastGhost(g, k.choice), phase: "placed", placement: pl });
        if (k && k.choice !== "task") return update({ phase: "choose", placement: pl, target: pl.choice ?? undefined });
        update(pl.auto && pl.choice ? { phase: "placed", placement: pl, target: pl.choice } : { phase: "choose", placement: pl, target: pl.choice ?? undefined });
      })
      .catch((e) => { if (live) update({ phase: "failed", error: `Joyride could not place this: ${e.message}` }); });
    return () => { live = false; };
  }, [g.phase]);

  // placed: send on its own unless the captain is changing the target.
  // A note or list confirmed in New's preview saves at once.
  const [left, setLeft] = useState(g.confirmed && local ? 0 : AUTO_SEND_MS);
  useEffect(() => {
    if (g.phase !== "placed" || changing) return;
    const start = Date.now() - (AUTO_SEND_MS - left);
    const t = setInterval(() => {
      const rest = Math.max(0, AUTO_SEND_MS - (Date.now() - start));
      setLeft(rest);
      if (rest === 0) { clearInterval(t); if (local) save(); else send(g.target!); }
    }, 100);
    return () => clearInterval(t);
  }, [g.phase, changing]);

  async function send(t: Target) {
    setChanging(false);
    update({ phase: "sending", target: t, error: undefined });
    const it = intentFor(t, g.text);
    try {
      const rec = await post<IntentRec>("/api/intents", it);
      if (rec.status === "failed") return update({ phase: "failed", intent: rec.id, error: rec.error ?? "Firstmate did not take the request." });
      if (g.draftKey && draftStore.read(g.draftKey).text.trim() === g.text) draftStore.clear(g.draftKey);
      if (rec.result?.via === "steer" || it.kind === "steer_task") return update({ phase: "steered", intent: rec.id, settledAt: Date.now() });
      update({ phase: "sent", intent: rec.id, mission: rec.result?.mission ? { id: rec.result.mission, title: rec.result.mission_title ?? rec.result.mission } : undefined });
    } catch (e: any) { update({ phase: "failed", error: `The request was not sent: ${e.message}` }); }
  }

  /** Save a note or list where it was typed (never telling Firstmate); `patch` recasts it first. */
  async function save(patch: Partial<Ghost> = {}) {
    setChanging(false);
    const next = { ...g, ...patch };
    const input = noteInput(next);
    if (!input.bullets.length) {
      return update({ ...patch, phase: "failed", error: next.as === "list" ? "This list has no items yet. Type them after a colon, like “list: milk, eggs”." : "This note is empty. Type what you want to remember after the colon." });
    }
    update({ ...patch, phase: "saving", error: undefined });
    try {
      const where = notePlace(next, currentGroup());
      const n = await saveNote(where.anchor, input.bullets, input.title);
      if (g.draftKey && draftStore.read(g.draftKey).text.trim() === g.text) draftStore.clear(g.draftKey);
      // Saved: the card hands off to a landing flight from where it sits into the item's card, and goes.
      const r = ref.current?.getBoundingClientRect();
      update({ phase: "saved", saved: n.id, landing: { place: where.place, label: itemLabel(n, 48), bullets: n.bullets }, ...(r ? { from: { x: r.left, y: r.top, w: r.width, h: r.height } } : {}) });
    } catch (e: any) { update({ phase: "failed", error: `The ${NAME[next.as ?? "note"]} was not saved: ${e.message}` }); }
  }

  /** Change: task, note or list. A note or list saves at once; a task goes back to being placed. */
  function makeIt(k: ComposeKind) {
    if (k === kind && k === "task") return;
    if (k !== "task") return save(recastGhost(g, k));
    setChanging(false);
    setLeft(AUTO_SEND_MS); // a full countdown again once it is placed as a task
    update({ ...recastGhost(g, "task"), phase: g.placement ? "choose" : "placing", target: g.placement?.choice ?? undefined });
  }

  // sent: follow Firstmate's receipts and the backlog. A reply settles the ghost too: the map keeps the reply on
  // the card the request became (map/ReplyNote.tsx) until the captain dismisses it.
  useEffect(() => {
    if (g.phase !== "sent" || !g.intent || g.progress?.stage === "task") return;
    let live = true;
    const settles = (p: Progress) => p.stage === "task" || (p.stage === "replied" && !ghostStore.list().find((x) => x.id === g.id)?.settledAt);
    const load = () => api<Progress>(`/api/firstmate/requests/${encodeURIComponent(g.intent!)}`)
      .then((p) => { if (live) ghostStore.update(g.id, { progress: p, ...(settles(p) ? { settledAt: Date.now() } : {}) }); })
      .catch(() => {});
    load();
    const t = setInterval(load, 3000);
    const off = onChange((c) => { if (c.entity === "tasks" || c.entity === "*") load(); });
    return () => { live = false; clearInterval(t); off(); };
  }, [g.phase, g.intent, g.progress?.stage]);

  // settled (became a task, or a steer landed): leave after a while. A saved note or list is a landing flight now.
  useEffect(() => {
    if (!g.settledAt) return;
    const t = setTimeout(() => ghostStore.remove(g.id), Math.max(0, SETTLED_MS - (Date.now() - g.settledAt)));
    return () => clearTimeout(t);
  }, [g.settledAt]);

  const [nudge, setNudge] = useState<string | null>(null);
  async function doNudge() {
    try { const r = await post<any>(`/api/firstmate/requests/${encodeURIComponent(g.intent!)}/nudge`); setNudge(r.nudged ? "Rang Firstmate again." : r.message ?? "Firstmate already read this."); }
    catch (e: any) { setNudge(e.message); }
  }

  const style = anchor ? { position: "fixed" as const, left: anchor.left, top: anchor.bottom + 8, width: Math.max(280, Math.min(380, anchor.width)) } : undefined;
  const isTask = g.progress?.stage === "task";
  const options = g.placement?.options ?? [];
  const label = g.target ? targetLabel(g.target, g.mission) : null;
  const guess = g.placement?.kind && g.placement.kind.choice !== "task" ? g.placement.kind : null;
  const lines = g.lines ?? [];

  return (
    <div ref={ref} className={`ghost ghost-${g.phase}${isTask ? " is-task" : ""}${local ? ` as-${kind}` : ""}`} style={style} data-ghost={g.id} data-as={kind} role="group"
      aria-label={kind === "note" ? "New note" : kind === "list" ? "New list" : "New task request"}>
      {kind === "list" ? (
        <div className="ghost-text ghost-list">
          {g.title ? <b className="ghost-list-title">{g.title}</b> : null}
          {lines.length ? <ul>{lines.slice(0, 8).map((l, i) => <li key={i}><span className="ghost-box" aria-hidden />{l}</li>)}{lines.length > 8 ? <li className="meta">and {lines.length - 8} more</li> : null}</ul> : <span className="meta">No items yet</span>}
        </div>
      ) : kind === "note" && lines.length ? (
        <div className="ghost-text ghost-note">{lines.length > 1 ? <ul>{lines.slice(0, 6).map((l, i) => <li key={i}>{l}</li>)}</ul> : lines[0]}</div>
      ) : (
        <div className="ghost-text">{g.text.length > 160 ? `${g.text.slice(0, 160)}…` : g.text}</div>
      )}

      {g.phase === "placing" && <div className="ghost-where muted">{g.unsure ? "Working out what this is…" : "Finding where this goes…"}</div>}

      {local && g.phase !== "choose" && g.phase !== "failed" && (
        <div className="ghost-where">
          <span className="ghost-verb">{kind === "list" ? "List for" : "Note for"}</span> <b>{place.name}</b>
        </div>
      )}

      {!local && label && g.phase !== "choose" && g.phase !== "placing" && (
        <div className="ghost-where">
          <span className="ghost-verb">{label.verb}</span>{label.name ? <> <b>{label.name}</b></> : null}
          {g.phase === "placed" && g.placement?.via === "jev" ? <span className="ghost-p meta"> · {pct(g.target!.p)}</span> : null}
        </div>
      )}

      {g.phase === "placed" && (
        <div className="ghost-actions">
          <div className="ghost-countdown" aria-hidden><span style={{ transform: `scaleX(${changing ? 1 : left / AUTO_SEND_MS})` }} /></div>
          <span className="meta" role="status">{changing ? (local ? "Paused. Pick what it is." : "Paused. Pick where it goes.") : `${local ? "Saving" : "Sending"} in ${Math.ceil(left / 1000)} s`}</span>
          <span className="spacer" />
          <button type="button" className="btn small" aria-expanded={changing} onClick={() => setChanging((c) => !c)}>Change</button>
          <button type="button" className="btn small primary" onClick={() => (local ? save() : send(g.target!))}>{local ? "Save now" : "Send now"}</button>
        </div>
      )}

      {g.phase === "choose" && (
        <div className="ghost-where">
          <span className="ghost-verb">{guess ? `Is this a ${NAME[guess.choice]}?` : "Where does this go?"}</span>
          <span className="meta"> {g.placement?.error ?? (guess ? "Joyride can't tell from the words, so it waits for you." : "Joyride isn't sure, so it waits for you.")}</span>
        </div>
      )}

      {(g.phase === "choose" || changing) && (
        <div className="ghost-kinds" role="group" aria-label="Make it a">
          <span className="meta">Make it a</span>
          {KINDS.map(({ k, label: l }) => (
            <button key={k} type="button" className={`ghost-kind-btn${kind === k && !(k === "task" && guess) ? " current" : ""}`} aria-pressed={kind === k && !(k === "task" && guess)} onClick={() => makeIt(k)}>{l}</button>
          ))}
        </div>
      )}

      {local && changing && (
        <ul className="ghost-options" role="list" aria-label="Where this goes">
          <li><button type="button" className="ghost-option cancel" onClick={() => ghostStore.remove(g.id)}>Don't save</button></li>
        </ul>
      )}

      {!local && (g.phase === "choose" || changing) && (
        <ul className="ghost-options" role="list" aria-label="Where this goes">
          {options.map((o) => {
            const l = targetLabel(o);
            return (
              <li key={targetKey(o)}>
                <button type="button" className={`ghost-option${g.target && targetKey(g.target) === targetKey(o) ? " current" : ""}`} onClick={() => send(o)}>
                  <span className="ghost-kind">{o.kind === "task" ? "Task" : o.kind === "idea" ? "Idea" : "New idea"}</span>
                  <span className="ghost-name">{o.kind === "new" ? "Joyride names it" : l.name}</span>
                  {o.p > 0 && o.kind !== "new" ? <span className="meta">{pct(o.p)}</span> : null}
                </button>
              </li>
            );
          })}
          <li><button type="button" className="ghost-option cancel" onClick={() => ghostStore.remove(g.id)}>Don't send</button></li>
        </ul>
      )}

      {g.phase === "sending" && <div className="meta" role="status">Sending to Firstmate…</div>}

      {g.phase === "saving" && <div className="meta" role="status">Saving…</div>}

      {g.phase === "steered" && <div className="ghost-done" role="status">In the task's inbox. The crewmate reads it at its next step.</div>}

      {g.phase === "sent" && (
        <>
          <ol className="ghost-steps" aria-label="Progress">
            {steps(g.progress).map((s) => <li key={s.id} className={s.state} aria-current={s.state === "current" ? "step" : undefined}>{s.label}</li>)}
          </ol>
          {g.progress?.reply ? <blockquote className="ghost-reply"><span className="meta">Firstmate replied</span> {g.progress.reply.body}</blockquote> : null}
          {isTask && g.progress?.task ? (
            <div className="ghost-task">
              <b>{g.progress.task.title}</b>
              {g.progress.task.mission ? <a href={href(`mission/${encodeURIComponent(g.progress.task.mission)}`)}>Open the idea</a> : null}
            </div>
          ) : null}
          {g.progress?.unread_too_long ? (
            <div className="ghost-actions">
              <span className="meta">Firstmate hasn't read this{g.progress.firstmate_running ? "" : ", and it isn't running"}.</span>
              <span className="spacer" />
              <button type="button" className="btn small" onClick={doNudge}>Nudge</button>
            </div>
          ) : null}
          {nudge ? <div className="meta" role="status">{nudge}</div> : null}
        </>
      )}

      {g.phase === "failed" && (
        <div className="ghost-fail">
          <p className="inline-error" role="alert">{g.error}</p>
          <div className="ghost-actions">
            <span className="spacer" />
            <button type="button" className="btn small" onClick={() => ghostStore.remove(g.id)}>Dismiss</button>
            {local ? (
              <button type="button" className="btn small" onClick={() => save()}>Try again</button>
            ) : (
              <button type="button" className="btn small" onClick={() => { setChanging(false); update({ phase: g.placement ? "choose" : "placing", error: undefined }); }}>Pick again</button>
            )}
          </div>
        </div>
      )}

      {(g.phase === "sent" || g.phase === "steered") && (
        <button type="button" className="ghost-close btn link" aria-label={local ? `Hide this ${NAME[kind]}` : "Hide this request"} onClick={() => ghostStore.remove(g.id)}>Hide</button>
      )}
    </div>
  );
}
