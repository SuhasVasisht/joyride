// Set up Joyride: one checklist of everything Joyride and Firstmate need on this Mac,
// computed by GET /api/system/setup. Each item has one fix: a button (install, start,
// log in, test), a command to run, or a link. The list rechecks after every fix.
import { useEffect, useRef, useState } from "react";
import { api, post } from "../../lib/api";
import { go, type Route } from "../../lib/router";
import { CopyButton, TimeAgo } from "../../components/primitives";
import { useSetup, type SetupFix, type SetupItem, type SetupReport } from "./useSetup";

type Job = { id: string; component: string; status: "running" | "ok" | "failed"; output: string; started: string; finished: string | null; exit: number | null };
type GhView = { active: boolean; worker?: string | null; code?: string | null; url?: string | null; question?: string | null; account?: string | null; done?: boolean; error?: string | null; screen?: string; command: string };

/** POST that keeps the status, so a missing route (404) can fall back to a command. */
async function postRaw(path: string, json: unknown = {}) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  return { status: r.status, ok: r.ok, data };
}

const STATE_LABEL: Record<string, string> = { ok: "Done", missing: "To do", warn: "Check", unknown: "Can't tell", needs_you: "Needs you" };
const stateOf = (i: SetupItem) => (i.needs_you ? "needs_you" : i.status);

function Mark({ state }: { state: string }) {
  return (
    <svg className={`su-mark m-${state}`} viewBox="0 0 20 20" width="20" height="20" role="img" aria-label={STATE_LABEL[state]}>
      {state === "ok" ? <><circle cx="10" cy="10" r="9" /><path d="M6 10.4l2.6 2.6L14.2 7.4" /></>
        : state === "needs_you" ? <><circle cx="10" cy="10" r="9" /><path d="M10 5.5v5.5M10 14v.4" /></>
        : state === "warn" ? <><circle cx="10" cy="10" r="8.25" /><path d="M10 5.8v5M10 13.8v.4" /></>
        : state === "unknown" ? <><circle cx="10" cy="10" r="8.25" /><path d="M7.9 7.9a2.2 2.2 0 1 1 3 2.05c-.6.25-.9.6-.9 1.25M10 14v.4" /></>
        : <circle cx="10" cy="10" r="8.25" />}
    </svg>
  );
}

export function SetupPage(_: { route: Route }) {
  const { data, error, setData, reload } = useSetup({ pollMs: 20_000 });
  const [checking, setChecking] = useState(false);
  useEffect(() => { post("/api/system/setup/seen").catch(() => {}); }, []);
  const recheck = async () => {
    setChecking(true);
    try { setData(await api<SetupReport>("/api/system/setup?fresh=1")); } catch { reload(); }
    finally { setChecking(false); }
  };

  const req = data?.items.filter((i) => i.group === "required") ?? [];
  const opt = data?.items.filter((i) => i.group === "optional") ?? [];
  const s = data?.summary;
  return (
    <div className="su-page" data-testid="setup-page">
      <header className="su-head">
        <h1>Set up Joyride</h1>
        <p className="su-lede">Everything Joyride and Firstmate need on this Mac, checked one piece at a time. Each line has the one fix for it. Installs run only when you press their button, and each one is logged in <code>GLOBAL_CHANGES.md</code>.</p>
        {s ? (
          <div className="su-progress" aria-label="Setup progress">
            <p className="su-count"><span className="su-num">{s.required.done}</span> of {s.required.total} required steps done</p>
            <ol className="su-ticks" aria-hidden="true">{req.map((i) => <li key={i.id} className={`t-${stateOf(i)}`} title={i.title} />)}</ol>
            <p className="su-side meta">{s.done} of {s.total} done overall. Checked <TimeAgo iso={data!.at} /></p>
            <button className="btn" onClick={recheck} disabled={checking}>{checking ? "Checking…" : "Recheck"}</button>
          </div>
        ) : error ? <p className="inline-error" role="alert">The checklist can't load: {error}. Start the daemon with <code>./bin/joyride up</code>, then reload.</p>
          : <p className="meta" aria-busy="true">Checking this Mac…</p>}
        {s && !s.blocking && s.required.done === s.required.total ? (
          <div className="su-ready"><p>Joyride is ready. The guide walks through the daily loop.</p><button className="btn primary" onClick={() => go("start")}>Open the guide</button></div>
        ) : null}
      </header>
      {data ? (
        <>
          <Group id="required" title="Required" lede="Joyride and Firstmate need these before agents can work for you." items={req} onChanged={recheck} />
          <Group id="optional" title="Optional" lede="Nice to have. Joyride works without them." items={opt} onChanged={recheck} />
        </>
      ) : null}
    </div>
  );
}

