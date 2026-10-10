import { lazy, Suspense, useState } from "react";
import type { Route } from "../../lib/router";
import { go } from "../../lib/router";
import { api, post, useApi } from "../../lib/api";
import { ServerDefinition, type ServerGroupView, type ServerMemberView } from "../../../shared/servers";
import "./servers.css";

const enc = encodeURIComponent;
const TerminalView = lazy(() => import("../../components/TerminalView"));
const err = (e: unknown) => e instanceof Error ? e.message : String(e);
export function definitionOf(g: ServerGroupView): ServerDefinition {
  const { instances: _instances, state: _state, pending: _pending, ...definition } = g;
  return definition;
}

function ServerUrl({ configured, active, label, primary = false }: { configured?: string; active?: string; label: string; primary?: boolean }) {
  if (!configured && !active) return null;
  return <span className="server-url-control">
    {active ? <a className={`btn small${primary ? " primary" : ""}`} href={active} target="_blank" rel="noreferrer">{label}</a>
      : <button className={`btn small${primary ? " primary" : ""}`} disabled>{label}</button>}
    <span className="server-url mono">Configured URL: <code>{configured ?? active}</code>{!active ? <span> · Not ready to open</span> : null}</span>
  </span>;
}

export function ServerCard({ group: g, compact = false }: { group: ServerGroupView; compact?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const launchUrl = g.instances[0]?.run?.url;
  const reviewUrl = g.state === "running" && g.instances.every((m) => m.run?.url === launchUrl) ? launchUrl : undefined;
  const action = async (action: "start" | "stop" | "restart" | "update", member?: string) => {
    setBusy(true); setError(null);
    try { await post(`/api/servers/${enc(g.id)}/action`, { action, purpose: g.purpose, ...(member ? { member } : {}), request: crypto.randomUUID() }); }
    catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  };
  const canvas = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/api/servers/${enc(g.id)}`, { method: "PUT", json: { ...definitionOf(g), canvas: true } });
      go(`map?focus=${enc(`server:${g.id}`)}`);
    } catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  };
  return <article className={`server-card${compact ? " compact" : ""}`} data-server={g.id} onPointerDown={(e) => e.stopPropagation()}>
    <header><div><span className="server-kicker">{g.purpose === "review" ? "For your review" : "Private test"} · {g.project}</span>
      <h2><a href={`#/servers/${enc(g.id)}`}>{g.name}</a></h2></div><span className={`server-state s-${g.state}`}>{g.state}</span></header>
    <p className="server-change">{g.change}{g.branch ? <span className="mono"> · {g.branch}</span> : null}</p>
    {g.pending ? <p className="server-pending">Change saved. Update to show it in the running instances.</p> : null}
    <div className="server-members">{g.instances.map((m) => <div className="server-member" key={m.id} data-server-member={m.id}>
      <div className="server-member-head"><strong>{m.name}</strong><span className={`server-state s-${m.state}`}>{m.state}</span></div>
      {m.run && m.state !== "stopped" ? <p>Showing: {m.run.change}{m.run.branch ? ` · ${m.run.branch}` : ""}</p> : null}
      {!compact ? <><code>{m.command}</code><p className="mono server-cwd">{m.cwd}</p>{m.ports.length ? <p>Ports {m.ports.join(", ")}</p> : null}</> : null}
      {m.reason ? <p className="server-reason">{m.reason}</p> : null}
      <div className="server-controls">
        <a className="btn small" href={`#/servers/${enc(g.id)}?member=${enc(m.id)}`}>Terminal &amp; logs</a>
        {!compact ? <><button className="btn small" disabled={busy} onClick={() => void action("start", m.id)}>Start {m.name}</button>
          <button className="btn small" disabled={busy} onClick={() => void action("stop", m.id)}>Stop {m.name}</button>
          <button className="btn small" disabled={busy} onClick={() => void action("restart", m.id)}>Restart {m.name}</button></> : null}
        <ServerUrl configured={m.url} active={m.state === "running" ? m.run?.member.url : undefined} label={`Open ${m.name}`} />
      </div>
    </div>)}</div>
    <footer className="server-controls">
      <button className="btn small" disabled={busy} onClick={() => void action("start")}>Start group</button>
      <button className="btn small" disabled={busy} onClick={() => void action("stop")}>Stop group</button>
      <button className="btn small" disabled={busy} onClick={() => void action("restart")}>Restart group</button>
      {g.pending ? <button className="btn small" disabled={busy} onClick={() => void action("update")}>Update group</button> : null}
      <ServerUrl configured={g.url} active={reviewUrl} label="Open review" primary />
      {!compact ? <button className="btn small" disabled={busy} onClick={() => void canvas()}>{g.canvas ? "Show on canvas" : "Add to canvas"}</button> : null}
    </footer>
    {busy ? <p role="status">Applying server controls…</p> : null}
    {error ? <p className="server-error" role="alert">{error}</p> : null}
  </article>;
}

function MemberTerminal({ group, member }: { group: ServerGroupView; member: ServerMemberView }) {
  const url = `/api/servers/${enc(group.id)}/members/${enc(member.id)}`;
  const logs = useApi<{ text: string }>(url + "/logs", ["servers"], { pollMs: 2000 });
  return <section className="server-terminal" aria-label={`${member.name} terminal`}>
    <h2>{member.name} <span className={`server-state s-${member.state}`}>{member.state}</span></h2>
    {member.run?.pane && member.state !== "stopped" && member.state !== "failed" ? <Suspense fallback={<p aria-busy="true">Opening the terminal…</p>}><TerminalView worker={`server:${group.id}:${member.id}`} pane={member.run.pane} name={member.name} controllable={false}
      terminalUrl={url + "/terminal"} readOnlyHint="Live server output. Use the member or group controls to start, stop or restart." /></Suspense> : null}
    <details open={member.state === "failed" || member.state === "stopped"}><summary>Saved output</summary><pre>{logs.error ?? logs.data?.text ?? "Reading output…"}</pre></details>
  </section>;
}

function ServerEditor({ existing, onClose }: { existing?: ServerGroupView; onClose: () => void }) {
  const [g, setG] = useState<ServerDefinition>(() => existing ? definitionOf(existing) : {
    id: "", name: "", purpose: "review", project: "", change: "", branch: "", creator: "", canvas: true,
    members: [{ id: "frontend", name: "Frontend", cwd: "", command: "", ports: [] }],
  });
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [portText, setPortText] = useState(() => g.members.map((m) => m.ports.join(",")));
  const field = (key: "name" | "project" | "change" | "branch" | "url", label: string) => <label>{label}<input value={g[key] ?? ""} required={["name", "project", "change"].includes(key)} onChange={(e) => {
    const value = e.target.value;
    setG({ ...g, [key]: value || (key === "url" ? undefined : ""), ...(!existing && key === "name" ? { id: value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) } : {}) });
  }} /></label>;
  return <form className="server-editor" aria-label={existing ? "Edit server group" : "New server group"} onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const parsed = ServerDefinition.parse(g); await api(existing ? `/api/servers/${enc(g.id)}` : "/api/servers", { method: existing ? "PUT" : "POST", json: parsed }); onClose(); }
    catch (e) { setError(err(e)); } finally { setBusy(false); }
  }}>
    <h2>{existing ? "Edit server group" : "New server group"}</h2>
    <div className="server-fields">{field("name", "Group name")}{field("project", "Project")}{field("change", "Change to review")}{field("branch", "Branch")}{field("url", "Review URL")}
      <label>Purpose<select value={g.purpose} disabled={!!existing} onChange={(e) => setG({ ...g, purpose: e.target.value === "test" ? "test" : "review" })}><option value="review">For your review</option><option value="test">Private test</option></select></label>
    </div>
    {g.members.map((m, i) => <fieldset key={i}><legend>{m.name || `Member ${i + 1}`}</legend>
      <div className="server-fields">{(["id", "name", "cwd", "command", "url"] satisfies (keyof typeof m)[]).map((key) => <label key={key}>{({ id: "Member id", name: "Terminal name", cwd: "Working directory", command: "Foreground command", url: "Member URL", ports: "Ports" })[key]}
        <input value={m[key] ?? ""} required={key !== "url"} onChange={(e) => setG({ ...g, members: g.members.map((x, at) => at === i ? { ...x, [key]: e.target.value || (key === "url" ? undefined : "") } : x) })} /></label>)}
        <label>Ports (comma separated)<input value={portText[i] ?? ""} onChange={(e) => {
          const value = e.target.value;
          setPortText(portText.map((x, at) => at === i ? value : x));
          setG({ ...g, members: g.members.map((x, at) => at === i ? { ...x, ports: value ? value.split(",").map(Number) : [] } : x) });
        }} /></label>
      </div>
      {g.members.length > 1 ? <button type="button" className="btn small" onClick={() => { setPortText(portText.filter((_, at) => at !== i)); setG({ ...g, members: g.members.filter((_, at) => at !== i) }); }}>Remove member</button> : null}
    </fieldset>)}
    <div className="server-controls"><button type="button" className="btn" onClick={() => { setPortText([...portText, ""]); setG({ ...g, members: [...g.members, { id: `member-${g.members.length + 1}`, name: "Backend", cwd: g.members[0]?.cwd ?? "", command: "", ports: [] }] }); }}>Add terminal</button>
      <button className="btn primary" disabled={busy}>Save group</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
    {existing ? <p>Save preserves the running instances. Use Update group to apply the saved change.</p> : <p>Review groups stay available after the creating agent ends. Add foreground commands, then start the group.</p>}
    {error ? <p role="alert" className="server-error">{error}</p> : null}
  </form>;
}

