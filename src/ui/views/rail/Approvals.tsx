// Approvals tray: gated actions held by the guard, each with a deadline.
import { useState } from "react";
import { post, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import type { GuardRequest } from "../../lib/types";
import { EmptyState, LevelBadge, shortPath, useNow } from "../../components/primitives";
import { useArrivals } from "./arrivals";

const enc = encodeURIComponent;
export const guardSessionKey = (r: Pick<GuardRequest, "session" | "agent">) => (r.session ? (r.session.includes(":") ? r.session : `${r.agent}:${r.session}`) : null);

function clock(ms: number) {
  if (ms <= 0) return "Expired";
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
}

export async function decideGuard(id: string, decision: "allow" | "deny", opts: { reason?: string; remember?: { scope: "session" | "mission"; hours: number } } = {}) {
  return post<GuardRequest>(`/api/guard/requests/${enc(id)}/decide`, {
    decision, reason: opts.reason ?? (decision === "allow" ? "approved in Joyride" : "denied in Joyride"), ...(opts.remember ? { remember: opts.remember } : {}),
  });
}

export function ApprovalCard({ r, arrive, missionTitle }: { r: GuardRequest; arrive?: boolean; missionTitle?: string | null }) {
  const now = useNow(1000);
  const left = Date.parse(r.deadline) - now;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sessionKey = guardSessionKey(r);
  async function decide(key: string, decision: "allow" | "deny", remember?: { scope: "session" | "mission"; hours: number }) {
    setBusy(key); setErr(null);
    try { await decideGuard(r.id, decision, { remember }); }
    catch (e: any) { setErr(`That decision didn't reach the guard: ${e.message}. The agent is still waiting; try again.`); setBusy(null); }
  }
  return (
    <li className={`approval${arrive ? " arrive" : ""}`} data-guard={r.id}>
      <div className="ap-head">
        <LevelBadge level="L4" />
        <span className="ap-title">{r.title}</span>
        <span className={`ap-clock${left < 60_000 ? " hot" : ""}`} aria-label={`Deadline ${new Date(r.deadline).toLocaleTimeString()}`}>{clock(left)}</span>
      </div>
      <pre className="ap-cmd"><code>{r.summary}</code></pre>
      <p className="ap-where">
        <span>{r.agent === "codex" ? "Codex" : "Claude Code"}</span>
        {r.cwd ? <span className="mono" title={r.cwd}>{shortPath(r.cwd)}</span> : null}
        {sessionKey ? <a href={href(`session/${enc(sessionKey)}`)}>Session</a> : null}
      </p>
      <div className="ap-actions">
        <button type="button" className="btn primary" disabled={!!busy} onClick={() => decide("allow", "allow")}>{busy === "allow" ? "Allowing" : "Allow"}</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => decide("deny", "deny")}>{busy === "deny" ? "Denying" : "Deny"}</button>
      </div>
      <div className="ap-remember">
        <button type="button" className="btn link" disabled={!!busy || !r.session} title="Allow this rule in this session for 24 hours" onClick={() => decide("session", "allow", { scope: "session", hours: 24 })}>Allow for this session</button>
        <button type="button" className="btn link" disabled={!!busy || !missionTitle} title={missionTitle ? `Allow this rule for every session of ${missionTitle} for 8 hours` : "This session isn't linked to an idea"} onClick={() => decide("mission", "allow", { scope: "mission", hours: 8 })}>Allow for this idea</button>
      </div>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </li>
  );
}

export function ApprovalsTray() {
  const { data, error } = useApi<GuardRequest[]>("/api/guard/pending", ["guard"]);
  const { data: missions } = useApi<{ id: string; title: string; sessions: { source: string; id: string }[] }[]>("/api/missions", ["missions"]);
  const items = data ?? [];
  const arrivals = useArrivals("approvals", data ? items.map((r) => r.id) : null);
  const [batch, setBatch] = useState(false);
  const missionOf = (r: GuardRequest) => {
    const key = guardSessionKey(r);
    return key ? (missions ?? []).find((m) => m.sessions.some((s) => `${s.source}:${s.id}` === key))?.title ?? null : null;
  };
  async function denyAll() {
    setBatch(true);
    await Promise.allSettled(items.map((r) => decideGuard(r.id, "deny", { reason: "denied in a batch in Joyride" })));
    setBatch(false);
  }
  return (
    <section className={`rail-sec approvals${items.length ? " has-items" : ""}`} data-rail="approvals" aria-labelledby="rail-approvals">
      <h3 id="rail-approvals">Approvals {items.length ? <span className="count">{items.length}</span> : null}
        {items.length > 1 ? <button type="button" className="btn ghost small rail-action" disabled={batch} onClick={denyAll}>{batch ? "Denying" : "Deny all"}</button> : null}
      </h3>
      {error && !data ? <p className="inline-error">The approvals tray can't reach the guard: {error}. Gated actions are denied on timeout until it's back.</p> : null}
      {items.length ? (
        <ul className="rail-list">{items.map((r) => <ApprovalCard key={r.id} r={r} arrive={arrivals.has(r.id)} missionTitle={missionOf(r)} />)}</ul>
      ) : data ? (
        <EmptyState title="Nothing held for your call">
          <p>Pushes, deploys and remote writes stop here before they run, so you decide with the command in front of you.</p>
        </EmptyState>
      ) : null}
    </section>
  );
}
