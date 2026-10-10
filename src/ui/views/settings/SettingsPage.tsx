import { NewModels } from "./NewModels";
import type { SleepPreventionState, Config as RuntimeConfig } from "../../../shared/schema.ts";
// Settings: the daemon, models (Jev and the heavy LLM per task), notifications,
// the guard policy and remembered rules, installed components, and the metrics
// Joyride is judged by. Edits go through PUT /api/system/config, which commits
// joyride.config.yaml.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, post, useApi } from "../../lib/api";
import type { Route } from "../../lib/router";
import type { GuardRequest } from "../../lib/types";
import { EmptyState, StateChip, TimeAgo, duration, plural, shortPath } from "../../components/primitives";
import { LLM_TASKS as TASKS } from "../../../shared/llm-tasks";
import type { UsageAccountInfo } from "../../../shared/usage";
import type { FirstmateFile } from "../../../modules/system/firstmate-files";
import "./settings.css";

type Backend = { backend: string; model: string; effort?: string; account?: string };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
type Config = {
  daemon: RuntimeConfig["daemon"]; new_models: RuntimeConfig["new_models"]; port: number; llm: { default: Backend; tasks: Record<string, Backend> }; jev: { model: string; base_url: string }; notifications: { macos: boolean; min_level: string } };
type Status = {
  daemon: { pid: number; uptime_s: number; root: string; port: number; node: string; preview: boolean; sleep_prevention: SleepPreventionState };
  models: { jev: { available: boolean; calls: number; input_tokens: number; ms: number; errors: number }; llm: { calls: number; ms: number; errors: number; cost_usd: number } };
  components: { name: string; describe: string; status: string }[];
  global_changes: string[];
};
type Latency = { count: number; p50_ms: number | null; p90_ms: number | null };
type Metrics = {
  blocked_to_unblocked: Record<"1d" | "7d", Latency>;
  open: Record<string, number>;
  snoozed: number;
  checking: { focus_switches: number; while_nothing_pending: number; per_hour: { hour: string; focus: number; checking: number }[] };
  notifications?: { sent_24h: number; deduped_24h: number };
};
type PolicyRule = { id: string; title: string; tools: string[]; match: string[]; level?: string };
type Policy = { yaml: string; compiled: { timeout_seconds: number; rules: PolicyRule[]; auto_approve?: unknown[] } };
type AllowRule = { id: string; rule: string; scope_type: "session" | "mission" | "global"; scope_value: string; expires: string | null; created: string };

const LEVELS: [string, string][] = [["L4", "Only urgent: gated actions and runaway spend"], ["L3", "Blocked on you and up"], ["L2", "Reviews and up"], ["L1", "Everything but ambient changes"]];
const SECTIONS: [string, string][] = [["daemon", "Daemon"], ["models", "Models"], ["notifications", "Notifications"], ["guard", "Guard"], ["guidance", "Captain guidance"], ["firstmate-files", "Firstmate preferences"], ["components", "Installed components"], ["metrics", "Metrics"]];

/** Sentence case, except titles that start with a command name (ssh, scp, curl…), which stay as typed. */
const sentence = (s: string) => (!s || /^(ssh|scp|sftp|rsync|curl|wget|gh|npm|pnpm|kubectl|gcloud|aws)\b/.test(s) ? s : s[0].toUpperCase() + s.slice(1));
const pct = (x: number | null | undefined) => (x == null ? "–" : `${Math.round(x * 100)}%`);

