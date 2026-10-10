// The conversation as a chat: your prompts on the right, the agent's messages
// as markdown on the left, tool calls folded into one-line chips that expand.
// Newest at the bottom; it follows new messages while you are at the bottom and
// offers a jump back when you have scrolled up. Live: it re-reads the transcript
// when the daemon reports a change to this session.
// With a worker, replies sent from Joyride that the agent hasn't taken yet follow
// the transcript as staged messages (queued, refused, never taken), until the
// transcript shows them as normal prompts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, onChange, post, useApi } from "../lib/api";
import { Markdown, markdownImages } from "./Markdown";
import { TimeAgo, plural } from "./primitives";
import { SentImages } from "./ImageAttach";
import { imageMarkers, matchReplies } from "../../shared/replies";
import type { ReplyBinding } from "../../shared/schema";
import type { Turn } from "../../modules/sessions/types";
export type { Turn } from "../../modules/sessions/types";
import "./chat.css";

export type Step = { kind: "text"; text: string } | { kind: "tool"; name: string; summary: string };

/** Transcript turns for a session, re-read (throttled) when that session changes. */
export function useTranscript(key: string | null, limit: number) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!key) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await api<{ turns: Turn[] }>(`/api/sessions/${encodeURIComponent(key)}/transcript?limit=${limit}`);
      if (my === seq.current) { setTurns(r.turns); setError(null); }
    } catch (e: any) { if (my === seq.current) setError(e.message); }
    finally { if (my === seq.current) setLoading(false); }
  }, [key, limit]);
  useEffect(() => { setTurns(null); }, [key]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!key) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    const kick = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { last = Date.now(); load(); }, Math.max(120, 800 - (Date.now() - last)));
    };
    const off = onChange((c: any) => {
      // A relay result can supply image paths after the transcript was first read.
      if (c.entity === "*" || c.entity === "intents") return kick();
      if (c.entity !== "sessions") return;
      const keys: string[] | undefined = c.data?.keys;
      if (c.id ? c.id === key : !keys || keys.includes(key)) kick();
    });
    return () => { off(); if (t) clearTimeout(t); };
  }, [key, load]);
  return { turns, error, loading, reload: load };
}

type Piece = { kind: "text"; text: string } | { kind: "tools"; tools: { name: string; summary: string }[] };
/** Ordered steps (or, for older readers, text then tools) grouped into text blocks and tool runs. */
function piecesOf(t: Turn): Piece[] {
  const steps: Step[] = t.steps?.length ? t.steps : [...(t.text ? [{ kind: "text", text: t.text } as Step] : []), ...t.tools.map((x) => ({ kind: "tool", ...x }) as Step)];
  const out: Piece[] = [];
  for (const s of steps) {
    const last = out[out.length - 1];
    if (s.kind === "tool") { if (last?.kind === "tools") last.tools.push(s); else out.push({ kind: "tools", tools: [s] }); }
    else out.push({ kind: "text", text: s.text });
  }
  return out;
}

/** Paths under the agent's folder read shorter in a chip: "/repo/src/x.ts" becomes "src/x.ts". */
function relative(summary: string, root: string | undefined) {
  if (!root) return summary;
  const r = root.endsWith("/") ? root : root + "/";
  return summary.split(r).join("");
}

