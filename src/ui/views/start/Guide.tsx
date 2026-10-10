// "Start here": the daily loop, with live counts and the one action for each step.
import { useNeedsYou, openNeedsYou } from "../../lib/needs-you";
import { useState } from "react";
import { api, post, useApi } from "../../lib/api";
import { go } from "../../lib/router";
import { setupLine, useSetup } from "../setup/useSetup";

const SEEN = "joyride.guide.dismissed";
export const guideDismissed = () => { try { return localStorage.getItem(SEEN) === "1"; } catch { return false; } };
export const dismissGuide = () => { try { localStorage.setItem(SEEN, "1"); } catch {} };

function useCounts() {
  const { data: workers } = useApi<any[]>("/api/workers", ["workers"]);
  const { data: proposals } = useApi<any[]>("/api/missions/proposals", ["proposals"]);
  const { data: missions } = useApi<any[]>("/api/missions", ["missions"]);
  const { items, ready } = useNeedsYou();
  const ws = workers ?? [];
  return {
    inHerdr: ws.filter((w) => w.controllable).length,
    outside: ws.filter((w) => !w.controllable && w.pid),
    proposals: (proposals ?? []).length,
    missions: (missions ?? []).filter((m) => !m.archive && m.state === "open").length,
    needsYou: ready ? items.length : 0,
  };
}

function MoveAll({ outside }: { outside: any[] }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const idle = outside.filter((w) => w.status !== "working");
  if (!idle.length) return null;
  const run = async () => {
    if (!confirm(`Move ${idle.length} agent${idle.length > 1 ? "s" : ""} into Herdr?\n\nEach one is ended in its current terminal (the conversation is kept) and resumed in a Herdr tab at the same folder. Agents that are working right now are skipped.`)) return;
    setBusy(true);
    let ok = 0; const failed: string[] = [];
    for (const w of idle) {
      const r = await post<any>("/api/intents", { kind: "move_to_herdr", target: w.id, payload: {} }).catch((e) => ({ status: "failed", error: e.message }));
      if (r.status === "failed") failed.push(`${w.title || w.id}: ${r.error}`); else ok++;
    }
    setBusy(false);
    setNote(`Moved ${ok}.${failed.length ? ` Not moved: ${failed.join("; ")}` : ""}`);
  };
  return <><button className="btn" disabled={busy} onClick={run}>{busy ? "Moving…" : `Move ${idle.length} into Herdr`}</button>{note ? <p className="ha-note">{note}</p> : null}</>;
}

function SetupStep() {
  const { data } = useSetup();
  const blocking = data?.summary.blocking ?? 0;
  return (
    <li className="guide-setup">
      <h2>Set up Joyride</h2>
      <p>Joyride needs a few pieces on this Mac: its hooks in Claude Code and Codex, Herdr, and the tools Firstmate uses. The setup page checks each one and installs what is missing when you press its button.</p>
      {data ? <p className="meta">{setupLine(data)}</p> : null}
      <div className="row"><button className={`btn ${blocking ? "primary" : ""}`} onClick={() => go("setup")}>{blocking ? "Finish setting up" : "Open setup"}</button></div>
    </li>
  );
}

