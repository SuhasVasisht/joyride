// Artifacts: the knowledge home. Everything agents produced (Firstmate's
// reports, Claude and ChatGPT pages, PRs, local files) on shelves by kind,
// filtered by project and date and grouped into link cards.
// ArtifactOverlay opens cached reports for reading before this details view.
// Details retain metadata, source previews and explicit original/review links.
// Route: #/artifacts/<id?>?shelf=<shelf>.
import { useEffect, useMemo, useState } from "react";
import type { Route } from "../../lib/router";
import { go, href } from "../../lib/router";
import { api, post, timeAgo, useApi } from "../../lib/api";
import { Markdown, SearchBox, Seg, plural, useAction } from "../knowledge/ui";
import { readArtifact } from "./ArtifactOverlay";

export type ArtifactView = import("../../../modules/artifacts/index.ts").ArtifactView;
type FirstmateOrigin = NonNullable<ArtifactView["firstmate"]>;

export const KIND_LABEL: Record<string, string> = { "claude-artifact": "Claude artifact", chatgpt: "ChatGPT", pr: "Pull request", report: "Report", file: "File", other: "Link" };
const VIA: Record<string, string> = { "artifact-tool": "Published with the Artifact tool", transcript: "Found in a transcript", manual: "Registered by hand", firstmate: "Firstmate report" };
const MARK: Record<string, string> = { pr: "⌥", chatgpt: "◐", "claude-artifact": "◈", report: "▤", file: "▢", other: "↗" };
export const kindMark = (kind: string) => MARK[kind] ?? "▤";

export function openLabel(a: Pick<ArtifactView, "kind" | "url">) {
  if (!a.url) return null;
  if (isLavishReview(a.url)) return "Review in Lavish";
  if (a.kind === "claude-artifact") return "Open in Claude";
  if (a.kind === "chatgpt") return "Open in ChatGPT";
  if (a.kind === "pr") return a.url.includes("bitbucket.org") ? "Open on Bitbucket" : "Open on GitHub";
  return "Open link";
}

export const isLavishReview = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/session\/[a-f0-9]+$/i.test(url);

