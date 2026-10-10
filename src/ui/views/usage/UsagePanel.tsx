// Subscription usage: one card per configured account (Claude Code, each Codex login, Cursor) with
// its windows, how much is used, and when each resets. Claude and Codex show their five-hour and
// weekly windows plus any model-specific window the provider reported. Cursor shows the two buckets
// from its Plan & Usage screen. A compact version sits in the rail; the full page (#/usage) adds
// pace, plan, folder, overflow notes and a refresh button.
import { useState } from "react";
import { api, useApi } from "../../lib/api";
import { go } from "../../lib/router";
import { CopyButton, StateChip, TimeAgo, useNow } from "../../components/primitives";
import { InlineMd } from "../../components/InlineMd";
import type { ProviderUsage, UsageSnapshot, UsageWindow } from "../../../shared/usage";
import { limitResetPhrase, localReset, planLabel, relReset, stateInfo, tone, usedPct } from "./format";

/** The report, re-read when the daemon's minute cache turns over. */
export function useUsage() {
  return useApi<UsageSnapshot>("/api/usage", ["usage"], { pollMs: 60_000 });
}

const PACE: Record<string, string> = { ahead: "Using faster than the clock", on_pace: "On pace", behind: "Using slower than the clock" };
const FIXED_SLOTS = new Set(["five_hour", "weekly"]);

