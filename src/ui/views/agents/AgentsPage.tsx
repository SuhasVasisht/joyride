// #/agents: every agent and session in one place, replacing Proposals, Fleet, Crew and Views. Rows sit
// in the map's groups and ideas (model.ts), with "Not in an idea yet" by project. Filters say who needs
// you, who is at your helm, crew or yours, and running, idle or done. Every old action works on the
// row: open, steer, hand the helm back, keep to yourself, save
// and close, answer what it asks, file a suggested idea, and open a task's sheet. Old routes redirect
// here (legacyTarget).
import { useMemo, useState, type ReactNode } from "react";
import { cleanTitle, post, timeAgo, useApi } from "../../lib/api";
import { href, type Route } from "../../lib/router";
import type { AttentionItem, Lens, MissionProposal, SessionView, WorkerView } from "../../lib/types";
import type { AsksResponse, Ask } from "../../../shared/asks";
import { useIntentions } from "../../lib/intentions";
import { VesselMark } from "../../components/Marks";
import { EmptyState, StateChip, TimeAgo, plural } from "../../components/primitives";
import { ReplyBox } from "../../components/ReplyBox";
import { FirstmateBar, KIND, SteerBox, isSteerable, statusOf, useFirstmate, type CrewTask } from "../crew/crew";
import { FleetChips, HelmChip, OwnerChip } from "../fleet/chips";
import { AskBadge, AskCard } from "../map/AskCard";
import { useSpec, type MissionH } from "../map/world";
import { ProposalsView } from "./SuggestedIdeas";
import { StartHereButton } from "../start/StartHereButton";
import {
  agentRows, facetCounts, filterPath, groupRows, matches, OWNERS, ORDERS, parseFilter, recentRows, SHOW, STATES, UNFILED,
  type AgentFilter, type AgentGroup, type AgentRow, type IdeaBlock,
} from "./model";
import "../crew/crew.css";
import "../fleet/fleet.css";
import "../map/plane.css";
import "./agents.css";

const enc = encodeURIComponent;
type FleetStatus = { feed: { attached: boolean; consumers: { id: string; last_poll: string | null; pending: number }[] }; policy_error: string | null };
type Ctx = { goal: (s: string | null) => string | undefined; idea: (id: string | null) => string | null; showIdea: boolean; reload: () => void };

