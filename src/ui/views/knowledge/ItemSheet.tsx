import { useMemo } from "react";
import { useApi, timeAgo } from "../../lib/api";
import { href } from "../../lib/router";
import { Sheet } from "../../components/Sheet";
import type { KnowledgeItem, KnowledgeRef, KnowledgeRelations } from "../../../shared/knowledge";
import { ArtifactDetail } from "../artifacts/ArtifactsPage";
import { isSavedSession, kindLabel, kindMark, refKey } from "./model";
import { Markdown } from "../../components/Markdown";
import type { Note } from "../../components/notes/notes";
import { SavedSessionBlock } from "./Resume";

type Target = KnowledgeRef | { entity: string; id: string };
type Group = { label: string; targets: Target[] };

function relationGroups(data: KnowledgeRelations): Group[] {
  const self = data.item.key;
  const groups: Record<string, Target[]> = {};
  const add = (label: string, t: Target) => { (groups[label] ??= []).push(t); };
  for (const r of data.relations) {
    const fromSelf = refKey(r.from) === self, toSelf = refKey(r.to) === self;
    switch (r.kind) {
      case "derived-from": if (fromSelf) add("Drawn from", r.to); else if (toSelf) add("Led to", r.from); break;
      case "supersedes": if (fromSelf) add("Replaces", r.to); else if (toSelf) add("Replaced by", r.from); break;
      case "answered-by": if (fromSelf) add("Answered by", r.to); else if (toSelf) add("Answers", r.from); break;
      case "anchored-to": if (fromSelf) add("Anchored to", r.to); break;
    }
  }
  const order = ["Drawn from", "Led to", "Answered by", "Answers", "Replaces", "Replaced by", "Anchored to"];
  return order.filter((l) => groups[l]?.length).map((label) => ({ label, targets: [...new Map(groups[label].map((t) => [refKey(t), t])).values()] }));
}

const ANCHOR_WORD: Record<string, string> = { idea: "Idea", task: "Task", session: "Session", repo: "Repo", group: "Group" };
function anchorHref(t: Target): string | null {
  switch (t.entity) {
    case "idea": return href(`mission/${encodeURIComponent(t.id)}`);
    case "session": return href(`session/${encodeURIComponent(t.id)}`);
    case "task": return href(`task/${encodeURIComponent(t.id)}`);
    default: return null;
  }
}

function RelationRow({ t, item, anchorTitle, onOpen }: { t: Target; item?: KnowledgeItem; anchorTitle?: string; onOpen: (key: string) => void }) {
  if (item) {
    return (
      <li><button type="button" className="kn-rel" onClick={() => onOpen(item.key)} data-testid="relation-item">
        <span className="k-kind" data-kind={item.kind} aria-hidden>{kindMark(item.kind)}</span>
        <span className="kn-rel-kind">{kindLabel(item.kind)}</span>
        <span className="t">{item.title}</span>
        <span className="when">{timeAgo(item.updated)}</span>
      </button></li>
    );
  }
  const link = anchorHref(t);
  const label = <><span className="kn-rel-kind">{ANCHOR_WORD[t.entity] ?? t.entity}</span><span className="t">{anchorTitle ?? t.id}</span></>;
  return <li>{link ? <a className="kn-rel" href={link}><span className="k-kind" aria-hidden>↳</span>{label}</a> : <span className="kn-rel"><span className="k-kind" aria-hidden>↳</span>{label}</span>}</li>;
}

function NoteDetail({ id }: { id: string }) {
  const { data, error } = useApi<Note>(`/api/notes/${encodeURIComponent(id)}`, ["notes"]);
  if (error) return <p className="k-err">Could not read this note. Refresh the Board and try again.</p>;
  if (!data) return <p className="k-skeleton">Loading note…</p>;
  return <article className="k-detail sheet" data-testid="note-detail">
    <div className="k-meta"><span className="k-tag">Note</span><span className="k-flag">{data.status === "archived" ? "Archived" : "Active"}</span></div>
    <h2>{data.title}</h2>
    <Markdown text={data.body} />
  </article>;
}

export function ItemSheet({ target, onClose, onOpen }: { target: KnowledgeRef; onClose: () => void; onOpen: (key: string) => void }) {
  const path = `/api/knowledge/relations?entity=${target.entity}&id=${encodeURIComponent(target.id)}`;
  const { data, error } = useApi<KnowledgeRelations>(path, ["knowledge"]);
  const byKey = useMemo(() => new Map((data?.items ?? []).map((i) => [i.key, i])), [data]);
  const groups = data ? relationGroups(data) : [];
  const anchorTitles = new Map((data?.item.anchors ?? []).map((a) => [`${a.kind}:${a.id}`, a.title]));
  const item = data?.item;
  return (
    <Sheet label={item ? item.title : "Knowledge item"} onClose={onClose}>
      <div className="kn-sheet" data-testid="knowledge-sheet">
        {target.entity === "artifact" && item && isSavedSession(item) ? <SavedSessionBlock id={target.id} /> : null}
        <section className="kn-relations" data-testid="relations" aria-label="Relations">
          <h3>Relations</h3>
          {error ? <p className="k-err">{error}</p> : !data ? <p className="k-skeleton">Loading relations…</p>
            : groups.length ? groups.map((g) => (
              <div key={g.label} className="kn-rel-group">
                <div className="k-label">{g.label}</div>
                <ul>{g.targets.map((t) => <RelationRow key={refKey(t)} t={t} item={byKey.get(refKey(t))} anchorTitle={anchorTitles.get(refKey(t))} onOpen={onOpen} />)}</ul>
              </div>
            ))
            : <p className="k-note">Nothing links to this yet. Link it to an idea, task or session.</p>}
          {data?.notices.length ? <p className="k-note">{data.notices.join(" ")}</p> : null}
        </section>
        {item?.kind === "note" && item.state === "active" ? (
          <div className="k-actions kn-board-open"><a className="btn primary" href={item.href} data-testid="open-on-board">Open on the board</a><span className="k-note">Tick, edit or move it there, or show it on the map.</span></div>
        ) : null}
        {target.entity === "note" ? <NoteDetail id={target.id} />
          : target.entity === "artifact" ? <ArtifactDetail id={target.id} />
          : item ? (
            <article className="k-detail sheet">
              <div className="k-meta"><span className="k-tag">{kindMark(item.kind)} {kindLabel(item.kind)}</span><span className="k-flag">{item.state === "archived" ? "Archived" : "Active"}</span></div>
              <h2>{item.title}</h2>
              {item.summary ? <p className="kn-saved-p">{item.summary}</p> : null}
              <div className="k-actions"><a className="btn primary" href={item.href}>Open {item.kind === "idea" ? "idea" : item.kind === "task" ? "task" : "session"}</a></div>
            </article>
          ) : null}
      </div>
    </Sheet>
  );
}
