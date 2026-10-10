// Small shared primitives. Other features may import these read-only.
import { Component, useEffect, useState, type ReactNode } from "react";
import { timeAgo } from "../lib/api";
import "./components.css";

/** Re-render every `ms` (shared clock for countdowns and relative times). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(i); }, [ms]);
  return now;
}

export function TimeAgo({ iso, prefix = "" }: { iso?: string | null; prefix?: string }) {
  useNow(30_000);
  if (!iso) return null;
  const d = new Date(iso);
  return <time className="time-ago" dateTime={iso} title={d.toLocaleString()}>{prefix}{timeAgo(iso)}</time>;
}

const STATE_CLASS: Record<string, string> = {
  working: "working", active: "working", blocked: "blocked", "needs-review": "review", review: "review",
  done: "done", pass: "pass", fail: "fail", insufficient: "idle", idle: "idle", unknown: "unknown", exited: "exited",
  open: "working", paused: "idle", dropped: "idle", pending: "idle", sent: "working", acked: "pass", failed: "fail",
  accepted: "pass", rejected: "idle", allow: "pass", deny: "fail", timeout: "idle",
};
const STATE_LABEL: Record<string, string> = { "needs-review": "Needs review", acked: "Picked up", insufficient: "Not enough evidence" };
export const stateLabel = (s: string) => STATE_LABEL[s] ?? (s ? s[0].toUpperCase() + s.slice(1) : "");

/** A state chip: colour encodes state only. */
export function StateChip({ state, label, plain, title }: { state: string; label?: string; plain?: boolean; title?: string }) {
  return <span className={`chip ${STATE_CLASS[state] ?? "idle"}${plain ? " plain" : ""}`} data-state={state} title={title}>{label ?? stateLabel(state)}</span>;
}

/** Attention level badge (L0–L4); L3/L4 carry the signal colour. */
export function LevelBadge({ level, quiet }: { level: string; quiet?: boolean }) {
  const n = Number(level?.slice(1) ?? 0);
  const cls = quiet ? "quiet" : n >= 3 ? "signal" : n === 2 ? "review" : "quiet";
  const title = ["Ambient", "Digest", "Review", "Blocked on you", "Urgent"][n] ?? level;
  return <span className={`level-badge ${cls}`} title={title}>{level}</span>;
}

export function Kbd({ children }: { children: ReactNode }) { return <kbd>{children}</kbd>; }

/** An empty state that invites the next step instead of apologising. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn small" onClick={async () => {
      try { await navigator.clipboard.writeText(text); } catch {
        const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch {} ta.remove();
      }
      setDone(true); setTimeout(() => setDone(false), 1600);
    }}>{done ? "Copied" : label}</button>
  );
}

/** Keeps one broken panel (possibly from another feature) from blanking the page. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <p className="inline-error" role="alert">{this.props.label ?? "This section"} failed to render: {this.state.error.message}. Reload the page; if it keeps failing, check the daemon log.</p>;
    return this.props.children;
  }
}

/** Shortened path for display: ~/… for the home dir, last segments otherwise. */
export function shortPath(p: string | null | undefined, keep = 3) {
  if (!p) return "";
  const home = p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  const parts = home.split("/");
  return parts.length > keep + 1 ? "…/" + parts.slice(-keep).join("/") : home;
}

export function plural(n: number, one: string, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }

export function duration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}
