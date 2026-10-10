// The resume command of a saved session record (artifact kind session), read
// from its snapshot. Cached per artifact so list rows don't refetch.
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { parseSavedSession, type SavedSession } from "./model";

const cache = new Map<string, Promise<SavedSession | null>>();
function load(id: string): Promise<SavedSession | null> {
  let p = cache.get(id);
  if (!p) {
    p = api<{ text: string }>(`/api/artifacts/${encodeURIComponent(id)}/text`).then((r) => parseSavedSession(r.text)).catch(() => null);
    cache.set(id, p);
  }
  return p;
}

export function useSavedSession(id: string | null) {
  const [saved, setSaved] = useState<SavedSession | null | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setSaved(undefined);
    load(id).then((s) => { if (live) setSaved(s); });
    return () => { live = false; };
  }, [id]);
  return saved;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn ghost kn-copy" onClick={async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked: the text stays selectable */ }
    }}>{done ? "Copied" : label}</button>
  );
}

/** One line in a list row: the command, selectable, with a copy button. */
export function ResumeLine({ id }: { id: string }) {
  const saved = useSavedSession(id);
  if (saved === undefined) return <span className="kn-resume quiet">Reading the resume command…</span>;
  if (!saved?.command) return <span className="kn-resume quiet">No resume command saved</span>;
  return (
    <span className="kn-resume" data-testid="resume-command" onClick={(e) => e.stopPropagation()}>
      <span className="k-mono" title={saved.command}>{saved.command}</span>
      <CopyButton text={saved.command} />
    </span>
  );
}

/** The saved session block at the top of its sheet. */
export function SavedSessionBlock({ id }: { id: string }) {
  const saved = useSavedSession(id);
  if (saved === undefined) return <p className="k-skeleton">Reading the saved session…</p>;
  if (!saved) return <p className="k-err">Could not read the saved session snapshot. Open the artifact below to check its file.</p>;
  return (
    <section className="kn-saved" data-testid="saved-session">
      <div className="k-label">Resume where it stopped</div>
      {saved.command ? (
        <div className="kn-cmd"><code data-testid="resume-command-full">{saved.command}</code><CopyButton text={saved.command} label="Copy command" /></div>
      ) : <p className="k-note">This record has no resume command.</p>}
      {saved.resume_context ? <p className="kn-saved-p">{saved.resume_context}</p> : null}
      {saved.work_done ? <><div className="k-label">What was done</div><p className="kn-saved-p">{saved.work_done}</p></> : null}
    </section>
  );
}
