// Mission panel "evidence": the latest Jev verdict against done_when (per
// criterion, with the caption downgrade note) and every evidence record,
// attested or inferred, with exit codes, assertions and screenshots.
import { useEffect, useState } from "react";
import { api, post, timeAgo, useApi } from "../../lib/api";
import { href } from "../../lib/router";
import { plural, useAction } from "../knowledge/ui";
import "../knowledge/knowledge.css";

type Shot = { blob: string; name: string; caption: string | null };
export type Evidence = {
  id: string; mode: "attested" | "inferred"; name: string; command: string; exit_code: number | null; log_tail: string; log_blob: string | null;
  screenshots: Shot[]; assertions: { passed: number; failed: number; skipped: number } | null; claim: string; session: string | null;
  mission: string | null; cwd: string; branch: string | null; sha: string | null; created: string;
};
type Crit = { id: string; criterion: string; kind: string; verdict: "pass" | "fail" | "insufficient"; p?: number; reason: string; captions?: string[]; caption_p?: number | null };
export type VerdictRec = { id: string; mission: string; verdict: "pass" | "fail" | "insufficient"; probabilities: Record<string, number>; confidence: number | null; per_criterion: Crit[]; downgraded_by_caption: boolean; evidence: string[]; created: string; reason?: string };

const WORD = { pass: "Pass", fail: "Fail", insufficient: "Insufficient evidence" } as const;
const MARK = { pass: "✓", fail: "✕", insufficient: "?" } as const;
const blobUrl = (sha: string) => `/api/evidence/blob/${sha}`;
/** Records shown before "Show older"; long-running missions collect dozens. */
const PAGE = 10;
/** Screenshot names and captions carry the recording path; people only need the file name. */
const tidy = (s: string) => s.replace(/(?:\.{1,2}\/)*(?:\/?[\w@.+-]+\/)+([\w@.+-]+\.(?:png|jpe?g|gif|webp))/gi, "$1");

