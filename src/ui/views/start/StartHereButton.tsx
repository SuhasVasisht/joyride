import { useState } from "react";
import { post } from "../../lib/api";
import { go } from "../../lib/router";
import type { SessionHere } from "../../../shared/session-here";

export function StartHereButton({ context, className = "btn small", stop = false }: {
  context: SessionHere; className?: string; stop?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  async function start(e: React.MouseEvent) {
    if (stop) e.stopPropagation();
    setBusy(true); setError(null);
    try {
      const r = await post<{ status: string; error: string | null; result?: { worker: string; warning?: string } }>("/api/intents", {
        kind: "launch_session", target: context.kind === "project" ? context.cwd ?? "" : context.id, payload: { here: context },
      });
      if (r.status === "failed") throw new Error(r.error ?? "The session could not start. Try again.");
      if (r.result?.warning) { setError(r.result.warning); setStarted(r.result.worker); return; }
      go(r.result?.worker ? `worker/${encodeURIComponent(r.result.worker)}` : "agents");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <>
    {started ? <a className={className} href={`#/worker/${encodeURIComponent(started)}`}>Open session</a> : <button type="button" className={className} disabled={busy} onClick={start}
      onPointerDown={stop ? e => e.stopPropagation() : undefined} data-session-here={`${context.kind}:${context.kind === "project" ? context.title : context.id}`}
      title="Start Claude Code with this goal, the idea's notes and linked artifacts">
      {busy ? "Starting…" : "Start a session here"}
    </button>}
    {error ? <span className="inline-error" role="alert">{error}</span> : null}
  </>;
}