function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="st-section" aria-labelledby={`st-h-${id}`} data-settings={id}>
      <h2 id={`st-h-${id}`}>{title}</h2>
      {lede ? <p className="st-lede">{lede}</p> : null}
      {children}
    </section>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="st-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export function SettingsPage(_: { route: Route }) {
  const status = useApi<Status>("/api/system/status", ["system"], { pollMs: 30_000 });
  const config = useApi<{ config: Config; yaml: string; unknown_llm_tasks?: string[] }>("/api/system/config", ["system"]);
  const [active, setActive] = useState("daemon");
  // The index follows the section whose heading last passed the top of the scroll area.
  useEffect(() => {
    const root = document.querySelector(".main");
    if (!root) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 120;
      let cur = "daemon";
      document.querySelectorAll<HTMLElement>(".st-section").forEach((el) => { if (el.getBoundingClientRect().top <= top) cur = el.dataset.settings ?? cur; });
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = "metrics";
      setActive(cur);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => root.removeEventListener("scroll", onScroll);
  }, [status.data != null, config.data != null]);

  return (
    <div className="st-page" data-testid="settings-page">
      <header className="st-head">
        <h1>Settings</h1>
        <p className="st-lede">How this Joyride runs: its models, when it interrupts you, what the guard holds, and what it installed on this machine. Changes are commits to <code>joyride.config.yaml</code>. To check or install what Joyride and Firstmate need on this Mac, open <a href="#/setup">Set up Joyride</a>.</p>
      </header>
      <div className="st-layout">
        <nav className="st-toc" aria-label="Settings sections">
          {SECTIONS.map(([id, title]) => (
            <a key={id} href={`#/settings`} className={active === id ? "on" : ""} aria-current={active === id ? "true" : undefined}
              onClick={(e) => { e.preventDefault(); document.getElementById(`settings-${id}`)?.scrollIntoView({ block: "start" }); setActive(id); }}>{title}</a>
          ))}
        </nav>
        <div className="st-body">
          {status.error && !status.data ? <p className="inline-error" role="alert">Settings can't load: {status.error}. Start the daemon with <code>./bin/joyride up</code>, then reload.</p> : null}
          <DaemonSection s={status.data} cfg={config.data?.config} confirm={async () => {
            // Read both fresh (not a shared in-flight GET) so the pill settles on what the daemon applied.
            const [c, st] = await Promise.all([api<{ config: Config; yaml: string; unknown_llm_tasks?: string[] }>("/api/system/config"), api<Status>("/api/system/status")]);
            config.setData(c); status.setData(st);
          }} />
          <ModelsSection s={status.data} cfg={config.data} reload={config.reload} />
          <NotificationsSection cfg={config.data?.config} reload={config.reload} />
          <GuardSection />
          <GuidanceSection />
          <FirstmateFilesSection />
          <ComponentsSection s={status.data} />
          <MetricsSection />
        </div>
      </div>
    </div>
  );
}