export function GuidePage() {
  const c = useCounts();
  return (
    <article className="pane-page guide">
      <header className="mp-header">
        <h1 className="mp-title">How to use Joyride</h1>
        <p className="guide-lede">Joyride is where you supervise your agents. They do the work in Herdr panes; you decide what they work on, answer them when they are stuck, and check their proof before calling anything done.</p>
      </header>
      <ol className="guide-steps">
        <SetupStep />
        <li>
          <h2>Keep your agents in Herdr</h2>
          <p>Joyride sees every Claude Code and Codex session, but it can only talk to the ones running in Herdr. Run <code>herdr</code> in a terminal to see their panes. Right now <strong>{c.inHerdr}</strong> run in Herdr{c.outside.length ? <> and <strong>{c.outside.length}</strong> still run in plain terminals</> : null}.</p>
          <div className="row"><MoveAll outside={c.outside} /><button className="btn" onClick={() => go("start-session")}>Start a session</button></div>
        </li>
        <li>
          <h2>Turn your work into ideas</h2>
          <p>An idea is a goal plus a short "done when" list. Joyride proposed ideas from your last 30 days of sessions; accept the ones that matter and reject the rest. Sessions that belong to an idea show up inside it on the map, and Firstmate's tasks are filed into ideas for you.</p>
          <div className="row"><button className="btn primary" onClick={() => go("agents?show=suggested")}>Review {c.proposals} suggested ideas</button><button className="btn" onClick={() => go("new-mission")}>New idea</button></div>
        </li>
        <li>
          <h2>Start work from an idea</h2>
          <p>Open an idea and choose <em>Start a session</em>. Joyride opens Claude Code or Codex in a Herdr pane with the idea's goal and done-when list as the first message. For bigger jobs, hand it to Firstmate from the idea's Crew panel.</p>
          <div className="row"><button className="btn" onClick={() => go("map")}>Open the map ({c.missions} open ideas)</button></div>
        </li>
        <li>
          <h2>Answer only what needs you</h2>
          <p>The rail on the right is your inbox. <strong>Approvals</strong> holds risky actions (pushes, Jira or Slack writes, cloud changes) until you allow them. <strong>Needs you</strong> lists agents that are blocked on a question or a terminal prompt: reply or pick the prompt option right there. <strong>Review</strong> holds finished work. You get a macOS notification for anything urgent.</p>
          <p className="meta">{c.needsYou ? <button className="btn link" onClick={openNeedsYou}>{c.needsYou} items need you now.</button> : "Nothing needs you right now."} Press <kbd>\</kbd> to show or hide the rail, <kbd>⌘K</kbd> to jump anywhere.</p>
        </li>
        <li>
          <h2>Drop into the terminal any time</h2>
          <p>Click an agent on the map to open its pane here, then <em>Open in Herdr</em> to bring that pane to the front of your Herdr window and type yourself. Joyride keeps tracking it either way.</p>
        </li>
        <li>
          <h2>Prove it, then close it</h2>
          <p>Agents record tests and screenshots with <code>joyride-evidence</code>. On the idea, ask Jev for a verdict; an idea closes on a pass, or with a reason you write.</p>
        </li>
      </ol>
    </article>
  );
}

const LATER = "joyride.setup.later";
const setupLater = () => { try { return sessionStorage.getItem(LATER) === "1"; } catch { return false; } };

/** Rail card. While something required is missing it leads with setup; the guide card can be
 * dismissed, after which a smaller "Finish setting up" card stays until setup is done (or "Later"). */
export function GuideRail() {
  const [hidden, setHidden] = useState(guideDismissed());
  const [later, setLater] = useState(setupLater());
  const { data } = useSetup();
  const blocking = data?.summary.blocking ?? 0;
  const req = data?.summary.required;
  const meter = req ? (
    <>
      <div className="setup-meter" role="meter" aria-valuemin={0} aria-valuemax={req.total} aria-valuenow={req.done} aria-label={`${req.done} of ${req.total} required steps done`}><span style={{ width: `${Math.round((req.done / Math.max(1, req.total)) * 100)}%` }} /></div>
      <p className="meta">{req.done} of {req.total} required steps done</p>
    </>
  ) : null;
  const left = `${blocking} required step${blocking > 1 ? "s" : ""} left before Joyride and Firstmate can work for you.`;
  if (!hidden) {
    return (
      <section className={`guide-rail${blocking ? " setup-rail" : ""}`} aria-label="Getting started">
        <h3>{blocking ? "New here? Start with setup" : "New here?"}</h3>
        <p>{blocking ? `${left} Then the guide walks through the daily loop.` : "A two-minute guide to the daily loop: ideas, Herdr, the rail, proof."}</p>
        {blocking ? meter : null}
        <div className="row">
          {blocking ? <button className="btn primary" onClick={() => go("setup")}>Set up Joyride</button> : null}
          <button className={`btn ${blocking ? "" : "primary"}`} onClick={() => go("start")}>Open the guide</button>
          <button className="btn ghost" onClick={() => { dismissGuide(); setHidden(true); }}>Dismiss</button>
        </div>
      </section>
    );
  }
  if (!blocking || later) return null;
  return (
    <section className="guide-rail setup-rail" aria-label="Finish setting up">
      <h3>Finish setting up</h3>
      <p>{left}</p>
      {meter}
      <div className="row"><button className="btn primary" onClick={() => go("setup")}>Set up Joyride</button><button className="btn ghost" onClick={() => { try { sessionStorage.setItem(LATER, "1"); } catch {} setLater(true); }}>Later</button></div>
    </section>
  );
}