function Group({ id, title, lede, items, onChanged }: { id: string; title: string; lede: string; items: SetupItem[]; onChanged: () => void }) {
  const done = items.filter((i) => i.status === "ok").length;
  return (
    <section className="su-group" aria-labelledby={`su-h-${id}`} data-group={id}>
      <div className="su-group-head">
        <h2 id={`su-h-${id}`}>{title}</h2>
        <span className="meta">{done} of {items.length} done</span>
      </div>
      <p className="su-group-lede">{lede}</p>
      <ol className="su-items">{items.map((i) => <ItemRow key={i.id} item={i} onChanged={onChanged} />)}</ol>
    </section>
  );
}

function ItemRow({ item, onChanged }: { item: SetupItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [gh, setGh] = useState(false);
  const state = stateOf(item);
  const fix = item.fix;

  // A login started earlier (or in another tab) shows up again here.
  useEffect(() => {
    if (item.id !== "gh-login") return;
    api<GhView>("/api/system/setup/gh-login").then((v) => { if (v.active) setGh(true); }).catch(() => {});
  }, [item.id]);

  const run = async (f: SetupFix) => {
    const a = f.action ?? "";
    setErr(null); setFallback(null); setBusy(true);
    try {
      if (a.startsWith("install:")) {
        const r = await postRaw("/api/system/install", { component: a.slice(8) });
        if (!r.ok) throw new Error(r.data?.error ?? `The install could not start (HTTP ${r.status}).`);
        setJob(r.data);
        return; // InstallOutput finishes the job and rechecks
      }
      if (a === "herdr-start") {
        const r = await postRaw("/api/herdr/start");
        if (r.status === 404) setFallback("herdr");
        else if (!r.ok) throw new Error(r.data?.error ?? `Herdr did not start (HTTP ${r.status}).`);
      } else if (a === "firstmate-start") {
        const r = await postRaw("/api/firstmate/start");
        const e = r.data?.status === "failed" ? r.data.error : !r.ok ? r.data?.error : null;
        if (e) throw new Error(e);
      } else if (a === "gh-login") {
        const r = await postRaw("/api/system/setup/gh-login");
        if (!r.ok) { if (r.data?.command) setFallback(r.data.command); throw new Error(r.data?.error ?? `The login could not start (HTTP ${r.status}).`); }
        setGh(true);
      } else if (a === "notify-test") {
        const r = await postRaw("/api/system/notify-test");
        if (r.data && r.data.sent === false) setErr(`The test didn't go out: ${r.data.reason}.`);
      }
      onChanged();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const ack = async () => { setBusy(true); try { await post("/api/system/setup/ack", { id: item.id }); onChanged(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const installing = job?.status === "running";

  return (
    <li className={`su-item s-${state}`} data-item={item.id} data-status={item.status}>
      <Mark state={state} />
      <div className="su-main">
        <div className="su-title-row"><h3>{item.title}</h3><span className="su-state">{STATE_LABEL[state]}</span></div>
        <p className="su-detail">{item.detail}</p>
        {job ? <InstallOutput job={job} onFinish={(j) => { setJob(j); setBusy(false); onChanged(); }} /> : null}
        {gh ? <GhLoginPanel onFinish={() => { setGh(false); onChanged(); }} /> : null}
        {fallback ? <div className="su-fallback"><p className="meta">{fallback === "herdr" ? "This Joyride can't start Herdr itself yet. Run it in a terminal, then press Recheck." : "Run this in any terminal instead:"}</p><Command command={fallback === "herdr" ? "herdr" : fallback} /></div> : null}
        {err ? <p className="inline-error" role="alert">{err}</p> : null}
      </div>
      <div className="su-fix">
        {fix?.kind === "button" ? (
          <>
            <button className={`btn ${item.group === "required" && item.status !== "ok" ? "primary" : ""}`} disabled={busy || installing || Boolean(fix.disabled)} onClick={() => run(fix)}>
              {installing ? "Installing…" : busy ? "Working…" : fix.label}
            </button>
            {fix.disabled ? <p className="su-why">{fix.disabled}</p> : fix.command ? <p className="su-runs">Runs <code>{fix.command}</code></p> : null}
          </>
        ) : fix?.kind === "command" && fix.command ? (
          <>
            <span className="su-cmd-label">{fix.label}</span>
            <Command command={fix.command} />
            {fix.ack ? <button className="btn ghost small su-ack" disabled={busy} onClick={ack}>Mark as done</button> : null}
          </>
        ) : fix?.kind === "link" && fix.href ? (
          <a className={`btn ${item.needs_you ? "signal" : ""}`} href={fix.href} {...(/^https?:/.test(fix.href) ? { target: "_blank", rel: "noreferrer" } : {})}>{fix.label}</a>
        ) : null}
      </div>
    </li>
  );
}

function Command({ command }: { command: string }) {
  return <div className="su-cmd"><code>{command}</code><CopyButton text={command} /></div>;
}

function InstallOutput({ job, onFinish }: { job: Job; onFinish: (j: Job) => void }) {
  const [j, setJ] = useState(job);
  const pre = useRef<HTMLPreElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (j.status !== "running") return;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const next = await api<Job>(`/api/system/install/${j.id}`);
        setJ(next);
        if (next.status !== "running") { clearInterval(t); onFinish(next); }
      } catch {}
    }, 800);
    return () => clearInterval(t);
  }, [j.id, j.status]);
  useEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [j.output]);
  const secs = Math.max(0, Math.round(((j.finished ? Date.parse(j.finished) : now) - Date.parse(j.started)) / 1000));
  return (
    <div className={`su-job j-${j.status}`} aria-live="polite">
      <p className="su-job-line">{j.status === "running" ? `Installing ${j.component}, ${secs}s so far.` : j.status === "ok" ? `Installed ${j.component} in ${secs}s. Logged in GLOBAL_CHANGES.md.` : `The ${j.component} install failed (exit ${j.exit ?? "?"}). The output below says why.`}</p>
      {j.output.trim() ? <pre ref={pre} className="su-out">{j.output.trim()}</pre> : null}
    </div>
  );
}