export function AgentsPage({ route }: { route: Route }) {
  const filter = parseFilter(route.query);
  const spec = useSpec();

  const { data: workers, error } = useApi<WorkerView[]>("/api/workers", ["workers"]);
  const { data: tasks, reload: reloadTasks } = useApi<CrewTask[]>("/api/firstmate/tasks", ["tasks", "workers"]);
  const { data: sessions } = useApi<SessionView[]>("/api/sessions?since=7d&limit=200", ["sessions", "missions"]);
  const { data: missions } = useApi<MissionH[]>("/api/missions", ["missions"]);
  const { data: lenses } = useApi<Lens[]>("/api/lenses", ["lenses"]);
  const { data: attention } = useApi<AttentionItem[]>("/api/attention?open=1&limit=500", ["attention"]);
  const { data: asks, reload: reloadAsks } = useApi<AsksResponse>("/api/asks", ["asks", "tasks", "fleet"]);
  const { data: proposals, reload: reloadProposals } = useApi<MissionProposal[]>("/api/missions/proposals", ["proposals"]);
  const { data: fleet } = useApi<FleetStatus>("/api/fleet", ["fleet", "workers"]);
  const { data: herdr } = useApi<{ machines: { label: string; stale: boolean; panes: number; last_refresh: string | null }[] }>("/api/herdr/status", ["workers"], { pollMs: 5000 });
  const { data: fm, reload: reloadFm } = useFirstmate();

  const rows = useMemo(() => agentRows({
    workers: workers ?? [], tasks: tasks ?? [], sessions: sessions ?? [], missions: missions ?? [], attention: attention ?? [],
    asks: asks?.asks ?? [], proposals: proposals ?? [], controlId: fm?.pane?.worker ?? null, firstmateDir: fm?.vendor.path ?? null,
  }), [workers, tasks, sessions, missions, attention, asks, proposals, fm]);
  const intents = useIntentions(rows.filter((r) => r.kind !== "session" || r.suggestion).map((r) => r.session).slice(0, 80));
  const counts = facetCounts(rows, filter);
  const ideaFilter = route.query.get("idea");
  const shown = rows.filter((r) => matches(r, filter) && (!ideaFilter || r.mission === ideaFilter));
  const groups = useMemo(() => groupRows(shown, missions ?? [], lenses ?? [], spec), [shown, missions, lenses, spec]);
  const pending = (proposals ?? []).filter((p) => (p.status ?? "pending") === "pending").length;
  const titles = new Map((missions ?? []).map((m) => [m.id, m.title]));
  const ctx: Ctx = {
    goal: (s) => (s ? intents.get(s)?.goal || undefined : undefined),
    idea: (id) => (id ? titles.get(id) ?? id : null),
    showIdea: filter.order === "recent",
    reload: () => { reloadTasks(); reloadAsks(); reloadProposals(); },
  };
  const loading = !workers && !error;

  return (
    <div className="agents-page" data-testid="agents-page" data-show={filter.show}>
      <header className="ag-head">
        <p className="ag-kicker">Sessions</p>
        <h1>Agents</h1>
        <p className="ag-lede">Every agent and session, Firstmate's crew and your own, in the map's groups and ideas.</p>
        <HowItWorks />
        <FirstmateBar status={fm} onStarted={reloadFm} />
        <FeedLine fleet={fleet} />
      </header>

      <div className="ag-filters" role="toolbar" aria-label="Filters">
        <Seg label="Show" testid="show">
          {SHOW.map((s) => (
            <FilterLink key={s.id} on={filter.show === s.id} to={{ ...filter, show: s.id }} data={s.id} hot={s.id === "needs-you" && counts.show[s.id] > 0}>
              {s.label} <span className="n">{s.id === "suggested" ? pending : counts.show[s.id]}</span>
            </FilterLink>
          ))}
        </Seg>
        {filter.show !== "suggested" ? (
          <>
            <Seg label="Owner" testid="owner">
              {OWNERS.map((o) => <FilterLink key={o.id} on={filter.owner === o.id} to={{ ...filter, owner: o.id }} data={o.id} title={o.title}>{o.label} <span className="n">{counts.owner[o.id]}</span></FilterLink>)}
            </Seg>
            <Seg label="State" testid="state">
              {STATES.map((s) => <FilterLink key={s.id} on={filter.state === s.id} to={{ ...filter, state: s.id }} data={s.id}>{s.label} <span className="n">{counts.state[s.id]}</span></FilterLink>)}
            </Seg>
            <Seg label="Order" testid="order">
              {ORDERS.map((o) => <FilterLink key={o.id} on={filter.order === o.id} to={{ ...filter, order: o.id }} data={o.id}>{o.label}</FilterLink>)}
            </Seg>
          </>
        ) : null}
      </div>
      {ideaFilter ? <p className="ag-note">In {titles.get(ideaFilter) ?? ideaFilter}. <a href={href(filterPath(filter))}>Show all ideas</a></p> : null}
      {herdr?.machines.some((m) => m.stale && m.panes > 0) ? <p className="ag-note" role="status">Herdr is reconnecting. Agents show the last update until it returns.</p> : null}

      {filter.show === "suggested" ? (
        <ProposalsView />
      ) : (
        <>
          {error && !workers ? <p className="inline-error" role="alert">Agents can't load: {error}. Start the daemon with <code>./bin/joyride up</code>; this page reconnects on its own.</p> : null}
          {loading ? <p className="meta" aria-busy="true">Loading agents…</p> : null}
          {workers && !shown.length ? (
            <EmptyState title={rows.length ? "Nothing matches these filters" : "No agents yet"} action={rows.length ? <a className="btn" href={href("agents")}>Show every agent</a> : undefined}>
              <p>{rows.length ? "Try another filter, or show everything." : "Sessions you start in Herdr or a terminal, and crews Firstmate launches, appear here."}</p>
            </EmptyState>
          ) : null}
          {filter.order === "recent" ? (
            shown.length ? <ul className="ag-rows ag-recent" data-testid="agents-recent">{recentRows(shown).map((r) => <Row key={r.key} r={r} ctx={ctx} />)}</ul> : null
          ) : groups.map((g) => <Group key={g.id} g={g} ctx={ctx} expandDone={filter.state === "done"} pending={g.id === UNFILED ? pending : 0} />)}
        </>
      )}
    </div>
  );
}

function Seg({ label, testid, children }: { label: string; testid: string; children: ReactNode }) {
  return (
    <nav className="ag-seg" aria-label={label} data-seg={testid}>
      <span className="ag-seg-label">{label}</span>
      <span className="ag-seg-opts">{children}</span>
    </nav>
  );
}

function FilterLink({ on, to, data, hot, title, children }: { on: boolean; to: AgentFilter; data: string; hot?: boolean; title?: string; children: ReactNode }) {
  return <a href={href(filterPath(to))} aria-current={on ? "page" : undefined} className={hot ? "hot" : undefined} data-filter={data} title={title}>{children}</a>;
}

function Group({ g, ctx, expandDone, pending }: { g: AgentGroup; ctx: Ctx; expandDone: boolean; pending: number }) {
  const unfiled = g.kind === "unfiled";
  const kicker = unfiled ? null : g.kind === "lens" || g.kind === "spec" ? "Group" : g.kind === "repo" ? "Repo" : g.kind === "health" ? "Health" : null;
  return (
    <section className={`ag-group${unfiled ? " unfiled" : ""}`} data-group={g.id} aria-labelledby={`agg-${g.id}`}>
      <header className="ag-group-head">
        {kicker ? <span className="ag-group-kicker">{kicker}</span> : null}
        <h2 id={`agg-${g.id}`}>{g.title}</h2>
        <span className="meta">{plural(g.count, "agent")}</span>
        {unfiled && pending ? <a className="ag-group-link" href={href(filterPath({ show: "suggested" }))} data-suggested-link>{plural(pending, "suggested idea")} to review</a> : null}
      </header>
      {g.ideas.map((b) => <Idea key={b.id} b={b} ctx={ctx} expandDone={expandDone} />)}
    </section>
  );
}

function Idea({ b, ctx, expandDone }: { b: IdeaBlock; ctx: Ctx; expandDone: boolean }) {
  const [open, setOpen] = useState(false);
  const live = expandDone ? b.rows : b.rows.filter((r) => r.state !== "done");
  const done = expandDone ? [] : b.rows.filter((r) => r.state === "done");
  return (
    <div className="ag-idea" data-idea={b.mission ?? b.id}>
      <h3 className="ag-idea-title">
        {b.mission ? <a href={href(`mission/${enc(b.mission)}`)}>{b.title}</a> : <span>{b.title}</span>}
        <span className="meta">{plural(b.rows.length, "agent")}</span>
        {b.mission ? <StartHereButton context={{ kind: "idea", id: b.mission }} className="btn link small" /> : null}
      </h3>
      {live.length ? <ul className="ag-rows">{live.map((r) => <Row key={r.key} r={r} ctx={ctx} />)}</ul> : null}
      {done.length ? (
        <>
          <button type="button" className="btn link ag-done-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"} {plural(done.length, "finished one", "finished ones")}
          </button>
          {open ? <ul className="ag-rows done">{done.map((r) => <Row key={r.key} r={r} ctx={ctx} />)}</ul> : null}
        </>
      ) : null}
    </div>
  );
}

