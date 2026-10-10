// Firstmate's control session as its own node, the fleet bridge: a ship's-wheel badge whose motion is
// the control session's state (turning while it works, a signal ring when it needs you, asleep when
// stopped), the fleet's counts and the shared actionable ask count, the counts the captain acts on, and a ticker of what the crew is doing.
// Running, the whole card opens the control session (chat, terminal, reply box); stopped, it offers
// the same start as the crew page.
import { useNeedsYou, openNeedsYou } from "../../lib/needs-you";
import { useEffect, useState } from "react";
import { href, go } from "../../lib/router";
import { post } from "../../lib/api";
import { plural } from "../../components/primitives";
import type { Item, ZoomLevel } from "./layout";
import type { FirstmateNode as FirstmateData } from "./world";
import { FirstmatePrimary } from "../crew/FirstmatePrimary";
import { isPrimaryIdle } from "../../../shared/firstmate-primary";
import { AskBadge, AskCard } from "./AskCard";
import { MapSlot } from "./slots";
import { Replies } from "./ReplyNote";

const CONTROL_STATE: Record<string, string> = { working: "Working", blocked: "Waiting", idle: "Idle", done: "Idle", unknown: "Status unknown", exited: "Exited" };
type IntentRec = { status: "pending" | "sent" | "acked" | "failed"; error: string | null };
/** How long each ticker line stays up. */
const TICK_MS = 3800;

/** The badge: a ship's wheel in a porthole, with a pennant on top. */
function WheelBadge({ size }: { size: number }) {
  const spokes = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <span className="fm-avatar" style={{ width: size, height: size }} aria-hidden>
      <svg className="fm-pennant" width={size * 0.42} height={size * 0.34} viewBox="0 0 20 16">
        <path d="M2 1v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path className="fm-pennant-cloth" d="M2.8 1.6h13.6l-3.6 4 3.6 4H2.8z" fill="currentColor" />
      </svg>
      <svg className="fm-wheel" width={size} height={size} viewBox="0 0 48 48">
        <circle className="fm-port" cx="24" cy="24" r="22.5" />
        <g className="fm-turn">
          {spokes.map((a) => (
            <g key={a} transform={`rotate(${a} 24 24)`}>
              <path d="M24 24V6.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="24" cy="5.4" r="2.6" fill="currentColor" />
            </g>
          ))}
          <circle cx="24" cy="24" r="12.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
          <circle cx="24" cy="24" r="4.4" fill="currentColor" />
          <circle cx="24" cy="24" r="1.6" className="fm-hub" />
        </g>
      </svg>
    </span>
  );
}

/** One line at a time from the crew's log, so a glance shows the fleet moving. */
function Ticker({ log, running }: { log: FirstmateData["log"]; running: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (log.length < 2) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setI((x) => x + 1), TICK_MS);
    return () => clearInterval(t);
  }, [log.length]);
  if (!running) return null;
  if (!log.length) return <p className="fm-ticker quiet" data-fm="ticker">Quiet watch: no tasks under way</p>;
  const e = log[i % log.length];
  return (
    <p className="fm-ticker" data-fm="ticker" aria-live="off" title={`${e.who}: ${e.what}`}>
      <span className="fm-tick" key={`${e.id}:${i}`}>
        <span className="fm-tick-who">{e.who}</span>
        <span className="fm-tick-what">{e.what}</span>
      </span>
      {log.length > 1 ? <span className="fm-tick-n">{(i % log.length) + 1}/{log.length}</span> : null}
    </p>
  );
}

/** Fleet membership opens the fleet; captain items open their controls in the rail. */
function Bridge({ f, level }: { f: FirstmateData; level: ZoomLevel }) {
  const c = f.fleet;
  const { items: needs, ready } = useNeedsYou();
  const far = level === "far";
  const items: { id: string; show: string; n: number; text: string; title: string; hot?: boolean }[] = [
    { id: "crew", show: "owner=crew", n: c.crew, text: far ? `${c.crew} crew` : plural(c.crew, "crewmate"), title: "Sessions Firstmate launched for its tasks" },
    { id: "watched", show: "owner=yours", n: c.watched, text: `${c.watched} watched`, title: "Sessions you started, which Firstmate watches" },
    { id: "needs-you", show: "needs-you", n: needs.length, text: `${needs.length} need you`, title: "Open the items waiting on you" },
    { id: "your-helm", show: "show=your-helm", n: c.yourHelm, text: `${c.yourHelm} at your helm`, title: "Sessions you steered yourself in the last turn: you hold their helm" },
  ];
  return (
    <p className="fm-bridge" data-fm="fleet" aria-label="Fleet">
      <a className="fb-all" href={href("agents")} title="Every agent and session, on the Agents page">Fleet</a>
      {items.filter((x) => x.id !== "needs-you" || (ready && needs.length > 0)).map((x) => x.id === "needs-you" ? (
        <button key={x.id} className="fb-count btn link signal-text" data-count={x.id} data-n={needs.length} onClick={openNeedsYou}>{needs.length} {needs.length === 1 ? "needs" : "need"} you</button>
      ) : (
        <a key={x.id} href={href(`agents?${x.show}`)} className={`fb-count${x.hot ? " signal-text" : ""}${x.n ? "" : " zero"}`} data-count={x.id} data-n={x.n} title={x.title}>{x.text}</a>
      ))}
    </p>
  );
}

