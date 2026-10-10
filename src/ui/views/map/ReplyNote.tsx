// Firstmate's reply to a captain request filed from the map (fm-inbox.sh reply), on the card the request
// became: its task, else its idea, else the Firstmate hub. Mid zoom shows one line; near zoom the reply and
// a Dismiss that hides it for good (POST /api/firstmate/requests/:id/dismiss).
import { useState } from "react";
import { post } from "../../lib/api";
import { TimeAgo } from "../../components/primitives";
import type { ZoomLevel } from "./layout";
import type { MapReply } from "./plane";

function ReplyNote({ r, level }: { r: MapReply; level: ZoomLevel }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const asked = r.text ? `You asked: ${r.text}` : undefined;
  if (level === "mid") {
    return (
      <p className="fm-reply line" data-reply={r.request} title={asked ? `${asked}\n\nFirstmate: ${r.reply.body}` : r.reply.body}>
        <span className="fm-reply-k">Firstmate replied</span> {r.reply.body}
      </p>
    );
  }
  async function dismiss() {
    setBusy(true); setErr(null);
    try { await post(`/api/firstmate/requests/${encodeURIComponent(r.request)}/dismiss`); }
    catch (e: any) { setErr(`Could not dismiss the reply: ${e.message}. Try again.`); setBusy(false); }
  }
  return (
    <aside className="fm-reply" data-reply={r.request} aria-label="Firstmate's reply" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <p className="fm-reply-head">
        <span className="fm-reply-k">Firstmate replied</span>
        {r.reply.at ? <span className="meta"><TimeAgo iso={r.reply.at} /></span> : null}
        <span className="spacer" />
        <button type="button" className="btn link small" onClick={dismiss} disabled={busy} aria-label="Dismiss Firstmate's reply">Dismiss</button>
      </p>
      <p className="fm-reply-body">{r.reply.body}</p>
      {r.text ? <p className="fm-reply-asked meta" title={r.text}>{asked}</p> : null}
      {err ? <p className="inline-error" role="alert">{err}</p> : null}
    </aside>
  );
}

export function Replies({ list, level }: { list: MapReply[] | undefined; level: ZoomLevel }) {
  if (!list?.length || level === "far") return null;
  return <>{list.map((r) => <ReplyNote key={r.request} r={r} level={level} />)}</>;
}