function WindowRow({ w, now, full, cycle }: { w: UsageWindow; now: number; full?: boolean; cycle?: string | null }) {
  if (!w.reported) {
    return (
      <div className="us-win none" data-window={w.slot}>
        <div className="us-win-head"><span className="us-span">{w.label}</span><span className="us-pct meta">Not reported</span></div>
        {full && w.note ? <p className="us-note">{w.note}</p> : null}
      </div>
    );
  }
  const pct = usedPct(w);
  const left = w.percentRemaining == null ? null : Math.round(w.percentRemaining);
  // The plan line already states this reset. A second relative clock uses a different day count.
  const ownReset = !(cycle && w.resetsAt === cycle);
  const reset = w.resetsAt ? `${localReset(w.resetsAt, now)} · ${relReset(w.resetsAt, now)}` : w.resetText ?? "Reset time not reported";
  const bar = (
    <div className="us-bar" role="meter" aria-label={`${w.label} window used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <span style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
  // The rail keeps each window to one line and a bar, so every account fits above Needs you.
  if (!full) {
    return (
      <div className={`us-win compact tone-${tone(pct)}`} data-window={w.slot}>
        <div className="us-win-head">
          <span className="us-span">{w.label}</span>
          <span className="us-pct">{pct == null ? "Usage not reported" : <><strong>{pct}%</strong> used</>}</span>
          {ownReset ? <time className="us-rel meta" dateTime={w.resetsAt ?? undefined} title={w.resetsAt ? `Resets ${reset}` : undefined}>{w.resetsAt ? relReset(w.resetsAt, now) : w.resetText ?? ""}</time> : null}
        </div>
        {w.detail ? <p className="us-detail">{w.detail}</p> : null}
        {bar}
      </div>
    );
  }
  return (
    <div className={`us-win tone-${tone(pct)}`} data-window={w.slot}>
      <div className="us-win-head">
        <span className="us-span">{w.label}</span>
        {full && w.kind && !FIXED_SLOTS.has(w.slot) ? <span className="meta">{w.kind}</span> : null}
        <span className="us-pct">{pct == null ? "Usage not reported" : <><strong>{pct}%</strong> used{left != null ? <span className="meta"> · {left}% left</span> : null}</>}</span>
      </div>
      {full && w.detail ? <p className="us-detail">{w.detail}</p> : null}
      {bar}
      {ownReset || w.pace ? <div className="us-reset meta">
        {ownReset ? <span>Resets <time dateTime={w.resetsAt ?? undefined} title={w.resetsAt ? new Date(w.resetsAt).toLocaleString() : undefined}>{reset}</time></span> : null}
        {w.pace ? <span className="us-pace">{PACE[w.pace]}</span> : null}
      </div> : null}
      {full && w.note ? <p className="us-note">{w.note}</p> : null}
    </div>
  );
}

/** Cursor states one reset for the plan buckets. Grok Bot has its own weekly reset. */
function sharedReset(windows: UsageWindow[]): string | null {
  const times = windows.filter((w) => w.reported && (w.slot === "cursor_models" || w.slot === "other_models") && w.resetsAt).map((w) => w.resetsAt);
  if (!times.length || times.some((t) => t !== times[0])) return null;
  return times[0]!;
}

export function ProviderCard({ p, now, full }: { p: ProviderUsage; now: number; full?: boolean }) {
  const s = stateInfo(p.state);
  const plan = planLabel(p.plan);
  const cycle = p.provider === "cursor" ? sharedReset(p.windows) : null;
  return (
    <article className={`us-card state-${p.state}`} data-account={p.account} data-provider={p.provider} data-state={p.state} aria-label={`${p.title} usage`}>
      <header className="us-card-head">
        <h4>{p.title}</h4>
        {(full || p.provider === "cursor") && plan ? <span className="meta us-plan">{plan}</span> : null}
        <StateChip state={s.chip} label={s.label} />
      </header>
      {cycle ? <p className="us-cycle meta">{limitResetPhrase(cycle, now)}</p> : null}
      {full && p.home ? <p className="meta us-home">Login folder <code>{p.home}</code></p> : null}
      {p.windows.map((w) => <WindowRow key={w.slot} w={w} now={now} full={full} cycle={cycle} />)}
      {p.message ? <p className="us-msg"><InlineMd text={p.message} /></p> : null}
      {p.remedy ? <div className="us-cmd"><code>{p.remedy}</code><CopyButton text={p.remedy} label="Copy command" /></div> : null}
    </article>
  );
}

/** Rail section on the dashboard. */
export function UsageRail() {
  const { data, error } = useUsage();
  const now = useNow(30_000);
  return (
    <section className="rail-sec usage-rail" data-rail="usage" aria-labelledby="rail-usage">
      <h3 id="rail-usage">Usage limits <button className="btn link rail-action" onClick={() => go("usage")}>Details</button></h3>
      {error ? <p className="inline-error" role="alert">Usage limits can't load: {error}.</p>
        : !data?.fetchedAt ? <p className="meta">Reading usage limits…</p>
        : <div className="us-cards">{data.providers.map((p) => <ProviderCard key={p.account} p={p} now={now} />)}</div>}
      {data?.fetchedAt ? <p className="meta" data-testid="usage-age">Read <TimeAgo iso={data.generatedAt ?? data.fetchedAt} />{data.refreshing ? "; refreshing…" : ""}</p> : null}
    </section>
  );
}

/** Full page (#/usage). */
export function UsagePage() {
  const { data, error, setData } = useUsage();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true); setRefreshError(null);
    try { setData(await api<UsageSnapshot>("/api/usage?fresh=1")); } catch (e: any) { setRefreshError(e.message); } finally { setBusy(false); }
  };
  return (
    <article className="pane-page usage-page" data-testid="usage-page">
      <header className="mp-header">
        <h1 className="mp-title">Usage limits</h1>
        <p className="us-lede">How much of each account's allowance is used, and when each one resets: Claude Code's five-hour and weekly windows, including any model-specific window, Codex's weekly window, and Cursor's Cursor Models and Other Models, plus Grok Bot when that weekly meter is reported. Add accounts under <code>usage.accounts</code> in <code>joyride.config.yaml</code>. Read by <code>quota-axi</code> on this Mac; Joyride never reads your provider logins itself.</p>
        <div className="row us-toolbar">
          <button className="btn" onClick={refresh} disabled={busy || data?.refreshing}>{busy || data?.refreshing ? "Refreshing…" : "Refresh now"}</button>
          {data?.fetchedAt ? <span className="meta" data-testid="usage-age">Read <TimeAgo iso={data.generatedAt ?? data.fetchedAt} />; {data.refreshing ? "refreshing in the background…" : `checked every ${Math.round(data.maxAgeSeconds)} seconds.`}</span> : null}
        </div>
        {refreshError ? <p className="inline-error" role="alert">Refresh failed: {refreshError}.</p> : null}
      </header>
      {error ? <p className="inline-error" role="alert">Usage limits can't load: {error}. Start the daemon with <code>./bin/joyride up</code>, then reload.</p>
        : !data?.fetchedAt ? <p className="meta">Reading usage limits…</p>
        : <div className="us-cards full">{data.providers.map((p) => <ProviderCard key={p.account} p={p} now={now} full />)}</div>}
    </article>
  );
}
