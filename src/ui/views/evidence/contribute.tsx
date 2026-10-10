import type { Contribution } from "../../lib/registry";
import type { Route } from "../../lib/router";
import { go, href } from "../../lib/router";
import { timeAgo, useApi } from "../../lib/api";
import { EvidencePanel, type VerdictRec } from "./EvidencePanel";

/** #/evidence/<mission>: the evidence panel on its own page; #/evidence lists missions by verdict. */
function EvidencePage({ route }: { route: Route }) {
  const id = route.params[0] ?? null;
  const { data: mission, error } = useApi<any>(id ? `/api/missions/${encodeURIComponent(id)}` : null, ["missions"]);
  if (!id) return <EvidenceIndex />;
  return (
    <div className="k-page" style={{ maxWidth: 980 }} data-testid="evidence-page">
      <header className="k-head">
        <div>
          <div className="k-note"><a href={href(`mission/${id}`)}>Idea</a></div>
          <h1>{mission?.title ?? id}</h1>
          <p className="k-lede">Evidence and Jev's verdict against what “done” means for this idea.</p>
        </div>
      </header>
      {error ? <p className="k-err">{error}</p> : null}
      {mission?.done_when?.length ? (
        <div style={{ marginBottom: 24 }}>
          <div className="k-label">Done when</div>
          <ol className="k-md small" style={{ margin: 0 }}>{mission.done_when.map((c: any) => <li key={c.id}>{c.text} <span className="muted" style={{ fontFamily: "var(--font-ui)", fontSize: "var(--step--1)" }}>{c.kind}</span></li>)}</ol>
        </div>
      ) : null}
      <EvidencePanel mission={mission ?? null} missionId={id} />
    </div>
  );
}

function EvidenceIndex() {
  const { data: missions } = useApi<any[]>("/api/missions?archive=false", ["missions"]);
  const { data: verdicts } = useApi<VerdictRec[]>("/api/evidence/verdicts?limit=500", ["verdicts"]);
  const latest = new Map<string, VerdictRec>();
  for (const v of verdicts ?? []) if (!latest.has(v.mission)) latest.set(v.mission, v);
  return (
    <div className="k-page" style={{ maxWidth: 980 }}>
      <header className="k-head"><div><h1>Evidence</h1><p className="k-lede">The latest verdict for each open idea. Open one to see its checks and screenshots.</p></div></header>
      <ul className="k-list">
        {(missions ?? []).map((m) => {
          const v = latest.get(m.id);
          return (
            <li key={m.id}>
              <a className="k-row" href={href(`evidence/${m.id}`)}>
                <span className="k-kind">{v ? (v.verdict === "pass" ? "✓" : v.verdict === "fail" ? "✕" : "?") : "·"}</span>
                <span className="t">{m.title}</span>
                <span className="right">{v ? timeAgo(v.created) : "No verdict"}</span>
                <span className="sub"><span>{(m.done_when ?? []).length} criteria</span>{v ? <span className={`k-flag ${v.verdict}`}>{v.verdict === "insufficient" ? "Insufficient" : v.verdict === "pass" ? "Pass" : "Fail"}</span> : null}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function contribute(): Contribution {
  return {
    routes: [{ name: "evidence", component: EvidencePage }],
    missionPanels: [{ id: "evidence", title: "Evidence", order: 40, component: EvidencePanel }],
    commands: () => [{ id: "go-evidence", title: "Go to evidence and verdicts", group: "Navigate", keywords: "verdict jev checks screenshots", run: () => go("evidence") }],
  };
}