export function FirstmateNode({ it, f, level, selected, onFocus, onStarted, suppress, style }: {
  it: Item; f: FirstmateData; level: ZoomLevel; selected: boolean; onFocus: (e: React.FocusEvent) => void; onStarted: () => void; suppress: { current: boolean }; style: React.CSSProperties;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = f.status;
  const worker = st?.pane?.worker ?? null;
  const running = Boolean(st?.running && worker);
  const control = running ? (f.worker?.status ?? st?.pane?.status ?? "unknown") : null;
  const state = !st ? (f.error ? "error" : "loading") : running ? control! : "stopped";
  const stateText = !st ? (f.error ? "Unavailable" : "Checking") : running ? CONTROL_STATE[control!] ?? control! : "Not running";
  const { items: captainItems, ready } = useNeedsYou();
  const needsYou = ready && captainItems.length > 0;
  const link = worker ? href(`worker/${encodeURIComponent(worker)}`) : undefined;

  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await post<IntentRec>("/api/firstmate/start");
      if (r.status === "failed") setErr(r.error ?? "Firstmate did not start.");
      else onStarted();
    } catch (e: any) { setErr(`Firstmate did not start: ${e.message}`); }
    finally { setBusy(false); }
  }
  const open = (e: React.MouseEvent) => {
    if (!worker || suppress.current || (e.target as HTMLElement).closest("a, button")) return;
    go(`worker/${encodeURIComponent(worker)}`);
  };

  return (
    <div className={`map-node fm-node s-${state}${needsYou ? " needs-you" : ""}${selected ? " selected" : ""}`} style={style} data-item={it.id} data-map-item={it.id}
      data-testid="firstmate-node" data-firstmate={running ? "running" : st ? "stopped" : state} data-control={control ?? undefined} onClick={open} onFocus={onFocus}>
      <WheelBadge size={level === "far" ? 44 : 52} />
      <div className="fm-body">
        <div className="fm-head">
          {link ? (
            <a className="fm-title" href={link} title="Open Firstmate's control session">Firstmate</a>
          ) : <span className="fm-title">Firstmate</span>}

        </div>
        <div className="fm-line">
          <span className={`fm-state s-${state}`}><i className="fm-dot" aria-hidden />{stateText}</span>
          {st ? <span data-fm="in-flight">{level === "far" ? `${f.inFlight} moving` : plural(f.inFlight, "task") + " moving"}</span> : null}

        </div>
        <Bridge f={f} level={level} />
        {level === "near" ? <FirstmatePrimary primary={st?.primary} running={running} idle={isPrimaryIdle(control ?? undefined)} reload={onStarted} />
          : st?.primary?.current ? <p className="meta fm-account" title={st.primary.lastSwitch?.reason}>{st.primary.current.label} · {st.primary.current.harness}</p> : null}

        {level !== "far" ? <Ticker log={f.log} running={running} /> : null}
        <Replies list={f.replies} level={level} />
        {level === "near" ? f.asks.map((a) => <AskCard key={a.id} ask={a} folded />) : level === "mid" ? f.asks.map((a) => <AskBadge key={a.id} ask={a} />) : null}
        <MapSlot name="hub-notes" level={level} />
        {!st && f.error && level !== "far" ? <p className="fm-hint">Joyride can't read Firstmate's state: {f.error}</p> : null}
        {st && !running ? (
          <div className="fm-start">
            <button type="button" className="btn small primary" onClick={start} disabled={busy || !st.herdr_connected}>{busy ? "Starting Firstmate" : "Start Firstmate"}</button>
            {level !== "far" ? <span className="fm-hint">{st.herdr_connected ? "Starts in its own Herdr pane." : "Herdr is not connected. Start Herdr, then start Firstmate."}</span> : null}
          </div>
        ) : null}
        {err ? <p className="inline-error fm-hint" role="alert">{err}</p> : null}
      </div>
    </div>
  );
}