export function ServersPage({ route }: { route: Route }) {
  const groups = useApi<ServerGroupView[]>("/api/servers", ["servers"], { pollMs: 2000 });
  const [editing, setEditing] = useState(false), [tests, setTests] = useState(false);
  const selected = groups.data?.find((g) => g.id === route.params[0]);
  const memberId = route.query.get("member");
  return <main className="servers-page">
    <header className="servers-heading"><div><p className="server-kicker">Shared review workspace</p><h1>Servers</h1><p>Named terminal groups for the changes you want to try.</p></div>
      <button className="btn primary" onClick={() => setEditing(true)}>{selected ? "Edit group" : "New server group"}</button></header>
    {groups.error ? <p className="server-error" role="alert">{groups.error}</p> : null}
    {editing ? <ServerEditor existing={selected} onClose={() => { setEditing(false); groups.reload(); }} /> : null}
    {selected ? <><a href="#/servers">All server groups</a><ServerCard group={selected} />
      <div className="server-terminals">{selected.instances.filter((m) => !memberId || m.id === memberId).map((m) => <MemberTerminal key={`${m.id}:${m.run?.nonce}`} group={selected} member={m} />)}</div></> : <>
      <label className="toggle"><input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} /> Show private test groups</label>
      <div className="servers-grid">{(groups.data ?? []).filter((g) => tests || g.purpose === "review").map((g) => <ServerCard key={g.id} group={g} />)}</div>
      {!groups.loading && !groups.error && !(groups.data ?? []).some((g) => tests || g.purpose === "review") ? <div className="servers-empty"><h2>No review servers yet</h2><p>Create a group with a terminal for each part of your app. Agents can also create and update groups with <code>joyride servers</code>.</p><p>The agent guide is <code>docs/review-servers.md</code>.</p></div> : null}
    </>}
  </main>;
}
