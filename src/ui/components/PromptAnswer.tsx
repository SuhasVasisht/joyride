// Answer a prompt an agent shows in its terminal (a permission menu, a y/n
// question) from anywhere: read the visible screen through Herdr, offer the
// options that are actually there, and send the key with an answer_prompt intent.
import { useDraft } from "../lib/useDraft";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { post, useApi } from "../lib/api";
import "./components.css";

type Choice = "allow" | "allow_always" | "deny";
type Screen = { screen: string; controllable: boolean; options?: Record<Choice, string | null>; error?: string };
type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: { picked?: string | null; keys?: string[] } };

const FRAME = /^[\s╭╮╰╯─━┌┐└┘│┃|]*$/;
/** The visible screen without the box-drawing frame, so it reads at any width. */
export function tidyScreen(screen: string, max = 12): string[] {
  const out: string[] = [];
  for (const raw of screen.replace(/\r/g, "").split("\n")) {
    if (raw.trim() && FRAME.test(raw)) continue;
    const line = raw.replace(/^\s*[│┃]\s?/, "").replace(/\s*[│┃]\s*$/, "").replace(/\s+$/, "");
    if (!line && (!out.length || !out[out.length - 1])) continue;
    out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.slice(-max);
}

/** "Yes, and don't ask again for npm test commands in alpha" -> "npm test commands in alpha" */
export function alwaysScope(label: string): string {
  const m = label.match(/(?:don.?t ask again|always allow|remember)\s*(?:for|this)?\s*(.*)$/i);
  return (m?.[1] ?? "").replace(/\s*\(.*?\)\s*$/, "").trim();
}

const parseKeys = (s: string) => s.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);

export function PromptAnswer({ worker, name, attention, compact = false, onAnswered }: { worker: string; name?: string; attention?: string; compact?: boolean; onAnswered?: () => void }) {
  const { data, error, reload } = useApi<Screen>(`/api/workers/${encodeURIComponent(worker)}/screen`, ["workers"], { pollMs: 5000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [intent, setIntent] = useState<IntentRec | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [keys, setKeys] = useState("");
  const draft = useDraft({ kind: "prompt", id: attention ?? worker });
  const { text: note, setText: setNote } = draft;
  const lines = useMemo(() => tidyScreen(data?.screen ?? "", compact ? 9 : 12), [data?.screen, compact]);
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [lines]); // the prompt is at the bottom
  const opts = data?.options ?? { allow: null, allow_always: null, deny: null };
  const hasMenu = Boolean(opts.allow || opts.allow_always || opts.deny);

  async function answer(key: string, payload: Record<string, unknown>) {
    setBusy(key); setErr(null);
    onAnswered?.(); // the worker may unblock before this request returns; keep this view mounted
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "answer_prompt", target: worker, payload: { ...payload, ...(note.trim() ? { text: note.trim() } : {}), ...(attention ? { attention } : {}) } });
      setIntent(it);
      if (it.status !== "failed") { setNote(""); setKeys(""); setTimeout(reload, 600); }
    } catch (e: any) {
      setErr(`The answer was not sent: ${e.message}. Check that the daemon is running, then try again.`);
    } finally { setBusy(null); }
  }

  if (error && !data) return <p className="inline-error" role="alert">Joyride can't read this agent's screen: {error}. Open its pane in Herdr to answer it.</p>;
  if (data?.error) return <p className="meta">{data.error}</p>;
  const who = name || "the agent";
  const scope = opts.allow_always ? alwaysScope(opts.allow_always) : "";
  return (
    <div className={`prompt-answer${compact ? " compact" : ""}`} data-prompt-answer={worker}>
      {data ? (
        lines.length ? (
          <pre ref={pre} className="pa-screen" aria-label={`What ${who} shows in its terminal`}>
            {lines.map((l, i) => <span key={i} className={/^\s*[❯›>]\s*\d[.)]/.test(l) ? "pa-sel" : undefined}>{l || " "}{"\n"}</span>)}
          </pre>
        ) : <p className="meta">The terminal is empty right now. If the agent is still stuck, send keys or open its pane in Herdr.</p>
      ) : <p className="meta" aria-busy="true">Reading its terminal…</p>}
      {data && !hasMenu && !intent ? <p className="meta pa-nomenu">Joyride doesn't recognise a menu on this screen. Send the keys it needs, or answer it in its Herdr pane.</p> : null}
      {data ? (
        <div className="pa-actions" role="group" aria-label={`Answer ${who}'s prompt`}>
          {opts.allow ? <button type="button" className="btn primary" disabled={!!busy} title={`Picks “${opts.allow}”`} onClick={() => answer("allow", { choice: "allow" })}>{busy === "allow" ? "Allowing" : "Allow"}</button> : null}
          {opts.allow_always ? (
            <button type="button" className="btn pa-always" disabled={!!busy} title={`Picks “${opts.allow_always}”`} onClick={() => answer("allow_always", { choice: "allow_always" })}>
              <span>{busy === "allow_always" ? "Allowing" : `Always allow${scope ? ` ${scope}` : ""}`}</span>
            </button>
          ) : null}
          {opts.deny ? <button type="button" className="btn" disabled={!!busy} title={`Picks “${opts.deny}”`} onClick={() => answer("deny", { choice: "deny" })}>{busy === "deny" ? "Denying" : "Deny"}</button> : null}
          {!keysOpen ? <button type="button" className={hasMenu ? "btn link pa-keys-toggle" : "btn"} onClick={() => setKeysOpen(true)}>Send keys</button> : null}
        </div>
      ) : null}
      {!compact && hasMenu ? (
        <label className="pa-note">
          <span>Then tell {who} (optional)</span>
          <input ref={draft.boxRef} className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Typed after your choice, for example: run only the export tests" />
        </label>
      ) : null}
      {keysOpen ? (
        <form className="pa-keys" onSubmit={(e) => { e.preventDefault(); const k = parseKeys(keys); if (k.length) answer("keys", { keys: k }); }}>
          <input className="input" value={keys} onChange={(e) => setKeys(e.target.value)} aria-label={`Keys to send to ${who}`} placeholder="Keys, for example: 2, or esc, or y enter" />
          <button type="submit" className="btn" disabled={!!busy || !parseKeys(keys).length}>{busy === "keys" ? "Sending" : "Send keys"}</button>
        </form>
      ) : null}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
      {intent ? (
        <p className={`intent-status s-${intent.status}`} role="status" data-answer-status={intent.status}>
          {intent.status === "failed"
            ? <span className="intent-error">{intent.error ?? "The answer failed."}</span>
            : <>Sent {intent.result?.picked ? `“${intent.result.picked}”` : `keys ${(intent.result?.keys ?? []).join(" ")}`}. {intent.status === "acked" ? "The agent picked it up." : "Waiting for the agent to move on."}</>}
        </p>
      ) : null}
    </div>
  );
}
