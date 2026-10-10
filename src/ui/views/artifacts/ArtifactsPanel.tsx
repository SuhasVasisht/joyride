// Mission panel "artifacts": what this mission produced, with its summary.
import { timeAgo, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import { KIND_LABEL, StatusPill, kindMark, openLabel, type ArtifactView } from "./ArtifactsPage";

export function ArtifactsPanel({ missionId }: { mission: any; missionId: string }) {
  const { data, error } = useApi<ArtifactView[]>(`/api/artifacts?mission=${encodeURIComponent(missionId)}`, ["artifacts"]);
  if (error) return <p className="k-err">Could not load artifacts: {error}</p>;
  if (!data) return <p className="k-skeleton">Loading…</p>;
  return (
    <div className="k-panel" data-testid="artifacts-panel">
      {!data.length ? <p className="k-note">No artifacts linked yet. Pages a session publishes and PRs it links show up here; you can also <a href={href("artifacts?register=1")}>register one</a>.</p> : null}
      <ul className="k-list">{data.map((a) => <Row key={a.id} a={a} />)}</ul>
    </div>
  );
}

function Row({ a }: { a: ArtifactView }) {
  const open = openLabel(a);
  return (
    <li className="k-row" style={{ cursor: "default" }}>
      <span className="k-kind">{kindMark(a.kind)}</span>
      <a className="t" href={href(`artifacts/${a.id}`)}>{a.title}</a>
      <span className="k-actions" style={{ gridRow: "1 / 3", gridColumn: 3, alignSelf: "center" }}>
        {open ? <a className="btn ghost" href={a.url!} target="_blank" rel="noreferrer">{open}</a> : null}
      </span>
      {a.summary ? <span className="one" style={{ gridColumn: 2 }}>{a.summary}</span> : null}
      <span className="sub" style={{ gridColumn: 2 }}>
        <span>{a.firstmate ? "Firstmate report" : KIND_LABEL[a.kind]}</span><span>{timeAgo(a.firstmate?.modified ?? a.created)}</span>
        <StatusPill a={a} />
      </span>
    </li>
  );
}

/** Registered outputs remain discoverable beside the conversation, regardless of source. */
export function SessionArtifacts({ session }: { session: string }) {
  const { data } = useApi<ArtifactView[]>(`/api/artifacts?session=${encodeURIComponent(session)}`, ["artifacts"]);
  if (!data?.length) return null;
  return <nav className="row" aria-label="Session artifacts" style={{ flexWrap: "wrap" }}>
    {data.map(a => <a className="btn" key={a.id} href={href(`artifacts/${encodeURIComponent(a.id)}`)}>{a.title}</a>)}
  </nav>;
}