function GhLoginPanel({ onFinish }: { onFinish: () => void }) {
  const [v, setV] = useState<GhView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const next = await api<GhView>("/api/system/setup/gh-login");
        if (stop) return;
        setV(next);
        if (next.done || !next.active) { if (next.done) setTimeout(onFinish, 1500); return; }
      } catch (e: any) { setErr(e.message); }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, []);
  const answer = async (a: "y" | "n") => { try { setV(await post<GhView>("/api/system/setup/gh-login/answer", { answer: a })); } catch (e: any) { setErr(e.message); } };
  const focus = async () => { try { await post("/api/system/setup/gh-login/focus"); } catch (e: any) { setErr(e.message); } };
  if (!v) return <p className="meta su-gh" aria-busy="true">Opening a login pane in Herdr…</p>;
  return (
    <div className="su-gh" aria-live="polite">
      {v.done ? <p className="su-gh-done">Logged in to GitHub{v.account ? ` as ${v.account}` : ""}. Joyride closed the login pane.</p> : (
        <>
          {v.question ? (
            <div className="su-gh-q"><p>gh asks: <strong>{v.question}</strong></p><div className="row"><button className="btn primary" onClick={() => answer("y")}>Yes</button><button className="btn" onClick={() => answer("n")}>No</button></div><p className="meta">Yes lets git use this login for github.com.</p></div>
          ) : v.code ? (
            <div className="su-gh-code">
              <span className="su-cmd-label">Your one-time code</span>
              <div className="row"><code className="su-code">{v.code}</code><CopyButton text={v.code} label="Copy code" /></div>
              <p>GitHub opens in your browser. Paste the code there and approve. If no browser window appeared, <a href={v.url ?? "https://github.com/login/device"} target="_blank" rel="noreferrer">open github.com/login/device</a>.</p>
            </div>
          ) : <p className="meta">Waiting for gh to show a one-time code…</p>}
          {v.error ? <p className="inline-error" role="alert">{v.error}</p> : null}
          <div className="row su-gh-tools">
            <button className="btn ghost small" onClick={focus}>Show the pane in Herdr</button>
            {v.screen ? <details className="su-gh-screen"><summary>What the login pane shows</summary><pre className="su-out">{v.screen}</pre></details> : null}
          </div>
        </>
      )}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </div>
  );
}
