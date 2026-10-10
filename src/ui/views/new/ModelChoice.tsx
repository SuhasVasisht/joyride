import { useApi } from "../../lib/api";
import type { LlmBackend } from "../../../shared/schema";

export type ModelAccount = { id: string; label: string; provider: string; source: string; models: { model: string; efforts: string[] }[] };
export function ModelChoice({ label, value, onChange }: { label: string; value: LlmBackend; onChange: (value: LlmBackend) => void }) {
  const listId = `models-${label.replace(/[^a-z0-9]+/gi, "-")}`;
  const { data } = useApi<ModelAccount[]>("/api/new/models", ["system", "usage"]);
  const accounts = (data ?? []).filter(a => a.provider === value.backend);
  const catalog = accounts.find(a => a.id === value.account) ?? (!value.account ? accounts[0] : undefined);
  return <div className="nb-model-choice">
    <label>Provider<select className="input" aria-label={`Provider for ${label}`} value={value.backend} onChange={e => onChange({ backend: e.target.value === "claude" ? "claude" : "codex", model: e.target.value === "claude" ? "sonnet" : "gpt-6-luna" })}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
    <label>Model<input className="input" aria-label={`Model for ${label}`} list={listId} value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} /><datalist id={listId}>{catalog?.models.map(m => <option key={m.model} value={m.model} />)}</datalist></label>
    <label>Account<select className="input" aria-label={`Account for ${label}`} value={value.account ?? ""} onChange={e => onChange({ ...value, account: e.target.value || undefined })}><option value="">First configured {value.backend} account</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}{value.account && !accounts.some(a => a.id === value.account) ? <option value={value.account}>{value.account} (unavailable)</option> : null}</select></label>
    <label>Reasoning effort<select className="input" aria-label={`Effort for ${label}`} value={value.effort ?? ""} onChange={e => onChange({ ...value, effort: e.target.value === "low" || e.target.value === "medium" || e.target.value === "high" || e.target.value === "xhigh" || e.target.value === "max" ? e.target.value : undefined })}><option value="">CLI default</option>{(catalog?.models.find(m => m.model === value.model)?.efforts ?? ["low", "medium", "high", "xhigh", "max"]).map(e => <option key={e} value={e}>{e}</option>)}</select></label>
  </div>;
}
