// Buttons that connect Joyride to Herdr: open a pane in your Herdr window, move a
// plain-terminal agent into Herdr, resume a past session in Herdr.
import { useState } from "react";
import { post } from "../lib/api";
import { go } from "../lib/router";

type IntentResult = { id: string; status: string; error: string | null; result?: any };
async function intent(kind: string, target: string, payload: Record<string, unknown> = {}) {
  const r = await post<IntentResult>("/api/intents", { kind, target, payload });
  if (r.status === "failed") throw new Error(r.error ?? "It didn't work.");
  return r;
}
export const workerIdFor = (r: IntentResult) => (r.result?.machine && r.result?.pane_id ? `${r.result.machine}:${r.result.pane_id}` : r.result?.worker ?? null);

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return { busy, msg, run };
}
const Note = ({ msg }: { msg: { ok: boolean; text: string } | null }) => (msg ? <p className={`ha-note ${msg.ok ? "" : "err"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</p> : null);

/** Brings the worker's pane to the front in your attached Herdr window. */
export function OpenInHerdr({ worker, className = "btn" }: { worker: string; className?: string }) {
  const a = useAction();
  return (
    <span className="ha">
      <button className={className} disabled={a.busy} onClick={() => a.run(async () => { await intent("focus", worker); return "Switched your Herdr window to this pane. No Herdr window open? The Terminal tab here shows the same pane."; })}>Open in Herdr</button>
      <Note msg={a.msg} />
    </span>
  );
}

/** Ends an agent running in a plain terminal and resumes the same conversation in Herdr. */
export function MoveToHerdr({ worker, title }: { worker: string; title?: string }) {
  const a = useAction();
  return (
    <span className="ha">
      <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => {
        if (!confirm(`Move ${title ?? "this agent"} into Herdr?\n\nJoyride ends the process in its current terminal (the conversation is kept) and resumes it in a Herdr tab at the same folder.`)) return;
        const r = await intent("move_to_herdr", worker);
        const id = workerIdFor(r);
        if (id) setTimeout(() => go(`worker/${encodeURIComponent(id)}`), 600);
        return "Moved. It is now running in Herdr.";
      })}>{a.busy ? "Moving…" : "Move to Herdr"}</button>
      <Note msg={a.msg} />
    </span>
  );
}

/** Reopens a past session (no live process) in a Herdr tab. */
export function ResumeInHerdr({ session, cwd, agent }: { session: string; cwd: string; agent: "claude" | "codex" }) {
  const a = useAction();
  const id = session.replace(/^(claude|codex):/, "");
  return (
    <span className="ha">
      <button className="btn" disabled={a.busy} onClick={() => a.run(async () => {
        const r = await intent("launch_session", cwd, { cwd, agent, resume: id, label: cwd.split("/").filter(Boolean).pop() });
        const w = workerIdFor(r);
        if (w) setTimeout(() => go(`worker/${encodeURIComponent(w)}`), 600);
        return "Resumed in Herdr.";
      })}>{a.busy ? "Resuming…" : "Resume in Herdr"}</button>
      <Note msg={a.msg} />
    </span>
  );
}