function FirstmateFilesSection() {
  const files = useApi<FirstmateFile[]>("/api/system/firstmate-files", ["system"], { pollMs: 30_000 });
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  async function open(file: FirstmateFile) {
    setOpening(file.file); setMessage(null);
    try { await post(`/api/system/firstmate-files/${encodeURIComponent(file.file)}/open`); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Could not open the file. Open its path in your editor."); }
    finally { setOpening(null); }
  }
  return <Section id="firstmate-files" title="Firstmate preferences" lede="Firstmate owns these files. This view is read-only. Use Open file to edit in your editor, or ask Firstmate to /stow a preference.">
    {files.error ? <p className="inline-error" role="alert">Could not load Firstmate's files: {files.error}. Reload Settings to try again.</p> : !files.data ? <p className="meta">Loading…</p> :
      <div data-testid="firstmate-files">{files.data.map((file) => <article key={file.file} className="st-firstmate-file" data-file={file.file}>
        <div className="row"><h3>{file.file}</h3><button className="btn" disabled={file.state !== "ready" || opening !== null} onClick={() => open(file)}>{opening === file.file ? "Opening…" : "Open file"}</button></div>
        <p><code>{file.path}</code></p>
        {file.state === "ready" ? <pre className="st-yaml" aria-label={file.file}>{file.text || "This file is empty."}</pre> : file.state === "absent" ? <p className="meta">Not created yet. Firstmate creates this file when needed.</p> : <p className="inline-error" role="alert">{file.error}</p>}
      </article>)}</div>}
    {message ? <p className="inline-error" role="alert">{message}</p> : null}
  </Section>;
}

function GuidanceSection() {
  const guidance = useApi<{ path: string; state: "ready" | "absent"; text: string }>("/api/system/guidance", ["system"], { pollMs: 30_000 });
  return <Section id="guidance" title="Captain guidance" lede="Shared preferences loaded by Claude and Codex through their global instruction files. Edit the file in the repo and commit the change.">
    {guidance.error ? <p className="inline-error" role="alert">{guidance.error}</p> : !guidance.data ? <p className="meta">Loading…</p> : guidance.data.state === "absent" ?
      <EmptyState title="Guidance is not installed"><p>Run <code>./bin/joyride install guidance</code> from the permanent checkout to seed the file and link it into Claude and Codex.</p></EmptyState> :
      <><p><code>{guidance.data.path}</code></p><pre className="st-yaml" aria-label="Captain guidance">{guidance.data.text}</pre></>}
  </Section>;
}

function DaemonSection({ s, cfg, confirm }: { s: Status | null; cfg: Config | undefined; confirm: () => Promise<void> }) {
  // `want` is the requested value while the daemon saves and applies it; the pill
  // keeps showing the confirmed value until the fresh status comes back.
  const [want, setWant] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = s?.daemon;
  const on = cfg?.daemon.prevent_sleep ?? false;
  const sp = d?.sleep_prevention;
  const failed = on && sp?.state === "error";
  const unavailable = !cfg || !d || d.preview || (sp?.state === "unsupported" && !on);
  async function toggle() {
    if (!cfg || unavailable || want !== null) return;
    const next = !on;
    setWant(next); setError(null);
    try {
      await api("/api/system/config", { method: "PUT", json: { daemon: { ...cfg.daemon, prevent_sleep: next } } });
      await confirm();
    } catch (e) {
      setError(`Could not turn sleep prevention ${next ? "on" : "off"}: ${e instanceof Error ? e.message : String(e)}. It is still ${on ? "on" : "off"}.`);
      await confirm().catch(() => {});
    } finally { setWant(null); }
  }
  const label = want === true ? "Turning on…" : want === false ? "Turning off…" : failed ? "Not applied" : on ? "On" : "Off";
  return (
    <Section id="daemon" title="Daemon" lede="The local process that reads your agents' history, holds gated actions and serves this page.">
      {d ? (
        <Facts items={[
          ["Instance", d.preview ? "Preview instance (read-only)" : "Main daemon"],
          ["Address", <span className="mono">127.0.0.1:{d.port}</span>],
          ["Process", <span className="mono">{d.pid}</span>],
          ["Up for", duration(d.uptime_s * 1000)],
          ["Node", <span className="mono">{d.node}</span>],
          ["Data", <span className="mono" title={d.root}>{shortPath(d.root, 3)}</span>],
        ]} />
      ) : <p className="meta" aria-busy="true">Asking the daemon…</p>}
      <div className="row st-sleep">
        <span id="st-sleep-label">Prevent automatic system sleep while the daemon runs</span>
        <button type="button" className="st-pill" role="switch" aria-labelledby="st-sleep-label" aria-describedby="st-sleep-status"
          aria-checked={on} aria-busy={want !== null} aria-disabled={want !== null || undefined} disabled={unavailable}
          data-on={on} data-pending={want !== null ? (want ? "on" : "off") : undefined} data-failed={failed || undefined} onClick={toggle}>
          <span className="st-pill-knob" aria-hidden="true" />
          <span className="st-pill-text">{label}</span>
        </button>
      </div>
      <p className="meta">The display can sleep and lock. Closing the lid or choosing Sleep can still put the Mac to sleep.</p>
      <p role="status" id="st-sleep-status">{want !== null ? `Saving and ${want ? "asking macOS to prevent sleep" : "releasing the macOS sleep assertion"}…` : !sp ? "Checking sleep prevention…" : sp.state === "active" ? "Active: macOS is preventing automatic system sleep." : sp.state === "unsupported" ? "Sleep prevention is only supported on macOS." : sp.state === "error" ? `Saved as on, but ${sp.error[0].toLowerCase()}${sp.error.slice(1)}` : on ? "Saved as on; waiting for macOS to confirm." : "Sleep prevention is off."}</p>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </Section>
  );
}

function ModelsSection({ s, cfg, reload }: { s: Status | null; cfg: { config: Config; yaml: string; unknown_llm_tasks?: string[] } | null; reload: () => void }) {
  const jev = s?.models.jev, llm = s?.models.llm;
  const [def, setDef] = useState<Backend | null>(null);
  const [tasks, setTasks] = useState<Record<string, Backend>>({});
  const { data: accounts } = useApi<UsageAccountInfo[]>("/api/usage/accounts", ["usage"]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!cfg) return;
    setDef({ ...cfg.config.llm.default });
    setTasks(JSON.parse(JSON.stringify(cfg.config.llm.tasks ?? {})));
  }, [cfg?.yaml]);
  const names = useMemo(() => [...new Set([...Object.keys(TASKS), ...Object.keys(cfg?.config.llm.tasks ?? {})])], [cfg]);
  const dirty = !!cfg && !!def && JSON.stringify({ def, tasks }) !== JSON.stringify({ def: cfg.config.llm.default, tasks: cfg.config.llm.tasks ?? {} });
  const backends = (cur?: string) => [...new Set(["claude", "codex", ...(cur ? [cur] : [])])];
  async function save() {
    if (!def) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api<{ commit?: string }>("/api/system/config", { method: "PUT", json: { llm: { default: def, tasks } } });
      setMsg({ ok: true, text: `Saved${r.commit ? ` as commit ${String(r.commit).slice(0, 7)}` : ""}. New calls use it right away.` });
      reload();
    } catch (e: any) { setMsg({ ok: false, text: `Not saved: ${e.message}` }); }
    finally { setSaving(false); }
  }
  const setTask = (name: string, patch: Partial<Backend> | null) => setTasks((t) => {
    const next = { ...t };
    if (patch === null) delete next[name];
    else {
      const o: Backend = { backend: next[name]?.backend ?? def?.backend ?? "claude", model: next[name]?.model ?? "", effort: next[name]?.effort, account: next[name]?.account, ...patch };
      if (!o.effort) delete o.effort;
      // An account belongs to one provider; switching the backend drops it.
      if (!o.account || (patch?.backend && patch.backend !== next[name]?.backend)) delete o.account;
      next[name] = o;
    }
    return next;
  });
  const unknown = cfg?.unknown_llm_tasks ?? [];
  return (
    <Section id="models" title="Models" lede="Jev classifies and judges in milliseconds. The heavy model (Claude or Codex, run headless with hooks off) names, drafts and distills.">
      <div className="st-models">
        <div className="st-model">
          <h3>Jev</h3>
          {jev ? (
            <>
              <p className={`st-avail ${jev.available ? "on" : "off"}`}>{jev.available ? "Available" : "Not configured: add JEV_API_KEY to .env and restart the daemon"}</p>
              <Facts items={[
                ["Model", <span className="mono">{cfg?.config.jev.model ?? "jev-latest"}</span>],
                ["Calls since start", jev.calls],
                ["Average", jev.calls ? duration(jev.ms / jev.calls) : "–"],
                ["Errors", jev.errors],
              ]} />
            </>
          ) : <p className="meta">Loading…</p>}
        </div>
        <div className="st-model">
          <h3>Heavy model</h3>
          {llm ? (
            <Facts items={[
              ["Calls since start", llm.calls],
              ["Average", llm.calls ? duration(llm.ms / llm.calls) : "–"],
              ["Errors", llm.errors],
              ["Spend", llm.cost_usd ? `$${llm.cost_usd.toFixed(2)}` : "$0.00"],
            ]} />
          ) : <p className="meta">Loading…</p>}
        </div>
      </div>

      {cfg ? <NewModels value={cfg.config.new_models} reload={reload} /> : null}
      {unknown.length ? (
        <p className="inline-error st-unknown-tasks" role="alert" data-testid="unknown-llm-tasks">
          {unknown.length === 1 ? "One override has a key" : `${unknown.length} overrides have keys`} no task uses: {unknown.map((k, i) => <span key={k}>{i ? ", " : ""}<code>{k}</code></span>)}. They never apply, so those calls run on the default. Rename or remove {unknown.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {def ? (
        <form className="st-llm" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label="Heavy model per task">
          <table className="st-tasks">
            <thead><tr><th scope="col">Heavy model for</th><th scope="col">Backend</th><th scope="col">Model</th><th scope="col">Effort</th><th scope="col">Account</th></tr></thead>
            <tbody className="st-default">
              <tr>
                <th scope="row"><span>Every task, unless set below</span><code>llm.default</code></th>
                <td>
                  <select className="input st-backend" aria-label="Default backend" value={def.backend} onChange={(e) => setDef({ ...def, backend: e.target.value })}>
                    {backends(def.backend).map((b) => <option key={b} value={b}>{b === "claude" ? "Claude (claude -p)" : b === "codex" ? "Codex (codex exec)" : b}</option>)}
                  </select>
                </td>
                <td><input className="input st-model-name" aria-label="Default model" value={def.model} onChange={(e) => setDef({ ...def, model: e.target.value })} placeholder="gpt-6-luna" /></td>
                <td>
                  <select className="input st-effort" aria-label="Default effort" value={def.effort ?? ""} onChange={(e) => { const { effort: _, ...rest } = def; setDef(e.target.value ? { ...rest, effort: e.target.value } : rest); }}>
                    <option value="">CLI default</option>
                    {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </td>
                <td className="meta">The daemon's login</td>
              </tr>
            </tbody>
            <tbody>
              {names.map((n) => {
                const o = tasks[n];
                return (
                  <tr key={n} className={`${o ? "override" : ""}${TASKS[n] ? "" : " unknown"}`} data-task={n}>
                    <th scope="row"><span>{TASKS[n] ?? sentence(n.replace(/_/g, " "))}</span><code>{n}</code>{TASKS[n] ? null : <em className="st-unknown">No task uses this key</em>}</th>
                    <td>
                      <select className="input st-backend" aria-label={`Backend for ${n}`} value={o?.backend ?? ""} onChange={(e) => setTask(n, e.target.value ? { backend: e.target.value, model: o?.model || def.model } : null)}>
                        <option value="">Default</option>
                        {backends(o?.backend).map((b) => <option key={b} value={b}>{b === "claude" ? "Claude" : b === "codex" ? "Codex" : b}</option>)}
                      </select>
                    </td>
                    <td>
                      <input className="input st-model-name" aria-label={`Model for ${n}`} value={o?.model ?? ""} placeholder={def.model} disabled={!o}
                        onChange={(e) => setTask(n, { model: e.target.value })} />
                    </td>
                    <td>
                      <select className="input st-effort" aria-label={`Effort for ${n}`} value={o?.effort ?? ""} disabled={!o} onChange={(e) => setTask(n, { effort: e.target.value || undefined })}>
                        <option value="">{def.effort ? `Default (${def.effort})` : "Default"}</option>
                        {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="input st-account" aria-label={`Account for ${n}`} value={o?.account ?? ""} disabled={!o} onChange={(e) => setTask(n, { account: e.target.value || undefined })}>
                        <option value="">The daemon's login</option>
                        {(accounts ?? []).filter((a) => a.provider === o?.backend || a.id === o?.account).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row st-save">
            <button type="submit" className="btn primary" disabled={!dirty || saving}>{saving ? "Saving" : "Save model settings"}</button>
            {dirty ? <button type="button" className="btn ghost" onClick={() => { setDef({ ...cfg!.config.llm.default }); setTasks(JSON.parse(JSON.stringify(cfg!.config.llm.tasks ?? {}))); }}>Undo changes</button> : null}
            {msg ? <span className={msg.ok ? "st-ok" : "inline-error"} role="status">{msg.text}</span> : null}
          </div>
        </form>
      ) : null}
      {cfg?.yaml ? (
        <details className="st-yaml">
          <summary>Show <code>joyride.config.yaml</code></summary>
          <pre aria-label="joyride.config.yaml">{cfg.yaml}</pre>
        </details>
      ) : null}
    </Section>
  );
}

function NotificationsSection({ cfg, reload }: { cfg?: Config; reload: () => void }) {
  const [level, setLevel] = useState<string | null>(null);
  const [macos, setMacos] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (cfg) { setLevel(cfg.notifications.min_level); setMacos(cfg.notifications.macos); } }, [cfg?.notifications.min_level, cfg?.notifications.macos]);
  const dirty = !!cfg && (level !== cfg.notifications.min_level || macos !== cfg.notifications.macos);
  async function save() {
    setBusy("save"); setMsg(null);
    try { await api("/api/system/config", { method: "PUT", json: { notifications: { macos, min_level: level } } }); setMsg({ ok: true, text: "Saved." }); reload(); }
    catch (e: any) { setMsg({ ok: false, text: `Not saved: ${e.message}` }); }
    finally { setBusy(null); }
  }
  async function test() {
    setBusy("test"); setTestMsg(null);
    try {
      const r = await post<{ sent: boolean; reason?: string }>("/api/system/notify-test");
      setTestMsg(r.sent ? { ok: true, text: "Sent. It should appear in the top right of your screen; if not, allow notifications for Script Editor in System Settings." } : { ok: false, text: `Not sent: ${r.reason ?? "unknown reason"}.` });
    } catch (e: any) { setTestMsg({ ok: false, text: `Not sent: ${e.message}` }); }
    finally { setBusy(null); }
  }
  return (
    <Section id="notifications" title="Notifications" lede="When an agent needs you, Joyride can interrupt with a macOS notification. Everything below the level you pick waits quietly in the rail.">
      {cfg && level && macos !== null ? (
        <form className="st-notify" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <fieldset className="st-levels">
            <legend className="st-label">Notify me from</legend>
            {LEVELS.map(([l, label]) => (
              <label key={l} className={`st-level${level === l ? " on" : ""}`}>
                <input type="radio" name="min_level" value={l} checked={level === l} onChange={() => setLevel(l)} />
                <span className="level-badge quiet">{l}</span>
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <label className="k-check st-macos"><input type="checkbox" checked={macos} onChange={(e) => setMacos(e.target.checked)} /> Show macOS notifications</label>
          <div className="row st-save">
            <button type="submit" className="btn primary" disabled={!dirty || busy === "save"}>{busy === "save" ? "Saving" : "Save notification settings"}</button>
            <button type="button" className="btn" disabled={busy === "test"} onClick={test}>{busy === "test" ? "Sending" : "Send a test notification"}</button>
            {msg ? <span className={msg.ok ? "st-ok" : "inline-error"} role="status">{msg.text}</span> : null}
          </div>
          {testMsg ? <p className={testMsg.ok ? "st-ok" : "inline-error"} role="status" data-notify-test={testMsg.ok ? "sent" : "not-sent"}>{testMsg.text}</p> : null}
        </form>
      ) : <p className="meta" aria-busy="true">Loading…</p>}
    </Section>
  );
}

function GuardSection() {
  const policy = useApi<Policy>("/api/guard/policy", ["guard"]);
  const rules = useApi<AllowRule[]>("/api/guard/rules", ["guard"]);
  const recent = useApi<GuardRequest[]>("/api/guard/recent?limit=12", ["guard"]);
  const [err, setErr] = useState<string | null>(null);
  const titles = new Map((policy.data?.compiled.rules ?? []).map((r) => [r.id, r.title]));
  const timeout = policy.data?.compiled.timeout_seconds ?? 300;
  async function remove(id: string) {
    setErr(null);
    try { await api(`/api/guard/rules/${encodeURIComponent(id)}`, { method: "DELETE" }); rules.reload(); }
    catch (e: any) { setErr(`The rule was not removed: ${e.message}`); }
  }
  const scopeText = (r: AllowRule) => {
    if (r.scope_type === "global") return "Everywhere";
    if (r.scope_type === "mission") return `Idea ${r.scope_value}`;
    const [agent, id] = /^(claude|codex):/.test(r.scope_value) ? [r.scope_value.split(":")[0], r.scope_value.split(":").slice(1).join(":")] : ["", r.scope_value];
    return `${agent === "codex" ? "Codex session" : agent === "claude" ? "Claude Code session" : "Session"} ${id.slice(0, 8)}`;
  };
  return (
    <Section id="guard" title="Guard" lede={<>Agents run freely except for actions with real-world reach. Those wait up to {timeout >= 120 ? `${Math.round(timeout / 60)} minutes` : `${timeout} seconds`} for you; with no answer, or with the daemon down, they are denied so the agent moves on. Edit <code>guard.yaml</code> to change the rules.</>}>
      <div className="st-guard">
        <div>
          <h3>Held for your approval</h3>
          {policy.data ? (
            <ul className="st-rules">
              {policy.data.compiled.rules.map((r) => (
                <li key={r.id} data-guard-rule={r.id}>
                  <span className="st-rule-title">{sentence(r.title.replace(/ \/ /g, ", "))}</span>
                  <code>{r.id}</code>
                </li>
              ))}
            </ul>
          ) : policy.error ? <p className="inline-error">The guard policy can't load: {policy.error}.</p> : <p className="meta">Loading…</p>}
        </div>
        <div>
          <h3>Remembered allows</h3>
          {rules.data?.length ? (
            <ul className="st-allow">
              {rules.data.map((r) => (
                <li key={r.id} data-allow-rule={r.id}>
                  <span className="st-rule-title">{sentence(titles.get(r.rule) ?? r.rule)}</span>
                  <span className="meta">{scopeText(r)}{r.expires ? <>, until {new Date(r.expires).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</> : null}</span>
                  <button type="button" className="btn small" onClick={() => remove(r.id)} aria-label={`Forget the allow for ${titles.get(r.rule) ?? r.rule}`}>Forget</button>
                </li>
              ))}
            </ul>
          ) : rules.data ? (
            <EmptyState title="Nothing remembered"><p>“Allow for this session” or “for this idea” in the approvals tray adds a rule here, with an expiry.</p></EmptyState>
          ) : null}
          {err ? <p className="inline-error" role="alert">{err}</p> : null}
        </div>
      </div>
      <h3 className="st-sub">Recent decisions</h3>
      {recent.data?.length ? (
        <ul className="st-recent">
          {recent.data.map((r) => (
            <li key={r.id} data-guard-request={r.id}>
              <StateChip state={r.decision} label={r.decision === "allow" ? "Allowed" : r.decision === "deny" ? "Denied" : r.decision === "timeout" ? "Timed out" : "Waiting"} />
              <span className="st-recent-title">{sentence(r.title)}</span>
              <code className="st-recent-cmd" title={r.summary}>{r.summary}</code>
              <span className="meta st-recent-when"><TimeAgo iso={r.decided_at ?? r.created} /></span>
            </li>
          ))}
        </ul>
      ) : recent.data ? <p className="meta">No gated actions yet. When an agent tries one, its decision is listed here.</p> : null}
    </Section>
  );
}

function ComponentsSection({ s }: { s: Status | null }) {
  const changes = [...(s?.global_changes ?? [])].reverse().slice(0, 8);
  const state = (st: string) => /^error/i.test(st) ? "fail" : /not installed|missing|absent/i.test(st) ? "idle" : "pass";
  return (
    <Section id="components" title="Installed components" lede={<>Everything Joyride changed outside this repo, through <code>./bin/joyride install</code>. Each change is logged in <code>GLOBAL_CHANGES.md</code> and undone by <code>uninstall</code>.</>}>
      {s ? (
        <ul className="st-components">
          {s.components.map((c) => (
            <li key={c.name} data-component={c.name}>
              <StateChip state={state(c.status)} label={state(c.status) === "idle" ? "Not installed" : state(c.status) === "fail" ? "Error" : "Installed"} />
              <code className="st-comp-name">{c.name}</code>
              <span className="st-comp-status">{c.status}</span>
              <span className="st-comp-desc">{c.describe}</span>
            </li>
          ))}
        </ul>
      ) : <p className="meta">Loading…</p>}
      <h3 className="st-sub">Last global changes</h3>
      {changes.length ? (
        <ol className="st-changes">
          {changes.map((c, i) => {
            const [ts, what] = c.split(/\s+—\s+/);
            const iso = ts && !Number.isNaN(Date.parse(ts)) ? ts : null;
            return <li key={i}><span className="meta">{iso ? <TimeAgo iso={iso} /> : ts}</span><span>{sentence((what ?? c).replace(/`/g, ""))}</span></li>;
          })}
        </ol>
      ) : <p className="meta">Nothing installed yet.</p>}
    </Section>
  );
}

function Bars({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <svg className="st-bars" viewBox={`0 0 ${values.length * 6} 28`} preserveAspectRatio="none" role="img" aria-label={label}>
      {values.map((v, i) => <rect key={i} x={i * 6 + 1} y={28 - (v / max) * 26} width={4} height={Math.max(v ? 2 : 0.5, (v / max) * 26)} />)}
    </svg>
  );
}

function MetricsSection() {
  const { data: m } = useApi<Metrics>("/api/metrics", ["metrics", "attention"], { pollMs: 60_000 });
  const lat = (l?: Latency) => (l?.count ? <><b>{duration(l.p50_ms)}</b> median, <b>{duration(l.p90_ms)}</b> at p90, over {plural(l.count, "unblock")}</> : <span className="muted">No unblocks timed</span>);
  return (
    <Section id="metrics" title="Metrics" lede="What Joyride is for: you unblock agents faster, check on them less, and its judgments agree with yours.">
      {m ? (
        <dl className="st-metrics">
          <div data-metric="unblock-1d"><dt>Blocked to unblocked, today</dt><dd>{lat(m.blocked_to_unblocked["1d"])}</dd></div>
          <div data-metric="unblock-7d"><dt>Blocked to unblocked, this week</dt><dd>{lat(m.blocked_to_unblocked["7d"])}</dd></div>
          <div data-metric="checking">
            <dt>Checking on agents, last 24 hours</dt>
            <dd>
              <b>{m.checking.while_nothing_pending}</b> pane switches while nothing waited on you, of {plural(m.checking.focus_switches, "switch", "switches")}
              <Bars values={m.checking.per_hour.map((h) => h.checking)} label="Checking switches per hour, last 24 hours" />
            </dd>
          </div>
          <div data-metric="open">
            <dt>Open now</dt>
            <dd>{(["L4", "L3", "L2", "L1"] as const).map((l) => <span key={l} className="st-open"><span className={`level-badge ${Number(l[1]) >= 3 && m.open[l] ? "signal" : "quiet"}`}>{l}</span> {m.open[l] ?? 0}</span>)}{m.snoozed ? <span className="muted">, {m.snoozed} snoozed</span> : null}</dd>
          </div>
          {m.notifications ? <div data-metric="notifications"><dt>Notifications, last 24 hours</dt><dd><b>{m.notifications.sent_24h}</b> sent, {m.notifications.deduped_24h} held back as repeats</dd></div> : null}
        </dl>
      ) : <p className="meta" aria-busy="true">Loading…</p>}
    </Section>
  );
}
