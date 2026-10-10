import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import type { Config } from "../../../shared/schema";
import { ModelChoice } from "../new/ModelChoice";

export function NewModels({ value, reload }: { value: Config["new_models"]; reload: () => void }) {
  const [models, setModels] = useState(value);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const baseline = useRef(value);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = value;
    setModels(current => JSON.stringify(current) === JSON.stringify(previous) ? value : current);
  }, [value]);
  const dirty = JSON.stringify(models) !== JSON.stringify(value);
  return <form className="st-new-models" aria-label="New models" onSubmit={async e => {
    e.preventDefault(); setSaving(true); setMessage(null);
    try { await api("/api/system/config", { method: "PUT", json: { new_models: models } }); setMessage("Saved. New requests use these models."); reload(); }
    catch (e) { setMessage(`Not saved: ${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  }}>
    <h3>New requests</h3><p className="meta">Choose who interprets New, who runs small jobs, and who starts your standalone repo sessions. These roles keep their own defaults.</p>
    <fieldset><legend>New routing and judgment</legend>
      <label>Judge<select className="input" aria-label="Judge for New routing" value={models.routing.backend} onChange={e => setModels({ ...models, routing: e.target.value === "jev" ? { backend: "jev" } : { backend: e.target.value === "claude" ? "claude" : "codex", model: e.target.value === "claude" ? "sonnet" : "gpt-6-luna" } })}><option value="jev">Jev</option><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
      {models.routing.backend === "jev" ? <label>Jev model<input className="input" aria-label="Model for New routing" value={models.routing.model ?? ""} placeholder="Use the Jev model above" onChange={e => setModels({ ...models, routing: { backend: "jev", model: e.target.value || undefined } })} /></label> : <ModelChoice label="New routing" value={models.routing} onChange={routing => setModels({ ...models, routing })} />}
      <p className="meta">Explicit standalone requests launch directly, even when the judge is unavailable.</p>
    </fieldset>
    <fieldset><legend>Small New jobs</legend><ModelChoice label="small New jobs" value={models.small_job} onChange={small_job => setModels({ ...models, small_job })} /></fieldset>
    <fieldset><legend>Standalone repo sessions</legend><ModelChoice label="standalone sessions" value={models.standalone} onChange={standalone => setModels({ ...models, standalone })} /></fieldset>
    <div className="row"><button className="btn primary" disabled={saving || !dirty}>{saving ? "Saving…" : "Save New model settings"}</button>{dirty ? <button className="btn ghost" type="button" onClick={() => setModels(value)}>Undo changes</button> : null}</div>
    {message ? <p role="status">{message}</p> : null}
  </form>;
}
