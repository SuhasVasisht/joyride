// Start a new Claude Code or Codex session in a Herdr pane, optionally for a mission, on any
// configured account (usage.accounts); the default login unless you pick another.
import { useDraft } from "../../lib/useDraft";
import { useEffect, useMemo, useState } from "react";
import { api, post, useApi } from "../../lib/api";
import { go, type Route } from "../../lib/router";
import { workerIdFor } from "../../components/HerdrActions";
import type { UsageAccountInfo } from "../../../shared/usage";

function briefFor(m: any) {
  const crit = (m.done_when ?? []).map((c: any) => `- ${c.text}`).join("\n");
  return [`Idea: ${m.title}`, m.goal ? `\n${m.goal}` : "", crit ? `\nDone when:\n${crit}` : "",
    "\nWhen you verify something (tests, builds, screenshots), wrap the command with the joyride-evidence skill so it is recorded for this idea",
    `(\`joyride-evidence run --mission ${m.id} --name "<what>" -- <command>\`). Start by reading the code and telling me your plan.`].join("\n");
}

export function StartSessionRoute({ route }: { route: Route }) {
  const missionId = route.query.get("mission");
  const { data: mission } = useApi<any>(missionId ? `/api/missions/${encodeURIComponent(missionId)}` : null, ["missions"]);
  const { data: sessions } = useApi<any[]>("/api/sessions?limit=400", ["sessions"]);
  const folders = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of sessions ?? []) { const f = s.repo ?? s.cwd; if (f && !f.includes("/.joyride/")) count.set(f, (count.get(f) ?? 0) + 1); }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  }, [sessions]);
  const [cwd, setCwd] = useState(route.query.get("cwd") ?? "");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const { data: allAccounts } = useApi<UsageAccountInfo[]>("/api/usage/accounts", ["usage"]);
  const accounts = (allAccounts ?? []).filter((a) => a.provider === agent);
  // "" is the default login; a configured account with its own folder is picked by id.
  const [account, setAccount] = useState("");
  useEffect(() => setAccount(""), [agent]);
  const picked = accounts.find((a) => a.id === account && a.home);
  const draft = useDraft({ kind: "composer", id: missionId ? `start:idea:${missionId}` : `start:folder:${JSON.stringify(route.query.get("cwd"))}` });
  const { text: prompt, setText: setPrompt } = draft;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (mission && !cwd && mission.repos?.[0]) setCwd(mission.repos[0]); if (mission && !prompt) setPrompt(briefFor(mission)); }, [mission]);
  useEffect(() => { if (!cwd && folders[0] && !missionId) setCwd(folders[0]); }, [folders]);

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const label = (mission?.title ?? cwd.split("/").filter(Boolean).pop() ?? "session").slice(0, 40);
      const r = await post<any>("/api/intents", { kind: "launch_session", target: cwd, payload: { cwd, agent, prompt: prompt.trim() || undefined, label, account: picked?.id } });
      if (r.status === "failed") throw new Error(r.error ?? "Herdr could not start the session.");
      const w = workerIdFor(r);
      if (missionId) {
        // Link the new session to the mission as soon as its first hook reports it.
        const until = Date.now() + 30000;
        const link = async () => {
          const ws: any[] = await api("/api/workers");
          const me = ws.find((x) => x.id === w);
          if (me?.session) { await post(`/api/missions/${encodeURIComponent(missionId)}/sessions`, { refs: [{ source: me.agent, id: me.session.replace(/^(claude|codex):/, "") }] }).catch(() => {}); return; }
          if (Date.now() < until) setTimeout(link, 1500);
        };
        link();
      }
      draft.clear();
      go(w ? `worker/${encodeURIComponent(w)}` : "map");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <article className="pane-page start-session">
      <header className="mp-header">
        <p className="mp-crumbs"><a href="#/map">Map</a><span aria-hidden>/</span>{mission ? <><a href={`#/mission/${encodeURIComponent(mission.id)}`}>{mission.title}</a><span aria-hidden>/</span></> : null}<span>New session</span></p>
        <h1 className="mp-title">Start a session</h1>
        <p className="panel-meta">Opens a new {agent === "codex" ? "Codex" : "Claude Code"} session in a Herdr pane. Joyride can then show its state, reply to it and answer its prompts; open it in Herdr whenever you want to type yourself.</p>
      </header>
      <form className="ss-form" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <label className="ss-field"><span>Folder</span>
          <input className="input mono" list="ss-folders" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" required />
          <datalist id="ss-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
        </label>
        <fieldset className="ss-field ss-agent"><legend>Agent</legend>
          <label><input type="radio" name="agent" checked={agent === "claude"} onChange={() => setAgent("claude")} /> Claude Code</label>
          <label><input type="radio" name="agent" checked={agent === "codex"} onChange={() => setAgent("codex")} /> Codex</label>
        </fieldset>
        {accounts.some((a) => a.home) ? (
          <label className="ss-field"><span>Account</span>
            <select className="input" value={picked?.id ?? ""} onChange={(e) => setAccount(e.target.value)}>
              {accounts.some((a) => !a.home) ? null : <option value="">Default login</option>}
              {accounts.map((a) => <option key={a.id} value={a.home ? a.id : ""}>{a.home ? `${a.label} (${a.home})` : `${a.label} (default login)`}</option>)}
            </select>
          </label>
        ) : null}
        <label className="ss-field"><span>First message <span className="meta">(optional)</span></span>
          <textarea ref={draft.boxRef} className="input" rows={9} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should it work on?" />
        </label>
        {err ? <p className="ha-note err" role="alert">{err}</p> : null}
        <div className="row"><button className="btn primary" disabled={busy || !cwd.trim()}>{busy ? "Starting…" : "Start in Herdr"}</button><a className="btn ghost" href={mission ? `#/mission/${encodeURIComponent(mission.id)}` : "#/map"}>Cancel</a></div>
      </form>
    </article>
  );
}
