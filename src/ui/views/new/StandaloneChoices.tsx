import { useState } from "react";
import type { StandaloneChoice, StandaloneOffer, SessionPlacement } from "../../../shared/freeform";
import { ModelChoice } from "./ModelChoice";

export function StandaloneChoices({ offer, busy, launch }: { offer: StandaloneOffer; busy: boolean; launch: (choice: StandaloneChoice) => void }) {
  const [cwd, setCwd] = useState(offer.cwd ?? "");
  const [placement, setPlacement] = useState<SessionPlacement | null>(offer.placement);
  const [title, setTitle] = useState(offer.placement?.kind === "new" ? offer.placement.title : "Deep work");
  const [model, setModel] = useState(offer.model);
  return <div className="nb-session-choices" data-standalone-choices>
    <p>Your own session</p>
    <label>Repo folder<input className="input" aria-label="Standalone repo folder" list="standalone-repos" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="Choose or enter an absolute repo path" /><datalist id="standalone-repos">{offer.repos.map(p => <option value={p} key={p} />)}</datalist></label>
    <label>Canvas group<select className="input" aria-label="Standalone canvas group" value={placement?.kind === "new" ? "new" : placement?.id ?? ""} onChange={e => { const group = offer.groups.find(g => g.id === e.target.value); setPlacement(e.target.value === "new" ? { kind: "new", title } : group ? { kind: "group", ...group } : null); }}><option value="">Choose a group</option><option value="new">A new group for this session</option>{offer.groups.map(g => <option value={g.id} key={g.id}>{g.title}</option>)}</select></label>
    {placement?.kind === "new" ? <label>Group name<input className="input" aria-label="Standalone group name" value={title} onChange={e => { setTitle(e.target.value); setPlacement({ kind: "new", title: e.target.value }); }} /></label> : null}
    <details><summary>Model and account</summary><ModelChoice label="this session" value={model} onChange={setModel} /></details>
    <button className="btn primary small" disabled={busy || !cwd.trim() || !placement || placement.kind === "new" && !placement.title.trim()} onClick={() => { if (placement) launch({ cwd: cwd.trim(), placement, model }); }}>{busy ? "Starting…" : "Start my session"}</button>
  </div>;
}