const agentName = (a: string | null | undefined) => (a === "codex" ? "Codex" : a === "claude" ? "Claude Code" : a || "");

function Row({ r, ctx }: { r: AgentRow; ctx: Ctx }) {
  const [steer, setSteer] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const w = r.worker, t = r.task, s = r.closed;
  const open = r.kind === "task" ? `task/${enc(t!.id)}` : r.kind === "worker" ? `worker/${enc(w!.id)}` : `session/${enc(s!.key)}`;
  const goal = ctx.goal(r.session);
  const title = r.kind === "task" ? t!.title || t!.id : r.kind === "worker" ? goal || cleanTitle(w!.title, w!.id) : goal || cleanTitle(s!.title, s!.key);
  const tier = w?.owner?.tier ?? "watched";
  const pruneAsk = r.asks.some((a) => a.answer.via === "prune");
  const act = async (id: string, fn: () => Promise<any>) => {
    setBusy(id); setFailed(null);
    try { const it = await fn(); if (it?.status === "failed") setFailed(it.error ?? "It did not go through."); else ctx.reload(); }
    catch (e: any) { setFailed(e?.message ?? String(e)); }
    finally { setBusy(null); }
  };
  const sub = [
    ctx.showIdea ? (r.mission ? `In ${ctx.idea(r.mission)}` : "Not in an idea yet") : null,
    r.project.title,
    r.kind === "worker" ? agentName(w!.agent) : r.kind === "session" ? `${agentName(s!.source)}, closed` : [KIND[t!.kind] ?? t!.kind, t!.id].filter(Boolean).join(" "),
  ].filter(Boolean).join(" · ");
  const now = r.kind === "worker" ? w!.current_action || null : r.kind === "task" ? t!.last_event || null : null;
  const st = r.kind === "task" ? statusOf(t!.status, t!.last_event) : null;

  return (
    <li className={`ag-row k-${r.kind}${r.needs ? " needs-you" : ""}`} data-agent={r.key} data-owner={r.owner} data-state={r.state}>
      <div className="ag-main">
        <a className="ag-title" href={href(open)} title={r.kind === "task" ? "Open the task sheet" : title}>
          <VesselMark status={r.kind === "worker" ? w!.status : r.kind === "task" ? st!.chip : "done"} agent={w?.agent ?? s?.source} size={12} />
          <span>{title}</span>
        </a>
        <p className="ag-sub">{sub}{now ? <> · <span className="mono">{now}</span></> : null}</p>
        {r.needs ? <p className="ag-needs">{r.needs}</p> : null}
        {r.suggestion ? <SuggestionLine r={r} ctx={ctx} /> : null}
        {r.kind === "task" && r.crew?.length ? (
          <ul className="ag-crew" aria-label="Crewmates">
            {r.crew.map((c) => <Crewmate key={c.id} w={c} ctx={ctx} />)}
          </ul>
        ) : null}
      </div>
      <div className="ag-meta">
        {r.kind === "worker" ? <FleetChips w={w!} task={false} /> : r.owner === "crew" ? <OwnerChip w={{ owner: { tier: "crew", task: t?.id ?? null, via: null }, crew: t?.id ?? null }} task={false} /> : null}
        {st ? <StateChip state={st.chip} label={st.label} title={st.reason || undefined} /> : <StateChip state={r.kind === "worker" ? w!.status : "done"} />}
        {r.updated ? <TimeAgo iso={r.updated} /> : null}
      </div>
      <div className="ag-actions">
        <a className="btn small" href={href(open)}>Open</a>
        {r.kind === "worker" ? (
          <>
            <button type="button" className="btn small" aria-expanded={steer} disabled={!w!.controllable}
              title={w!.controllable ? `Reply as yourself; you take its helm` : "This session runs outside Herdr, so Joyride can't type into it. Open it to move it to Herdr."}
              onClick={() => setSteer((o) => !o)}>Steer</button>
            {w!.helm?.by === "captain" ? (
              <button type="button" className="btn small" data-action="hand-back" disabled={busy === "hand-back"} title="Give the helm back to Firstmate now. Firstmate gets what you said while you held it."
                onClick={() => act("hand-back", () => post("/api/fleet/hand-back", { worker: w!.id }))}>Hand back</button>
            ) : null}
            {tier === "watched" ? (
              <button type="button" className="btn small ghost" data-action="exclude" disabled={busy === "exclude"} title="Keep this session to yourself: Firstmate stops steering it and answering its prompts (saved in fleet.yaml)."
                onClick={() => act("exclude", () => post("/api/fleet/exclude", { worker: w!.id }))}>Keep to myself</button>
            ) : tier === "excluded" ? (
              <button type="button" className="btn small ghost" data-action="include" disabled={busy === "include"} title="Put this session back in the fleet, so Firstmate guides it again."
                onClick={() => act("include", () => post("/api/fleet/include", { worker: w!.id }))}>Back in the fleet</button>
            ) : null}
            {tier === "watched" && r.state !== "running" && w!.controllable && !pruneAsk ? (
              <button type="button" className="btn small ghost" data-action="save-close" disabled={busy === "save-close"}
                title="Save its context, learnings and artifacts first, then close only its pane. You confirm below before anything closes."
                onClick={() => act("save-close", () => post("/api/fleet/propose-prune", { worker: w!.id, why: "You asked to save this session and close its idle pane." }))}>Save and close</button>
            ) : null}
          </>
        ) : r.kind === "task" && isSteerable(t!) ? (
          <button type="button" className="btn small" aria-expanded={steer} onClick={() => setSteer((o) => !o)}>Steer</button>
        ) : null}
      </div>
      {failed ? <p className="inline-error ag-error" role="alert">{failed}</p> : null}
      {steer ? (
        <div className="ag-steer" data-steer={r.key}>
          {r.kind === "worker"
            ? <ReplyBox worker={w!.id} session={w!.session} agent={w!.agent} rows={2} autoFocus label={`Steer ${w!.title || w!.id}`} placeholder="Tell the agent what to do. Enter sends, Shift+Enter adds a line." />
            : <SteerBox task={t!} onDone={ctx.reload} />}
        </div>
      ) : null}
      {r.asks.length ? <Asks asks={r.asks} /> : null}
    </li>
  );
}

