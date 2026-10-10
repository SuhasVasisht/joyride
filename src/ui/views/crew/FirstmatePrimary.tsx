import { useState } from "react";
import type { PrimaryStatus } from "../../../shared/firstmate-primary";
import { post } from "../../lib/api";
import type { IntentRec } from "./crew";

export function FirstmatePrimary({ primary, running, idle, reload, controls = true }: { primary?: PrimaryStatus; running: boolean; idle: boolean; reload(): void; controls?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!primary) return null;
  const changing = busy || ["handoff", "stopping", "starting"].includes(primary.phase);
  async function switchTo(account: string) {
    if (!account) return;
    setBusy(true); setError(null);
    try {
      const r = await post<IntentRec>("/api/firstmate/switch", { account });
      if (r.status === "failed") setError(r.error ?? "Firstmate did not switch.");
      reload();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="fm-primary" data-testid="firstmate-primary" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
    {primary.current ? <p className="meta" data-testid="firstmate-account">{primary.current.label} · {primary.current.harness}{primary.current.model ? ` · ${primary.current.model}` : ""}</p> : null}
    {primary.lastSwitch ? <p className="meta" data-testid="firstmate-switch-reason">{primary.lastSwitch.reason}</p> : null}
    {changing ? <p className="meta" role="status">Handing off Firstmate. Its home and workers are preserved.</p> : null}
    {controls && running ? <label className="meta">Switch Firstmate to <select className="input" aria-label="Switch Firstmate to" value="" disabled={changing} onChange={(e) => void switchTo(e.target.value)}>
      <option value="">Choose account</option>
      {primary.choices.filter((p) => p.account !== primary.current?.account).map((p) => <option key={p.account} value={p.account} disabled={!p.available || (p.harness === "claude" && !idle)}>{p.label}{!p.available ? " (capacity unknown or exhausted)" : p.harness === "claude" && !idle ? " (available when idle)" : ""}</option>)}
    </select></label> : null}
    {primary.returnToClaude ? <p className="meta">Claude Code has capacity again.{idle ? " You can switch back now." : " Switch back when Firstmate is idle."}</p> : null}
    {error || primary.error ? <p className="inline-error" role="alert">{error ?? primary.error}</p> : null}
  </div>;
}
