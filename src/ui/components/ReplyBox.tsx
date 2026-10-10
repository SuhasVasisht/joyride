// Reply in place: POST /api/intents {kind:"reply", target: workerId, payload:{text, images}}
// and follow the intent (sent → picked up, or failed with what to do next). Images are pasted,
// dropped or picked, uploaded at once, and go out as stored paths the agent attaches.
import { useCallback, useRef, useState } from "react";
import { useDraft } from "../lib/useDraft";
import { post, useApi } from "../lib/api";
import { CopyButton } from "./primitives";
import { AttachButton, AttachmentTray, DropZone, SentImages, useAttachments } from "./ImageAttach";
import { canSendImages, noImagesReason } from "../../shared/images";
import "./components.css";
import type { ReplyBinding } from "../../shared/schema";

type IntentRec = { id: string; status: "pending" | "sent" | "acked" | "failed"; error: string | null; result?: any; target: string; payload?: { text?: string; images?: string[] } };

export function ReplyBox({ worker, session, agent, attention, placeholder, rows = 1, label, onSent, autoFocus, staged, unavailable, binding }: {
  worker: string;
  session?: string | null;
  /** Under a chat log that shows staged replies: a refused reply moves up there (with Send again), so the box empties. */
  staged?: boolean;
  /** The worker's agent (claude, codex, …): images are offered only to agents that load them. Unknown: offered, and the daemon checks. */
  agent?: string | null;
  unavailable?: string | null;
  binding?: ReplyBinding;
  attention?: string; placeholder?: string; rows?: number; label?: string; onSent?: (it: IntentRec) => void; autoFocus?: boolean;
}) {
  const draft = useDraft({ kind: attention ? "ask" : "session", id: attention ?? session ?? worker });
  const { text, setText } = draft;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [first, setFirst] = useState<IntentRec | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const restoreBox = useCallback((el: HTMLTextAreaElement | null) => { box.current = el; draft.boxRef(el); }, [draft.boxRef]);
  const att = useAttachments(agent !== undefined && !canSendImages(agent) ? noImagesReason(agent) : null, draft.key);
  const { data: live } = useApi<IntentRec>(intentId ? `/api/intents/${encodeURIComponent(intentId)}` : null, ["intents"]);
  const intent = live && live.id === intentId ? live : first;

  const images = att.paths;
  const ready = Boolean(text.trim() || images.length) && !att.uploading && !att.failed;
  async function send() {
    const t = text.trim();
    if (!ready || busy || unavailable) return;
    setBusy(true); setErr(null);
    try {
      const it = await post<IntentRec>("/api/intents", { kind: "reply", target: worker, payload: { text: t, ...(binding ? { binding } : {}), ...(images.length ? { images } : {}), ...(attention ? { attention } : {}) } });
      setFirst(it); setIntentId(it.id);
      if (it.status !== "failed" || staged) { setText(""); att.clear(); if (box.current) box.current.style.height = ""; }
      if (it.status !== "failed") onSent?.(it);
    } catch (e: any) {
      setErr(`The reply was not sent: ${e.message}. Check that the daemon is running, then send it again.`);
    } finally { setBusy(false); }
  }

  const resume: string | undefined = intent?.status === "failed" ? intent.result?.resume?.command : undefined;
  return (
    <DropZone att={att} className="reply-box">
      {unavailable ? <p className="meta wp-reply-note" role="status">{unavailable}</p> : null}
      <AttachmentTray att={att} />
      <form className="reply-row" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <AttachButton att={att} />
        <textarea
          ref={restoreBox} className="input reply-input" rows={rows} value={text} autoFocus={autoFocus}
          aria-label={label ?? "Reply to this worker"} placeholder={placeholder ?? "Reply to the agent. Enter sends, Shift+Enter adds a line."}
          onChange={(e) => { setText(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 180)}px`; }}
          onPaste={att.onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
        />
        <button type="submit" className="btn primary" disabled={busy || !ready || Boolean(unavailable)}>{busy ? "Sending" : att.uploading ? "Uploading" : "Send"}</button>
      </form>
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
      {intent ? (
        <div className={`intent-status s-${intent.status}`} role="status" data-intent-status={intent.status}>
          {intent.status === "pending" && "Sending to the worker…"}
          {intent.status === "sent" && (intent.result?.queued ? "Queued. The agent is working, so it takes your reply when its current turn ends." : "Delivered. Waiting for the agent to pick it up.")}
          {intent.status === "acked" && "The agent picked up your reply."}
          {intent.status === "failed" && <span className="intent-error">{staged ? "Not sent. The message above says why, with Send again." : intent.error ?? "The reply failed."}</span>}
          {intent.status !== "failed" && intent.result?.cleared ? <span className="intent-note"> The agent's input box already held other text; Joyride cleared it first, so only your reply went in.</span> : null}
          {intent.status !== "failed" && intent.payload?.images?.length ? <SentImages paths={intent.payload.images} className="small" /> : null}
          {resume ? (
            <div className="resume-cmd">
              <code>{resume}</code>
              <CopyButton text={resume} label="Copy resume command" />
            </div>
          ) : null}
        </div>
      ) : null}
    </DropZone>
  );
}