export function EvidencePanel({ mission, missionId }: { mission: any; missionId: string }) {
  const { data: m } = useApi<any>(mission ? null : `/api/missions/${encodeURIComponent(missionId)}`, ["missions"]);
  const ms = mission ?? m;
  const { data: evidence, error } = useApi<Evidence[]>(`/api/evidence?mission=${encodeURIComponent(missionId)}`, ["evidence"]);
  const { data: verdict } = useApi<VerdictRec | null>(`/api/evidence/verdict/${encodeURIComponent(missionId)}`, ["verdicts", "evidence"]);
  const [box, setBox] = useState<{ shots: (Shot & { from: string })[]; i: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<"all" | "attested" | "inferred">("all");
  const [more, setMore] = useState(false);
  const ask = useAction(async () => { await post(`/api/evidence/verdict/${encodeURIComponent(missionId)}`, {}); setNote(null); });
  const reverify = useAction(async () => {
    const it = await post<any>("/api/intents", { kind: "reverify", target: missionId, payload: { mission: missionId } });
    if (it.status === "failed") throw new Error(it.error ?? "The re-verify intent failed.");
    setNote(`Re-verify sent as intent ${it.id}.`);
  });
  const allShots = (evidence ?? []).flatMap((e) => e.screenshots.map((s) => ({ ...s, from: e.name })));
  const filtered = (evidence ?? []).filter((e) => mode === "all" || e.mode === mode);
  const shown = more ? filtered : filtered.slice(0, PAGE);
  const criteria: any[] = ms?.done_when ?? [];

  return (
    <div className="k-panel" data-testid="evidence-panel">
      <VerdictBlock v={verdict ?? null} criteria={criteria} />
      <div className="k-panel-actions">
        <button className="btn primary" disabled={ask.busy || reverify.busy} onClick={() => ask.run()}>{ask.busy ? <><span className="k-spin" /> Asking Jev…</> : "Ask Jev for a verdict"}</button>
        <button className="btn" disabled={ask.busy || reverify.busy} onClick={() => reverify.run()}>{reverify.busy ? "Re-verifying…" : "Re-verify"}</button>
        {note ? <span className="k-note">{note}</span> : null}
        {ask.error || reverify.error ? <span className="k-err">{ask.error ?? reverify.error}</span> : null}
      </div>

      <div className="k-ev-head">
        <div className="k-label">Evidence <span className="muted" style={{ fontWeight: 400 }}>{evidence ? evidence.length : ""}</span></div>
        {evidence && evidence.length > PAGE ? (
          <div className="k-seg" role="group" aria-label="Show evidence">
            {(["all", "attested", "inferred"] as const).map((k) => (
              <button key={k} type="button" className={mode === k ? "on" : ""} aria-pressed={mode === k} onClick={() => { setMode(k); setMore(false); }}>
                {k === "all" ? "All" : k === "attested" ? "Attested" : "Inferred"} {k === "all" ? evidence.length : evidence.filter((e) => e.mode === k).length}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <p className="k-err">Could not load evidence: {error}</p> : null}
      {evidence && !evidence.length ? <p className="k-note">No evidence yet. Agents record it with <code>joyride-evidence run --name &lt;check&gt; -- &lt;command&gt;</code>; test runs in transcripts are picked up as inferred evidence.</p> : null}
      <ul className="k-ev">
        {shown.map((e) => (
          <li key={e.id} data-testid="evidence-item">
            <div className="top">
              <span className={`k-flag ${e.mode === "attested" ? "solid" : "dashed"}`} title={e.mode === "attested" ? "Recorded by joyride-evidence while the check ran" : "Mined from a transcript; not attested"}>{e.mode === "attested" ? "Attested" : "Inferred"}</span>
              <span className="name">{e.name}</span>
              <Exit code={e.exit_code} />
              {e.assertions ? <Asserts a={e.assertions} /> : null}
              <span className="spacer" style={{ flex: 1 }} />
              <span className="k-note">{e.session ? <a href={href(`session/${encodeURIComponent(e.session)}`)}>{timeAgo(e.created)}</a> : timeAgo(e.created)}</span>
            </div>
            {e.claim ? <div className="k-md small" style={{ marginTop: 4 }}>{e.claim}</div> : null}
            {e.command ? <div className="cmd">$ {e.command}</div> : null}
            {e.screenshots.length ? (
              <div className="k-thumbs">
                {e.screenshots.map((s) => (
                  <button key={s.blob + s.name} className="k-thumb" title={tidy(s.caption ?? s.name)} aria-label={`Open screenshot ${tidy(s.name)}`}
                    onClick={() => setBox({ shots: allShots, i: Math.max(0, allShots.findIndex((x) => x.blob === s.blob && x.from === e.name)) })}>
                    <img src={blobUrl(s.blob)} alt={tidy(s.name)} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : null}
            {e.log_tail ? <details className="k-log"><summary>Log tail{e.log_blob ? <> (<a href={blobUrl(e.log_blob)} target="_blank" rel="noreferrer">full log</a>)</> : null}</summary><pre>{e.log_tail}</pre></details> : null}
          </li>
        ))}
      </ul>
      {filtered.length > shown.length ? <button type="button" className="btn link k-ev-more" onClick={() => setMore(true)}>Show {filtered.length - shown.length} older records</button> : null}
      {box ? <Lightbox shots={box.shots} start={box.i} onClose={() => setBox(null)} /> : null}
    </div>
  );
}

function VerdictBlock({ v, criteria }: { v: VerdictRec | null; criteria: any[] }) {
  if (!v) return (
    <div className="k-verdict" data-testid="verdict">
      <div className="word" style={{ color: "var(--ink-2)" }}>No verdict yet</div>
      <div className="k-note">{criteria.length ? `${plural(criteria.length, "done-when criterion", "done-when criteria")} to judge.` : "This idea has no done-when criteria, so a verdict can only be insufficient."}</div>
    </div>
  );
  const conf = v.confidence != null ? `, confidence ${Math.round(v.confidence * 100)}%` : "";
  return (
    <div className={`k-verdict ${v.verdict}`} data-testid="verdict">
      <div className="word">{WORD[v.verdict]}</div>
      <div className="k-note">Jev judged {plural(v.evidence.length, "record")} against {plural(v.per_criterion.length, "criterion", "criteria")} {timeAgo(v.created)}{conf}.{v.reason ? ` ${v.reason[0].toUpperCase()}${v.reason.slice(1)}.` : ""}</div>
      {v.per_criterion.length ? (
        <ul className="k-crit">
          {v.per_criterion.map((c) => (
            <li key={c.id}>
              <span className={`mark ${c.verdict}`} aria-label={WORD[c.verdict]}>{MARK[c.verdict]}</span>
              <span>
                <span style={{ color: "var(--ink)" }}>{c.criterion}</span>
                <div className="reason">{c.reason}</div>
                {c.captions?.length && /caption/i.test(c.reason) ? <div className="reason" style={{ fontStyle: "italic" }}>Caption of {tidy(c.captions[0])}</div> : null}
              </span>
              <span className="k-note">{c.p != null ? `${Math.round(c.p * 100)}%` : ""}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {v.downgraded_by_caption ? <p className="k-downgrade" data-testid="downgrade-note">A screenshot caption contradicted a passing check, so the pass was downgraded to insufficient. Captions can only lower a verdict, never raise it.</p> : null}
    </div>
  );
}

function Exit({ code }: { code: number | null }) {
  if (code == null) return <span className="k-exit">exit unknown</span>;
  return <span className={`k-exit ${code === 0 ? "ok" : "bad"}`}>exit {code}</span>;
}
function Asserts({ a }: { a: { passed: number; failed: number; skipped: number } }) {
  return <span className="k-asserts">{a.passed} passed{a.failed ? <>, <span className="f">{a.failed} failed</span></> : ", 0 failed"}{a.skipped ? `, ${a.skipped} skipped` : ""}</span>;
}

export function Lightbox({ shots, start, onClose }: { shots: (Shot & { from: string })[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "ArrowRight") setI((x) => Math.min(x + 1, shots.length - 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(x - 1, 0));
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [shots.length, onClose]);
  const s = shots[i];
  if (!s) return null;
  return (
    <div className="k-lightbox" role="dialog" aria-label={`Screenshot ${tidy(s.name)}`} onClick={onClose} data-testid="lightbox">
      <img src={blobUrl(s.blob)} alt={tidy(s.name)} onClick={(e) => e.stopPropagation()} />
      <div className="cap">{tidy(s.name)}, from {s.from}{shots.length > 1 ? ` (${i + 1} of ${shots.length})` : ""}{s.caption ? <div style={{ marginTop: 4, opacity: 0.85 }}>{tidy(s.caption)}</div> : null}</div>
      <button className="btn close" onClick={onClose}>Close</button>
    </div>
  );
}

export async function latestVerdict(missionId: string) { return api<VerdictRec | null>(`/api/evidence/verdict/${encodeURIComponent(missionId)}`); }