function ToolChip({ name, summary, root }: { name: string; summary: string; root?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tool-chip${open ? " open" : ""}`} data-tool={name}>
      <button type="button" className="tc" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? "Fold" : summary || name}>
        <span className="tc-name">{name}</span>
        {summary ? <code className="tc-sum">{relative(summary, root)}</code> : null}
      </button>
      {open ? <pre className="tc-full">{summary || "No details recorded for this call."}</pre> : null}
    </li>
  );
}

/** Up to three calls show as chips; a longer run folds into one line that opens to its chips. */
function ToolRun({ tools, more, root }: { tools: { name: string; summary: string }[]; more?: number; root?: string }) {
  const chips = <ul className="tool-chips">{tools.map((x, i) => <ToolChip key={i} {...x} root={root} />)}{more ? <li className="tc-more">and {more} more</li> : null}</ul>;
  if (tools.length <= 3 && !more) return chips;
  const names = [...new Set(tools.map((x) => x.name))];
  return (
    <details className="tool-run">
      <summary><span className="tr-count">{plural(tools.length + (more ?? 0), "tool call")}</span><span className="tr-names">{names.slice(0, 5).join(", ")}{names.length > 5 ? ", …" : ""}</span></summary>
      {chips}
    </details>
  );
}

const normImageText = (s: string) => s.replace(/\[Image(?:\s*#\d+)?\]\s*/gi, "").trim();
const LONG_USER = 1400;
function UserMessage({ t }: { t: Turn }) {
  const [open, setOpen] = useState(false);
  // With the images shown, the agent's "[Image #1]" placeholders only repeat them.
  const paths = [...(t.images ?? [])];
  while (paths.length < imageMarkers(t.text)) paths.push("");
  const text = normImageText(t.text);
  const long = text.length > LONG_USER;
  return (
    <li className="msg r-user" data-role="user">
      <div className="msg-bubble">
        {text ? <Markdown text={long && !open ? text.slice(0, LONG_USER).trimEnd() + "…" : text} /> : null}
        <SentImages paths={paths} />
        {long ? <button type="button" className="btn link msg-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Fold it again" : `Show all of it (${Math.round(text.length / 100) / 10}k characters)`}</button> : null}
      </div>
      <div className="msg-meta">You{t.ts ? <> <TimeAgo iso={t.ts} /></> : null}</div>
    </li>
  );
}

function AgentMessage({ t, agent, root }: { t: Turn; agent: string; root?: string }) {
  const pieces = piecesOf(t);
  const images = pieces.flatMap((p) => p.kind === "text" ? markdownImages(p.text) : []);
  return (
    <li className="msg r-assistant" data-role="assistant">
      <div className="msg-meta">{agent}{t.ts ? <> <TimeAgo iso={t.ts} /></> : null}</div>
      <div className="msg-body">
        {pieces.map((p, i) => p.kind === "text"
          ? <Markdown key={i} text={p.text} className="msg-text" images={images} />
          : <ToolRun key={i} tools={p.tools} root={root} more={i === pieces.length - 1 ? (t.more_steps ?? (t.steps ? 0 : t.more_tools)) || undefined : undefined} />)}
        <SentImages paths={t.images} />
        {!pieces.length && !t.images?.length ? <p className="meta">Thinking…</p> : null}
      </div>
    </li>
  );
}

export type StagedReply = {
  id: string; text: string; images: string[]; created: string;
  state: "sending" | "queued" | "delivered" | "pulled" | "unclaimed" | "failed"; error: string | null; cleared: string | null;
  binding?: ReplyBinding;
};

/** Text as the agents echo it (mirrors live/staged.ts), to hide a staged reply the moment its turn arrives. */

function stagedNote(r: StagedReply, agent: string): ReactNode {
  switch (r.state) {
    case "sending": return "Sending…";
    case "queued": return `Queued. ${agent} takes it when its current turn ends.`;
    case "delivered": return `Delivered. Waiting for ${agent} to pick it up.`;
    case "pulled": return `Back in ${agent}'s input box: the Up arrow (or an interrupt) took it out of the queue, so it won't go out on its own. Press Enter in the terminal to queue it again, or send it again here.`;
    case "unclaimed": return `${agent} never took this message. Its queue or input box may have been cleared. Send it again, or dismiss it.`;
    case "failed": return <>Not sent. {r.error}</>;
  }
}

function StagedMessage({ r, agent, worker }: { r: StagedReply; agent: string; worker: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stuck = r.state === "failed" || r.state === "unclaimed" || r.state === "pulled";
  const dismiss = async () => {
    setErr(null);
    try { await post(`/api/intents/${encodeURIComponent(r.id)}/dismiss`, {}); }
    catch (e: any) { setErr(`Could not dismiss it: ${e.message}`); }
  };
  const again = async () => {
    setBusy(true); setErr(null);
    try {
      const sent = await post<{ status: string; error: string | null }>("/api/intents", { kind: "reply", target: worker, payload: { text: r.text, ...(r.binding ? { binding: r.binding } : {}), ...(r.images.length ? { images: r.images } : {}) } });
      if (sent.status === "failed") setErr(sent.error ?? "The reply was not sent.");
      else await post(`/api/intents/${encodeURIComponent(r.id)}/dismiss`, {});
    } catch (e: any) { setErr(`Could not send it again: ${e.message}. Check that the daemon is running.`); }
    finally { setBusy(false); }
  };
  return (
    <li className={`msg r-staged s-${r.state}`} data-role="user" data-staged={r.state} data-intent={r.id}>
      <div className="msg-bubble">
        {normImageText(r.text) ? <Markdown text={normImageText(r.text)} /> : null}
        <SentImages paths={r.images} />
      </div>
      <div className="msg-meta staged-note" role={stuck ? "alert" : "status"}>
        <span className="staged-label">{stagedNote(r, agent)}</span>
        {r.cleared && !stuck ? <span> Joyride cleared other text from its input box first.</span> : null}
        <TimeAgo iso={r.created} />
      </div>
      {stuck ? (
        <div className="row staged-actions">
          {r.state !== "pulled" || r.text ? <button type="button" className="btn small" disabled={busy} onClick={again}>{busy ? "Sending" : "Send again"}</button> : null}
          <button type="button" className="btn ghost small" onClick={dismiss}>Dismiss</button>
        </div>
      ) : null}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </li>
  );
}

export function ChatLog({ sessionKey, worker, agent = "Agent", root, tail, footer, empty, initialLimit = 40, className }: {
  sessionKey: string | null;
  /** The live worker whose replies from Joyride show as staged messages until the agent takes them. */
  worker?: string | null;
  agent?: string;
  /** The agent's folder: tool chips show paths relative to it. */
  root?: string | null;
  /** Rendered after the last message (a prompt waiting for an answer). */
  tail?: ReactNode;
  /** Pinned under the log (the reply box). */
  footer?: ReactNode;
  /** Shown when there is no session or nothing in it yet. */
  empty?: ReactNode;
  initialLimit?: number;
  className?: string;
}) {
  const [limit, setLimit] = useState(initialLimit);
  const { turns, error, loading } = useTranscript(sessionKey, limit);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const [unseen, setUnseen] = useState(false);
  const shown = useMemo(() => (turns ?? []).filter((t) => t.text.trim() || t.tools.length || t.steps?.length || t.images?.length), [turns]);
  const { data: stagedData } = useApi<{ staged: StagedReply[] }>(worker ? `/api/workers/${encodeURIComponent(worker)}/staged` : null, ["intents", "sessions", "workers"]);
  const staged = useMemo(() => {
    const replies = stagedData?.staged ?? [];
    const consumed = new Set(matchReplies(replies.filter((r) => r.state !== "failed" && r.state !== "sending"), shown).map((m) => m.id));
    return replies.filter((r) => !consumed.has(r.id));
  }, [stagedData, shown]);
  const sig = `${shown.length}:${shown[shown.length - 1]?.text.length ?? 0}:${shown[shown.length - 1]?.steps?.length ?? shown[shown.length - 1]?.tools.length ?? 0}:${tail ? 1 : 0}:${staged.map((r) => r.state).join(",")}`;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (prevHeight.current != null) { el.scrollTop += el.scrollHeight - prevHeight.current; prevHeight.current = null; return; } // kept your place after loading earlier turns
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [sig]);
  useEffect(() => { stick.current = true; setUnseen(false); }, [sessionKey]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    if (stick.current && unseen) setUnseen(false);
  };
  const jump = () => { const el = box.current; if (el) { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); stick.current = true; setUnseen(false); } };

  return (
    <div className={`chat${className ? ` ${className}` : ""}`} data-chat={sessionKey ?? ""}>
      <div className="chat-main">
      <div className="chat-log" ref={box} onScroll={onScroll} aria-label="Conversation">
        {error && !turns ? <p className="inline-error">The conversation can't be read: {error}. The transcript may have moved; reindex sessions and try again.</p> : null}
        {turns && turns.length >= limit ? (
          <button type="button" className="btn small chat-earlier" disabled={loading} onClick={() => { stick.current = false; prevHeight.current = box.current?.scrollHeight ?? null; setLimit((l) => l * 3); }}>
            {loading ? "Loading earlier messages" : "Load earlier messages"}
          </button>
        ) : null}
        {(!sessionKey || (turns && !shown.length)) && !staged.length ? <div className="chat-empty">{empty ?? <p className="meta">Nothing said yet.</p>}</div> : null}
        {sessionKey && !turns && !error ? <p className="meta chat-loading" aria-busy="true">Reading the conversation…</p> : null}
        <ol className="chat-turns">
          {shown.map((t, i) => t.role === "user" ? <UserMessage key={i} t={t} /> : <AgentMessage key={i} t={t} agent={agent} root={root ?? undefined} />)}
          {worker ? staged.map((r) => <StagedMessage key={r.id} r={r} agent={agent} worker={worker} />) : null}
          {tail ? <li className="msg r-tail">{tail}</li> : null}
        </ol>
      </div>
      {unseen ? <button type="button" className="btn small chat-jump" onClick={jump}>New messages below</button> : null}
      </div>
      {footer ? <div className="chat-footer">{footer}</div> : null}
    </div>
  );
}