// ---------- status, dates, shelves ----------
type Tone = "signal" | "working" | "review" | "plain" | "quiet";
const FM_STATUS: Record<FirstmateOrigin["status"], [string, Tone]> = {
  "decision-open": ["Decision open", "signal"], applying: ["Being applied", "working"], applied: ["Applied", "review"],
  decided: ["Decided", "review"], reported: ["Reported", "plain"], "in-progress": ["In progress", "working"],
};
export function artifactStatus(a: Pick<ArtifactView, "firstmate" | "private">): [string, Tone] {
  if (a.private) return ["Private", "quiet"];
  if (a.firstmate) return FM_STATUS[a.firstmate.status] ?? ["Reported", "plain"];
  return ["Registered", "quiet"];
}
export function StatusPill({ a }: { a: Pick<ArtifactView, "firstmate" | "private"> }) {
  const [label, tone] = artifactStatus(a);
  return <span className={`k-pill ${tone}`} data-testid="artifact-status">{label}</span>;
}
const dateOf = (a: ArtifactView) => a.firstmate?.modified ?? a.created;
const DAY = 864e5;
function bucket(iso: string): [number, string] {
  const t = new Date(iso).getTime();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (t >= start.getTime()) return [0, "Today"];
  if (t >= start.getTime() - DAY) return [1, "Yesterday"];
  if (t >= start.getTime() - 6 * DAY) return [2, "This week"];
  if (t >= start.getTime() - 29 * DAY) return [3, "This month"];
  return [4, "Earlier"];
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
/** First sentence of the summary, or the Firstmate task's title. */
function oneLine(a: ArtifactView): string {
  const s = (a.summary || "").replace(/\s+/g, " ").trim();
  if (s) return s.match(/^.+?[.!?](\s|$)/)?.[0].trim() ?? s;
  if (a.firstmate?.task_title) return a.firstmate.task_title;
  return "";;
}

type Shelf = "all" | "reports" | "pages" | "prs" | "chats" | "files";
const SHELF_OF: Record<string, Shelf> = { report: "reports", "claude-artifact": "pages", other: "pages", pr: "prs", chatgpt: "chats", file: "files" };
const SHELF_LABEL: Record<Shelf, string> = { all: "Everything", reports: "Reports", pages: "Pages", prs: "Pull requests", chats: "Chats", files: "Files" };
type When = "any" | "7d" | "30d";
type Group = "date" | "project" | "kind";
const GROUP_KEY = "joyride:artifacts-group";

function useMissions() {
  const { data } = useApi<any[]>("/api/missions", ["missions"]);
  return useMemo(() => new Map((data ?? []).map((m) => [m.id as string, m])), [data]);
}
export function ArtifactsPage({ route }: { route: Route }) {
  const id = route.params[0] ?? null;
  const { data, error, loading } = useApi<ArtifactView[]>("/api/artifacts", ["artifacts"]);
  const missions = useMissions();
  const [shelf, setShelf] = useState<Shelf>(() => (route.query.get("shelf") as Shelf) || "all");
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const [when, setWhen] = useState<When>("any");
  const [group, setGroupState] = useState<Group>(() => { try { return (localStorage.getItem(GROUP_KEY) as Group) || "date"; } catch { return "date"; } });
  const setGroup = (g: Group) => { setGroupState(g); try { localStorage.setItem(GROUP_KEY, g); } catch { /* per-viewer only */ } };
  const [adding, setAdding] = useState(route.query.get("register") === "1");
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const scan = useAction(async () => {
    const [r, f] = await Promise.all([post<any>("/api/artifacts/scan"), post<any>("/api/artifacts/firstmate/scan").catch(() => null)]);
    setScanMsg(r.error ? r.error : `Scanned ${plural(r.scanned, "transcript")}: ${r.created} new, ${r.updated} updated.${f ? ` Firstmate: ${plural(f.reports, "report")}, ${f.created} new.` : ""}`);
  });
  useEffect(() => { if (route.query.get("register") === "1") setAdding(true); }, [route.raw]);
  useEffect(() => { const s = route.query.get("shelf") as Shelf | null; if (s && s in SHELF_LABEL) setShelf(s); }, [route.raw]);

  const all = data ?? [];
  const projects = useMemo(() => [...new Set(all.flatMap(a => a.project ? [a.project] : []))].sort(), [all]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const since = when === "7d" ? Date.now() - 7 * DAY : when === "30d" ? Date.now() - 30 * DAY : 0;
  const artifacts = all.filter((a) => (!project || a.project === project) && new Date(dateOf(a)).getTime() >= since &&
    words.every((w) => `${a.title} ${a.summary} ${a.url ?? ""} ${a.local_source ?? ""} ${a.project ?? ""} ${a.firstmate?.task ?? ""} ${a.session_title ?? ""}`.toLowerCase().includes(w)));
  const count = (s: Shelf) => s === "all" ? artifacts.length : artifacts.filter(a => SHELF_OF[a.kind] === s).length;
  const shelves: Shelf[] = ["all", "reports", "pages", "prs", "chats", ...(all.some(a => a.kind === "file") ? ["files" as Shelf] : [])];
  const shown = shelf === "all" ? artifacts : artifacts.filter((a) => SHELF_OF[a.kind] === shelf);
  const open = all.filter((a) => a.firstmate?.status === "decision-open");
  const reports = all.filter((a) => a.firstmate).length;

  const groups = useMemo(() => {
    const m = new Map<string, { order: string; label: string; items: ArtifactView[] }>();
    for (const a of [...shown].sort((x, y) => dateOf(y).localeCompare(dateOf(x)))) {
      let order: string, label: string;
      if (group === "date") { const [n, l] = bucket(dateOf(a)); order = String(n); label = l; }
      else if (group === "project") { order = a.project ? `0${a.project}` : "1"; label = a.project ?? "No project"; }
      else { const sh = SHELF_OF[a.kind] ?? "pages"; order = String(Object.keys(SHELF_LABEL).indexOf(sh)); label = SHELF_LABEL[sh]; }
      if (!m.has(label)) m.set(label, { order, label, items: [] });
      m.get(label)!.items.push(a);
    }
    return [...m.values()].sort((a, b) => a.order.localeCompare(b.order));
  }, [shown, group]);

  return (
    <div className="k-page" data-testid="artifacts-page">
      <header className="k-head">
        <div>
          <h1>Artifacts</h1>
          <p className="k-lede">
            {data ? <>
              <strong>{plural(all.length, "artifact")}</strong> from your agents{reports ? <>, <strong>{plural(reports, "Firstmate report")}</strong> among them</> : null}.
            </> : "Loading the registry…"}
          </p>
        </div>
        <span className="spacer" />
        <div className="k-actions">
          <button className="btn" onClick={() => scan.run()} disabled={scan.busy}>{scan.busy ? "Scanning…" : "Scan for new artifacts"}</button>
          <button className="btn primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>Register an artifact</button>
        </div>
      </header>
      {scanMsg || scan.error ? <p className={scan.error ? "k-err" : "k-note"} style={{ marginTop: -8, marginBottom: 12 }}>{scan.error ?? scanMsg}</p> : null}
      {adding ? <RegisterForm onDone={(a) => { setAdding(false); if (a) go(`artifacts/${a.id}`); }} /> : null}
      {open.length ? (
        <div className="k-callout" data-testid="decisions-open">
          <span className="k-pill signal">{open.length === 1 ? "Decision open" : `${open.length} decisions open`}</span>
          <span>Firstmate is holding {open.length === 1 ? "a decision" : "decisions"} for you on {open.map((a, i) => <span key={a.id}>{i ? ", " : ""}<a href={href(`artifacts/${a.id}`)}>{a.title}</a></span>)}.</span>
        </div>
      ) : null}

      <nav className="k-tabs k-shelf-tabs" aria-label="Shelves">
        {shelves.map((s) => (
          <a key={s} href={href(`artifacts${id ? `/${id}` : ""}?shelf=${s}`)} onClick={(e) => { e.preventDefault(); setShelf(s); }} className={s === shelf ? "on" : ""} aria-current={s === shelf ? "page" : undefined} data-testid={`shelf-${s}`}>
            {SHELF_LABEL[s]}<span className="n">{count(s)}</span>
          </a>
        ))}
      </nav>

      <div className="k-split wide-detail">
        <section aria-label="Registry">
          <div className="k-filters">
            <SearchBox value={q} onChange={setQ} placeholder="Search artifacts" />
            <select className="k-select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="k-filters">
            <Seg label="Date" value={when} onChange={setWhen} options={[["any", "Any time"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]} />
            <Seg label="Group by" value={group} onChange={setGroup} options={[["date", "Date"], ["project", "Project"], ["kind", "Kind"]]} />
          </div>
          {error ? <p className="k-err">Could not load artifacts: {/not found/i.test(error) ? "this daemon does not run the artifacts module yet; restart Joyride." : error}</p> : null}
          {loading && !data ? <p className="k-skeleton">Loading…</p> : null}

          {data && !shown.length ? <p className="empty">{all.length ? "Nothing matches these filters." : "No artifacts yet. Firstmate's reports appear here on their own, as do pages a session publishes and PRs it links; you can also register one."}</p> : null}
          <div data-testid="artifact-list">
            {groups.map((g) => (
              <section className="k-group" key={g.label} aria-label={g.label}>
                <h3>{g.label}<span className="n">{g.items.length}</span></h3>
                <ul className="k-cards">{g.items.map((a) => <li key={a.id}><ArtifactCard a={a} on={a.id === id} mission={a.mission ? missions.get(a.mission)?.title ?? null : null} /></li>)}</ul>
              </section>
              ))}
            </div>
        </section>
        <aside>{id ? <ArtifactDetail id={id} /> : <div className="k-detail sheet"><p className="k-md small muted" style={{ margin: 0 }}>Pick an artifact to read it and see where it came from. Reports open as a document under their summary.</p></div>}</aside>
      </div>
    </div>
  );
}

function ArtifactCard({ a, on, mission }: { a: ArtifactView; on: boolean; mission: string | null }) {
  const line = oneLine(a);
  return (
    <a className={`k-acard${on ? " on" : ""}`} href={href(`artifacts/${a.id}`)} aria-current={on ? "true" : undefined} data-testid="artifact-card">
      <span className="k-kind" title={KIND_LABEL[a.kind]}>{kindMark(a.kind)}</span>
      <span className="t">{a.title}</span>
      <span className="right"><StatusPill a={a} /></span>
      {line ? <span className="one">{line}</span> : null}
      <span className="sub">
        <span>{a.firstmate ? "Firstmate report" : KIND_LABEL[a.kind] ?? a.kind}</span>
        {a.project ? <span>{a.project}</span> : null}
        <span title={new Date(dateOf(a)).toLocaleString()}>{shortDate(dateOf(a))}</span>
        {mission ? <span>{mission}</span> : !a.project && a.session_title ? <span>{a.session_title.length > 42 ? a.session_title.slice(0, 41) + "…" : a.session_title}</span> : null}
      </span>
    </a>
  );
}

export function ArtifactDetail({ id }: { id: string }) {
  const { data: a, error, reload } = useApi<ArtifactView & { history: { sha: string; date: string; subject: string }[] }>(`/api/artifacts/${encodeURIComponent(id)}`, ["artifacts"]);
  const { data: missions } = useApi<any[]>("/api/missions", ["missions"]);
  const isDoc = Boolean(a?.snapshot_blob && /^text\/(markdown|plain)/.test(a?.content_type ?? ""));
  const { data: doc, error: docError } = useApi<{ text: string }>(isDoc ? `/api/artifacts/${encodeURIComponent(id)}/text` : null, ["artifacts"]);
  const link = useAction(async (mission: string) => { await api(`/api/artifacts/${encodeURIComponent(id)}`, { method: "PUT", json: { mission: mission || null } }); await reload(); });
  if (error) return <div className="k-detail sheet"><p className="k-err">{error}</p></div>;
  if (!a) return <div className="k-detail sheet"><p className="k-skeleton">Loading…</p></div>;
  const open = openLabel(a);
  const isImage = a.content_type?.startsWith("image/") && !a.content_type.includes("svg");
  const isPdf = a.content_type === "application/pdf";
  const fm = a.firstmate;
  return (
    <article className="k-detail sheet" data-testid="artifact-detail" style={{ position: "static", maxHeight: "none" }}>
      <div className="k-meta">
        <span className="k-tag">{fm ? "Firstmate report" : KIND_LABEL[a.kind] ?? a.kind}</span>
        <StatusPill a={a} />
        {a.project ? <span>{a.project}</span> : null}
        <span>{fm ? `Task ${fm.task}` : VIA[a.detected_from] ?? ""}</span>
      </div>
      <h2>{a.title}</h2>
      {a.private ? <p className="k-note">Private hiring material. Available here for your review; excluded from aggregate Search and agent context.</p> : null}
      <div className="k-actions" style={{ margin: "12px 0 4px" }}>
        {open ? <a className="btn" href={a.url!} target="_blank" rel="noreferrer">{open}</a> : null}
        {(a.kind === "report" || a.embeddable) ? <button type="button" className="btn ghost" onClick={() => readArtifact(a.id)}>Read report</button> : null}
      </div>

      {a.snapshot_blob ? <p className="k-note"><a href={`/api/artifacts/${encodeURIComponent(a.id)}/download`} download>Download source</a></p> : null}
      {a.url && isLavishReview(a.url) ? <p className="k-note">Lavish is an optional review window. Its chat collects annotations and change requests separately from the report.</p> : null}
      <div className="k-summary" data-testid="artifact-notes">
        <div className="k-label">Summary</div>
        {a.summary ? <Markdown text={a.summary} small /> : <p className="k-note" style={{ margin: 0 }}>No summary yet.</p>}
      </div>

      {fm?.decisions.length ? (
        <div className="k-section" data-testid="artifact-decisions">
          <h4>Captain decisions</h4>
          {fm.decisions.map((d) => (
            <div key={d.task} className={`k-decision${d.open ? " open" : ""}`}>
              <div><strong>{d.open ? "Waiting on you" : "Decided"}</strong> · <span className="k-mono">{d.task}</span>{d.open ? " · answer it in Firstmate" : ""}</div>
              {d.question ? <p className="q">{d.question.length > 600 ? d.question.slice(0, 599) + "…" : d.question}</p> : null}
              {d.answer ? <p className="a">“{d.answer}”</p> : null}
            </div>
          ))}
          {fm.followups.length ? <p className="k-note">{fm.followups.map((f) => `${f.task} (${f.done ? "done" : "in flight"})`).join(", ")} {fm.followups.length === 1 ? "carries" : "carry"} it out.</p> : null}
        </div>
      ) : null}

      {isDoc ? (
        <div className="k-report" data-testid="artifact-report">
          <div className="k-label">{fm ? "The report" : "The document"}{a.local_source ? <> · <span className="k-mono" style={{ fontWeight: 400 }}>{a.local_source.split("/").slice(-3).join("/")}</span></> : null}</div>
          {docError ? <p className="k-err">Could not read the snapshot: {docError}</p> : doc ? <Markdown text={doc.text} doc /> : <p className="k-skeleton">Loading…</p>}
        </div>
      ) : (
        <div className="k-section">
          {a.embeddable ? <>
            <div className="k-label">Local snapshot{a.local_source ? <> of <span className="k-mono" style={{ fontWeight: 400 }}>{a.local_source.split("/").slice(-2).join("/")}</span></> : null}</div>
            {isImage ? <img className="k-preview-img" src={`/api/artifacts/${encodeURIComponent(a.id)}/preview`} alt={a.title} />
              : isPdf ? <iframe className="k-preview" title={`Preview of ${a.title}`} src={`/api/artifacts/${encodeURIComponent(a.id)}/preview`} />
              : <iframe className="k-preview" data-testid="artifact-preview" title={`Preview of ${a.title}`} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" src={`/api/artifacts/${encodeURIComponent(a.id)}/preview`} />}
          </> : (
            <div className="k-open">
              <span style={{ flex: 1 }}>{a.url ? `${KIND_LABEL[a.kind] ?? "This page"} lives on ${new URL(a.url).hostname}, so it opens there. Joyride keeps the link and its summary.` : "The local file is gone, so there is no snapshot to show."}</span>
              {open ? <a className="btn" href={a.url!} target="_blank" rel="noreferrer">{open}</a> : null}
            </div>
          )}
        </div>
      )}

      <div className="k-section">
        <h4>Links</h4>
        <dl className="k-kv">
          <dt>Idea</dt>
          <dd>
            <select className="k-select" value={a.mission ?? ""} onChange={(e) => link.run(e.target.value)} aria-label="Linked idea" disabled={link.busy}>
              <option value="">Not linked</option>
              {(missions ?? []).filter((m) => !m.archive || m.id === a.mission).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
            {a.mission ? <> <a href={href(`mission/${a.mission}`)}>Open idea</a></> : null}
            {link.error ? <div className="k-err">{link.error}</div> : null}
          </dd>
          {fm ? <><dt>Firstmate task</dt><dd><span className="k-mono">{fm.task}</span>{fm.task_title ? <> · {fm.task_title}</> : null}</dd></> : null}
          {a.project ? <><dt>Project</dt><dd>{a.project}</dd></> : null}
          <dt>Session</dt><dd>{a.session ? <a href={href(`session/${encodeURIComponent(a.session)}`)}>{a.session_title ?? a.session}</a> : "None"}</dd>
          {a.url ? <><dt>Link</dt><dd><a href={a.url} target="_blank" rel="noreferrer" className="k-mono">{a.url}</a></dd></> : null}
          {a.local_source ? <><dt>File</dt><dd className="k-mono">{a.local_source}</dd></> : null}
          <dt>{fm ? "Report written" : "Registered"}</dt><dd>{new Date(fm?.modified ?? a.created).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </dl>
      </div>
      {a.history?.length ? <div className="k-section"><h4>History</h4><ul className="k-note" style={{ listStyle: "none", margin: 0, padding: 0 }}>{a.history.slice(0, 5).map((h) => <li key={h.sha}><span className="k-mono">{h.sha.slice(0, 7)}</span> {h.subject.replace(/^joyride: /, "")} <span className="muted">{timeAgo(h.date)}</span></li>)}</ul></div> : null}
    </article>
  );
}

export function RegisterForm({ onDone }: { onDone: (a: ArtifactView | null) => void }) {
  const { data: missions } = useApi<any[]>("/api/missions", ["missions"]);
  const [where, setWhere] = useState("");
  const [title, setTitle] = useState("");
  const [mission, setMission] = useState("");
  const [summary, setSummary] = useState("");
  const save = useAction(async () => {
    const w = where.trim();
    const body: Record<string, string> = /^https?:\/\//i.test(w) ? { url: w } : { local_source: w };
    if (title.trim()) body.title = title.trim();
    if (mission) body.mission = mission;
    if (summary.trim()) body.summary = summary.trim();
    const a = await post<ArtifactView>("/api/artifacts", body);
    onDone(a);
  });
  return (
    <form className="k-form" onSubmit={(e) => { e.preventDefault(); save.run(); }} aria-label="Register an artifact">
      <div className="two">
        <label>Link or file path<input className="input" autoFocus value={where} onChange={(e) => setWhere(e.target.value)} placeholder="https://claude.ai/…, a PR link, or /path/to/report.html" /></label>
        <label>Title<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional; taken from the page when left empty" /></label>
      </div>
      <label>Summary<input className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="One line about what this is" /></label>
      <label>Idea
        <select className="k-select" value={mission} onChange={(e) => setMission(e.target.value)}>
          <option value="">Not linked</option>
          {(missions ?? []).filter((m) => !m.archive).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      </label>
      <div className="k-actions">
        <button className="btn primary" type="submit" disabled={save.busy || !where.trim()}>{save.busy ? "Registering…" : "Register"}</button>
        <button className="btn ghost" type="button" onClick={() => onDone(null)}>Cancel</button>
        <span className="k-note">Local files are snapshotted, so they stay viewable after the original moves.</span>
      </div>
      {save.error ? <p className="k-err">{save.error}</p> : null}
    </form>
  );
}