/** One crewmate on its task's row: open it, or steer it yourself (you take its helm) and hand it back. */
function Crewmate({ w, ctx }: { w: WorkerView; ctx: Ctx }) {
  const [steer, setSteer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  async function handBack() {
    setBusy(true); setFailed(null);
    try { const it = await post<any>("/api/fleet/hand-back", { worker: w.id }); if (it?.status === "failed") setFailed(it.error ?? "It did not go through."); }
    catch (e: any) { setFailed(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }
  return (
    <li data-crewmate={w.id}>
      <span className="ag-crew-line">
        <VesselMark status={w.status} agent={w.agent} size={10} />
        <a href={href(`worker/${enc(w.id)}`)}>{ctx.goal(w.session) || cleanTitle(w.title, w.id)}</a>
        <StateChip state={w.status} />
        <HelmChip w={w} />
        <button type="button" className="btn link small" aria-expanded={steer} disabled={!w.controllable} onClick={() => setSteer((o) => !o)}
          title={w.controllable ? "Reply to this crewmate as yourself; you take its helm" : "This session runs outside Herdr, so Joyride can't type into it."}>Steer</button>
        {w.helm?.by === "captain" ? <button type="button" className="btn link small" data-action="hand-back" disabled={busy} onClick={handBack} title="Give the helm back to Firstmate now.">Hand back</button> : null}
      </span>
      {failed ? <p className="inline-error ag-error" role="alert">{failed}</p> : null}
      {steer ? (
        <div className="ag-steer" data-steer={`w:${w.id}`}>
          <ReplyBox worker={w.id} session={w.session} agent={w.agent} rows={2} autoFocus label={`Steer ${w.title || w.id}`} placeholder="Tell the crewmate what to do. Enter sends; you take its helm." />
        </div>
      ) : null}
    </li>
  );
}

/** What this agent is asking: the captain's calls open in place, the rest one line each until opened. */
function Asks({ asks }: { asks: Ask[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="ag-asks">
      {asks.map((a) => a.needs_you || open.has(a.id) ? <AskCard key={a.id} ask={a} /> : (
        <button key={a.id} type="button" className="ag-ask-more" onClick={() => setOpen((s) => new Set(s).add(a.id))} title="Show this ask">
          <AskBadge ask={a} />
        </button>
      ))}
    </div>
  );
}

/** A pending idea proposal covering this session, inline: file it into the idea it continues, or make it one. */
function SuggestionLine({ r, ctx }: { r: AgentRow; ctx: Ctx }) {
  const p = r.suggestion!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const others = p.sessions - 1;
  async function decide(verb: "accept" | "reject", body: unknown) {
    setBusy(true); setNote(null);
    try {
      const res = await post<any>(`/api/missions/proposals/${enc(p.id)}/${verb}`, body);
      setNote({ ok: true, text: verb === "reject" ? "Left out of ideas." : `Filed in “${res?.mission?.title ?? ctx.idea(p.merge_into) ?? p.title}”.` });
      ctx.reload();
    } catch (e: any) { setNote({ ok: false, text: `${verb === "accept" ? "Filing" : "Rejecting"} failed: ${e.message}` }); }
    finally { setBusy(false); }
  }
  return (
    <div className="ag-suggest" data-suggestion={p.id}>
      <p className="ag-suggest-text">
        {p.merge_into ? <>Looks like <a href={href(`mission/${enc(p.merge_into)}`)}>{ctx.idea(p.merge_into)}</a></> : <>Looks like a new idea: “{p.title}”</>}
        {others > 0 ? <span className="meta"> (with {plural(others, "other session")})</span> : null}
      </p>
      <span className="ag-suggest-acts">
        {p.merge_into
          ? <button type="button" className="btn small primary" disabled={busy} onClick={() => decide("accept", { edits: { merge_into: p.merge_into } })}>File it there</button>
          : <button type="button" className="btn small primary" disabled={busy} onClick={() => decide("accept", {})}>Make it an idea</button>}
        <button type="button" className="btn small ghost" disabled={busy} onClick={() => decide("reject", { reason: "rejected from the agents page" })}>Not an idea</button>
        <a className="btn link small" href={href(filterPath({ show: "suggested" }))}>Review</a>
      </span>
      {note ? <p className={note.ok ? "cap-ok" : "inline-error"} role={note.ok ? "status" : "alert"}>{note.text}</p> : null}
    </div>
  );
}

function HowItWorks() {
  return (
    <details className="ag-how">
      <summary>How crew, yours and the helm work</summary>
      <p>Crew is what Firstmate launched for its tasks; open a task to see its timeline, answer what it needs and steer it. Yours is what you started: Firstmate guides it with the rest of the fleet, may steer it and answer its permission prompts, and never types over your draft. Keep a session to yourself and Firstmate leaves it alone.</p>
      <p>The helm says who is steering right now. Steer a session yourself and you hold it until its turn ends plus 15 quiet minutes, or until you hand it back. Save and close keeps an idle session's context, learnings and artifacts, then closes only its pane.</p>
    </details>
  );
}

/** Whether Firstmate is reading the fleet feed, and how to attach it when it is not. */
function FeedLine({ fleet }: { fleet: FleetStatus | null | undefined }) {
  if (!fleet) return null;
  const c = [...fleet.feed.consumers].sort((a, b) => (b.last_poll ?? "").localeCompare(a.last_poll ?? ""))[0];
  return (
    <>
      <p className={`fleet-feed${fleet.feed.attached ? " on" : ""}`} data-testid="fleet-feed" data-attached={fleet.feed.attached}>
        {fleet.feed.attached
          ? <>Firstmate reads the fleet feed (last poll {timeAgo(c?.last_poll)}{c?.pending ? `, ${c.pending} waiting` : ""}).</>
          : c
            ? <>Firstmate has not read the fleet feed since {timeAgo(c.last_poll)}. It catches up when its watcher runs again.</>
            : <>Firstmate is not reading the fleet feed yet. Attach it with <code>./bin/joyride install firstmate-feed</code>.</>}
      </p>
      {fleet.policy_error ? <p className="inline-error" role="alert">{fleet.policy_error}</p> : null}
    </>
  );
}
