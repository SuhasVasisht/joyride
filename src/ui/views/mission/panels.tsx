// Mission panels owned by the core UI: done_when, workers, sessions, timeline, dependencies.
import { useMemo, useState } from "react";
import { api, cleanTitle, post, repoLabel, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import type { AttentionItem, EvidenceItem, SessionView, WorkerView } from "../../lib/types";
import { VesselMark } from "../../components/Marks";
import { EmptyState, LevelBadge, StateChip, TimeAgo, plural } from "../../components/primitives";
import { ReplyBox } from "../../components/ReplyBox";
import { SentImages } from "../../components/ImageAttach";
import { PromptAnswer } from "../../components/PromptAnswer";
import { refKey, type MissionH, type VerdictRec } from "../map/world";
import { noteTimelineEntries, useNotes } from "../../components/notes/notes";

type P = { mission: MissionH; missionId: string };
const enc = encodeURIComponent;
const KINDS = ["test", "e2e", "screenshot", "review", "other"] as const;

// ---------- done when ----------
export function DoneWhenPanel({ mission: m }: P) {
  const { data: verdict } = useApi<VerdictRec | null>(`/api/evidence/verdict/${enc(m.id)}`, ["verdicts", "evidence"]);
  const per = new Map((verdict?.per_criterion ?? []).map((c) => [c.id, c]));
  const [text, setText] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("test");
  const [err, setErr] = useState<string | null>(null);
  const save = async (done_when: { id?: string; text: string; kind: string }[]) => {
    setErr(null);
    try { await api(`/api/missions/${enc(m.id)}`, { method: "PUT", json: { done_when } }); }
    catch (e: any) { setErr(`The criteria were not saved: ${e.message}`); }
  };
  const nextId = () => { let i = m.done_when.length + 1; while (m.done_when.some((c) => c.id === `c${i}`)) i++; return `c${i}`; };
  const passed = m.done_when.filter((c) => per.get(c.id)?.verdict === "pass").length;
  return (
    <div className="panel-body">
      <p className="panel-meta">
        {verdict ? <>Last verdict <StateChip state={verdict.verdict} /> <TimeAgo iso={verdict.created} />{m.done_when.length ? <>, {passed} of {m.done_when.length} criteria pass</> : null}</>
          : m.done_when.length ? "No verdict yet. Evidence from tests and screenshots is judged against these criteria." : null}
      </p>
      {m.done_when.length ? (
        <ul className="criteria">
          {m.done_when.map((c) => {
            const r = per.get(c.id);
            const v = r?.verdict ?? "none";
            return (
              <li key={c.id} className={`crit v-${v}`} data-criterion={c.id} data-verdict={v}>
                <span className="crit-box" aria-label={v === "none" ? "Not judged yet" : v}>{v === "pass" ? "✓" : v === "fail" ? "✕" : v === "insufficient" ? "?" : ""}</span>
                <span className="crit-text">{c.text}{r?.reason ? <span className="crit-reason">{r.reason}</span> : null}</span>
                <span className="crit-kind">{c.kind}</span>
                <button type="button" className="btn ghost small crit-remove" aria-label={`Remove criterion: ${c.text}`} onClick={() => save(m.done_when.filter((x) => x.id !== c.id))}>Remove</button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="Say what done looks like">
          <p>Add checks an agent can prove with evidence: a passing test, an end-to-end run, a screenshot. Closing the idea then needs a passing verdict.</p>
        </EmptyState>
      )}
      <form className="row add-crit" onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (!t) return; save([...m.done_when, { id: nextId(), text: t, kind }]); setText(""); }}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a criterion, for example: the export test passes" aria-label="New criterion" />
        <select className="input kind-select" value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Evidence kind">
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className="btn" type="submit" disabled={!text.trim()}>Add</button>
      </form>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </div>
  );
}

// ---------- workers ----------
export function WorkersPanel({ mission: m }: P) {
  const { data: workers, error } = useApi<WorkerView[]>("/api/workers", ["workers"]);
  const keys = useMemo(() => new Set(m.sessions.map(refKey)), [m.sessions]);
  const mine = (workers ?? []).filter((w) => w.mission === m.id || (w.session && keys.has(w.session)));
  if (error && !workers) return <p className="inline-error">Live workers are unavailable: {error}. Check that Herdr is running.</p>;
  if (!mine.length) {
    return <EmptyState title="No agents are working on this right now"><p>A worker shows up here as soon as an agent runs in one of this idea's sessions. Link a running session below, or start one from Herdr.</p></EmptyState>;
  }
  return (
    <ul className="worker-list">
      {mine.map((w) => (
        <li key={w.id} className={`wrow s-${w.status}`} data-worker-row={w.id}>
          <div className="wrow-head">
            <VesselMark status={w.status} agent={w.agent} size={14} />
            <a className="wrow-title" href={href(`worker/${enc(w.id)}`)}>{w.title || w.id}</a>
            <StateChip state={w.status} />
            <span className="meta">{w.agent} in {repoLabel(w.repo ?? w.cwd)}</span>
            <span className="spacer" />
            <span className="meta"><TimeAgo iso={w.updated} /></span>
          </div>
          <div className="wrow-action">{w.current_action ? <code>{w.current_action}</code> : <span className="meta">{w.status === "blocked" ? "Waiting at a prompt in its terminal" : "No action reported"}</span>}</div>
          {w.last_message ? <blockquote className="wrow-msg">{w.last_message}</blockquote> : null}
          {w.controllable && w.status === "blocked"
            ? <PromptAnswer worker={w.id} name={w.title || undefined} compact />
            : w.controllable
            ? <ReplyBox worker={w.id} session={w.session} agent={w.agent} label={`Reply to ${w.title || w.id}`} placeholder={`Reply to ${w.title || "this worker"}`} />
            : <p className="meta">Runs outside Herdr, so replies go through its own terminal. <a href={href(`worker/${enc(w.id)}`)}>Get its resume command</a></p>}
        </li>
      ))}
    </ul>
  );
}

// ---------- sessions ----------
export function SessionsPanel({ mission: m }: P) {
  const { data: sessions, reload } = useApi<SessionView[]>(`/api/sessions?mission=${enc(m.id)}&limit=500`, ["sessions", "missions"]);
  const [q, setQ] = useState("");
  const { data: found } = useApi<SessionView[]>(q.trim().length >= 2 ? `/api/sessions?mission=none&limit=8&q=${enc(q.trim())}` : null, ["sessions", "missions"]);
  const [err, setErr] = useState<string | null>(null);
  const link = async (key: string) => {
    setErr(null);
    try { await post(`/api/missions/${enc(m.id)}/sessions`, { refs: [key] }); setQ(""); reload(); }
    catch (e: any) { setErr(`Could not link the session: ${e.message}`); }
  };
  const unlink = async (key: string) => {
    setErr(null);
    try { await api(`/api/missions/${enc(m.id)}/sessions/${enc(key)}`, { method: "DELETE" }); reload(); }
    catch (e: any) { setErr(`Could not unlink the session: ${e.message}`); }
  };
  const list = sessions ?? [];
  const missing = m.sessions.length - list.length;
  return (
    <div className="panel-body">
      {list.length ? (
        <ul className="session-list">
          {list.map((s) => (
            <li key={s.key} data-session-row={s.key}>
              <a className="sl-title" href={href(`session/${enc(s.key)}`)}>{cleanTitle(s.title || s.first_prompt, s.key)}</a>
              <span className="meta">{s.source === "codex" ? "Codex" : "Claude Code"}</span>
              {s.branch ? <span className="meta mono">{s.branch}</span> : null}
              <span className="meta">{plural(s.turns, "turn")}</span>
              <span className="meta"><TimeAgo iso={s.updated} /></span>
              <button type="button" className="btn ghost small" onClick={() => unlink(s.key)} aria-label={`Unlink ${cleanTitle(s.title, s.key)}`}>Unlink</button>
            </li>
          ))}
        </ul>
      ) : <EmptyState title="No sessions linked yet"><p>Link the transcripts that belong to this idea so its timeline, evidence and health follow them.</p></EmptyState>}
      {missing > 0 ? <p className="meta">{plural(missing, "linked session")} not in the index (archived or deleted transcripts).</p> : null}
      <div className="link-session">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Link a session: search unlinked sessions by title, prompt or folder" aria-label="Search sessions to link" />
        {q.trim().length >= 2 ? (
          <ul className="link-results" role="listbox" aria-label="Sessions to link">
            {(found ?? []).map((s) => (
              <li key={s.key}>
                <button type="button" className="link-result" onClick={() => link(s.key)}>
                  <span>{cleanTitle(s.title, s.key)}</span><span className="meta">{repoLabel(s.repo)} <TimeAgo iso={s.updated} /></span>
                </button>
              </li>
            ))}
            {found && !found.length ? <li className="meta">No unlinked sessions match “{q.trim()}”.</li> : null}
          </ul>
        ) : null}
      </div>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </div>
  );
}

// ---------- timeline ----------
type Ev = { ts: string; kind: string; text: string; detail?: string; href?: string; level?: string; hot?: boolean; count?: number; tools?: Record<string, number>; images?: string[] };
type RawEvent = { id: string; ts: string; source: string; type: string; session?: string; agent?: string; data?: Record<string, any> };
const clip = (s: unknown, n = 140) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n).trimEnd() + "…" : t; };

/** What a submitted prompt says, in a line: harness-injected prompts (background task results, slash commands) get a plain description. */
function promptLine(raw: unknown): { kind: string; text: string; detail?: string } {
  const p = String(raw ?? "");
  const tag = (name: string) => p.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  if (/^\s*<task-notification>/.test(p)) return { kind: "task", text: "A background task reported back", detail: tag("summary") ? clip(tag("summary"), 120) : tag("status") };
  const cmd = tag("command-name");
  if (cmd) return { kind: "prompt", text: `Ran ${cmd}`, detail: tag("command-args") ? clip(tag("command-args"), 100) : undefined };
  return { kind: "prompt", text: `Prompt: “${clip(cleanTitle(p), 120)}”` };
}

/** One raw event from the log as a timeline row, or null for types other rows already cover. */
function fromEvent(e: RawEvent): Ev | null {
  const d = e.data ?? {};
  const sess = e.session ? href(`session/${enc(`${e.agent ?? "claude"}:${e.session}`)}`) : undefined;
  switch (e.type) {
    case "prompt.submit": return { ts: e.ts, ...promptLine(d.prompt), href: sess };
    case "turn.stop": return { ts: e.ts, kind: "turn", text: "Agent finished a turn", detail: d.last ? clip(d.last, 160) : undefined, href: sess };
    case "turn.stop_failure": return { ts: e.ts, kind: "failure", text: "A turn failed", detail: clip(d.error, 160), href: sess };
    case "permission.request": return { ts: e.ts, kind: "permission", text: `Asked for permission: ${d.tool ?? "a tool"}`, detail: clip(typeof d.input === "string" ? d.input : JSON.stringify(d.input ?? ""), 120), href: sess };
    case "notification": return d.kind === "idle_prompt" ? null : { ts: e.ts, kind: "notification", text: clip(d.message || "Notification", 120), href: sess };
    case "session.end": return { ts: e.ts, kind: "session", text: "Session ended", href: sess };
    case "guard.request": return { ts: e.ts, kind: "guard", text: `Held for approval: ${d.title ?? d.rule ?? "gated action"}`, detail: clip(d.summary, 120) };
    case "guard.decision": return { ts: e.ts, kind: "guard", text: `Gated action ${d.decision === "allow" ? "allowed" : d.decision === "deny" ? "denied" : d.decision ?? "decided"}`, detail: d.reason ? clip(d.reason, 100) : undefined };
    case "agent.status": return d.status === "blocked" ? { ts: e.ts, kind: "blocked", text: "Stopped at a prompt in its terminal" } : null;
    case "tool.pre": return { ts: e.ts, kind: "tools", text: "", tools: { [String(d.tool ?? "tool").replace(/^mcp__[^_]+__/, "")]: 1 }, count: 1, href: sess };
    default: return null;
  }
}

const BOUNDARY = new Set(["prompt", "task", "turn", "failure", "session", "permission"]);
/**
 * Fold the tool calls of one session between two conversation boundaries (a
 * prompt, a finished turn, a permission request) into one row, and adjacent
 * repeats of the same row into a count. Input and output are newest first.
 */
function fold(list: Ev[]): Ev[] {
  const bounds = list.filter((e) => BOUNDARY.has(e.kind)).map((e) => e.ts); // newest first
  const groups = new Map<string, Ev>();
  const rest: Ev[] = [];
  for (const e of list) {
    if (e.kind !== "tools") { rest.push(e); continue; }
    const seg = bounds.findIndex((b) => b <= e.ts); // the nearest boundary at or before this call
    const key = `${e.href ?? ""}|${seg}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...e, tools: { ...e.tools } }); continue; }
    g.count = (g.count ?? 1) + 1;
    if (e.ts > g.ts) g.ts = e.ts;
    for (const [k, v] of Object.entries(e.tools ?? {})) g.tools![k] = (g.tools![k] ?? 0) + v;
  }
  for (const g of groups.values()) {
    g.text = plural(g.count ?? 1, "tool call");
    g.detail = Object.entries(g.tools ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(", ");
  }
  const out: Ev[] = [];
  for (const e of [...rest, ...groups.values()].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const last = out[out.length - 1];
    if (last && e.kind !== "tools" && last.kind === e.kind && last.text === e.text && last.detail === e.detail) { last.count = (last.count ?? 1) + 1; continue; }
    out.push(e);
  }
  return out;
}

export function TimelinePanel({ mission: m }: P) {
  const { data: sessions } = useApi<SessionView[]>(`/api/sessions?mission=${enc(m.id)}&limit=200`, ["sessions", "missions"]);
  const { data: attention } = useApi<AttentionItem[]>(`/api/attention?mission=${enc(m.id)}&limit=200`, ["attention"]);
  const { data: evidence } = useApi<EvidenceItem[]>(`/api/evidence?mission=${enc(m.id)}&limit=100`, ["evidence"]);
  const { data: verdicts } = useApi<VerdictRec[]>(`/api/evidence/verdicts?mission=${enc(m.id)}&limit=20`, ["verdicts"]);
  const { data: intents } = useApi<any[]>("/api/intents?limit=200", ["intents"]);
  const { data: workers } = useApi<WorkerView[]>("/api/workers", ["workers"]);
  // The raw event log for the mission's sessions: the latest 200, plus prompts from further back.
  const { data: raw } = useApi<RawEvent[]>(`/api/events?mission=${enc(m.id)}&limit=200`, ["sessions", "attention", "guard"], { pollMs: 60_000 });
  const { data: prompts } = useApi<RawEvent[]>(`/api/events?mission=${enc(m.id)}&type=prompt.submit&limit=50`, ["sessions"], { pollMs: 60_000 });
  const { data: notes } = useNotes({ kind: "mission", id: m.id });
  const [all, setAll] = useState(false);
  const events = useMemo(() => {
    const out: Ev[] = [{ ts: m.created, kind: "mission", text: "Idea created" }];
    const keys = new Set(m.sessions.map(refKey));
    for (const s of sessions ?? []) {
      out.push({ ts: s.started, kind: "session", text: `Session started: ${cleanTitle(s.title, s.key)}`, href: href(`session/${enc(s.key)}`) });
      if (s.updated !== s.started && !raw?.length) out.push({ ts: s.updated, kind: "activity", text: `Last activity in ${cleanTitle(s.title, s.key)}`, detail: plural(s.turns, "turn"), href: href(`session/${enc(s.key)}`) });
    }
    for (const a of attention ?? []) {
      out.push({ ts: a.opened, kind: "attention", level: a.level, hot: !a.resolved && (a.level === "L3" || a.level === "L4"), text: a.title, detail: a.why });
      if (a.resolved) out.push({ ts: a.resolved, kind: "resolved", text: `Resolved: ${a.title}`, detail: a.resolution ?? undefined });
    }
    for (const n of noteTimelineEntries(notes)) out.push({ ts: n.ts, kind: n.kind, text: n.text, detail: n.detail });
    for (const e of evidence ?? []) out.push({ ts: e.created, kind: "evidence", text: `Evidence: ${e.name}`, detail: e.exit_code === 0 ? "passed" : e.exit_code == null ? e.mode : `exit ${e.exit_code}` });
    for (const v of verdicts ?? []) out.push({ ts: v.created, kind: "verdict", text: `Verdict: ${v.verdict === "insufficient" ? "not enough evidence" : v.verdict}` });
    const mineWorkers = new Set((workers ?? []).filter((w) => w.mission === m.id || (w.session && keys.has(w.session))).map((w) => w.id));
    for (const it of intents ?? []) {
      if (it.target === m.id || mineWorkers.has(it.target) || keys.has(it.target)) {
        const pics: string[] = Array.isArray(it.payload?.images) ? it.payload.images : [];
        const text = it.kind === "reply" ? (it.payload?.text ? `You replied: “${clip(it.payload?.text, 120)}”` : `You sent ${plural(pics.length, "image")}`)
          : it.kind === "answer_prompt" ? `You answered its prompt: ${it.result?.picked ? `“${clip(it.result.picked, 60)}”` : `keys ${(it.payload?.keys ?? []).join(" ")}`}`
          : `Intent ${it.kind.replace(/_/g, " ")}`;
        out.push({ ts: it.created, kind: "intent", text, detail: it.status === "failed" ? `failed: ${it.error}` : it.status === "acked" ? "picked up" : it.status, ...(pics.length ? { images: pics } : {}) });
      }
    }
    const seen = new Set<string>();
    for (const e of [...(raw ?? []), ...(prompts ?? [])]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      const ev = fromEvent(e);
      if (ev) out.push(ev);
    }
    return fold(out.filter((e) => e.ts).sort((a, b) => b.ts.localeCompare(a.ts)));
  }, [m, sessions, attention, evidence, verdicts, intents, workers, raw, prompts, notes]);
  const shown = all ? events : events.slice(0, 16);
  return (
    <div className="panel-body">
      {raw ? <p className="panel-meta">Prompts, turns, tool calls, approvals and evidence from {plural(m.sessions.length, "linked session")}, newest first.</p> : null}
      <ol className="timeline">
        {shown.map((e, i) => (
          <li key={i} className={`tl k-${e.kind}${e.hot ? " hot" : ""}`} data-kind={e.kind}>
            <span className="tl-time"><TimeAgo iso={e.ts} /></span>
            <span className="tl-dot" aria-hidden />
            <span className="tl-text">
              {e.level ? <LevelBadge level={e.level} quiet={!e.hot} /> : null}
              {e.href ? <a href={e.href}>{e.text}</a> : <span>{e.text}</span>}
              {e.count && e.count > 1 && e.kind !== "tools" ? <span className="tl-count">{e.count} times</span> : null}
              {e.detail ? <span className="tl-detail" title={e.detail}>{e.detail}</span> : null}
              {e.images ? <SentImages paths={e.images} className="small" /> : null}
            </span>
          </li>
        ))}
      </ol>
      {events.length > shown.length ? <button type="button" className="btn link" onClick={() => setAll(true)}>Show all {events.length} entries</button> : null}
    </div>
  );
}

// ---------- dependencies ----------
export function DependenciesPanel({ mission: m }: P) {
  const { data: missions } = useApi<MissionH[]>("/api/missions", ["missions"]);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const byId = new Map((missions ?? []).map((x) => [x.id, x]));
  const blockedBy = (missions ?? []).filter((x) => x.blocks.includes(m.id));
  const save = async (blocks: string[]) => {
    setErr(null);
    try { await api(`/api/missions/${enc(m.id)}`, { method: "PUT", json: { blocks } }); }
    catch (e: any) { setErr(`The dependency was not saved: ${e.message}`); }
  };
  const candidates = (missions ?? []).filter((x) => x.id !== m.id && !m.blocks.includes(x.id) && !x.archive);
  const Row = ({ id }: { id: string }) => {
    const x = byId.get(id);
    return <a href={href(`mission/${enc(id)}`)}>{x?.title ?? id}</a>;
  };
  return (
    <div className="panel-body deps">
      <div className="deps-col">
        <h3>Waiting on</h3>
        {blockedBy.length ? <ul>{blockedBy.map((x) => <li key={x.id}><Row id={x.id} /> <StateChip state={x.state} /></li>)}</ul> : <p className="meta">Nothing blocks this idea.</p>}
      </div>
      <div className="deps-col">
        <h3>Blocks</h3>
        {m.blocks.length ? (
          <ul>{m.blocks.map((id) => <li key={id}><Row id={id} /> <button type="button" className="btn ghost small" onClick={() => save(m.blocks.filter((b) => b !== id))} aria-label={`Stop blocking ${byId.get(id)?.title ?? id}`}>Remove</button></li>)}</ul>
        ) : <p className="meta">This idea doesn't hold up any other.</p>}
        {candidates.length ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (pick) { save([...m.blocks, pick]); setPick(""); } }}>
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Idea this one blocks">
              <option value="">Choose an idea this one blocks</option>
              {candidates.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            <button className="btn" type="submit" disabled={!pick}>Add</button>
          </form>
        ) : null}
        {err ? <p className="inline-error" role="alert">{err}</p> : null}
      </div>
    </div>
  );
}
