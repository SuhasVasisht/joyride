// Read-only projection of Firstmate's FM_HOME into Joyride tasks.
//   data/backlog.md            tasks-axi backlog: "## In flight" / "## Queued" / "## Done"
//                              rows "- [ ] <id> - <title> (repo: x) (kind: ship) blocked-by: <id>"
//   data/<id>/brief.md         the task brief (carries our "joyride-mission: <id>" marker)
//   data/<id>/report.md        scout deliverable / task report
//   data/projects.md           project registry "- name [local-only +yolo] - desc"
//   data/secondmates.md        "- <id> - <summary> (home: /abs; projects: a, b; ...)"
//   state/<id>.meta            key=value (last key wins): worktree, branch, harness, kind, mode, window, ...
//   state/<id>.status          append-only log "<verb> [key=..] [at=<epoch>]: <text>"
//   state/<id>.turn-ended      empty; only its mtime matters
//   state/home-summary.json    Firstmate's own digest (state, decisions_open, landed, ...)
//   state/.wake-queue          durable wake rows "<epoch>\t<seq>\t<kind>\t<key>\t<payload>" not drained yet
// Every reader tolerates missing or malformed files: a broken home yields
// fewer tasks plus an error string, never an exception.
import fs from "node:fs";
import path from "node:path";
import type { TaskView } from "../../shared/schema.ts";
import { foldOpenDecisions, statusKind, type OpenDecision } from "./fold.ts";
import { decodeHold } from "./hold.ts";

export const MISSION_MARKER_RE = /joyride-mission:\s*`?([a-z0-9][a-z0-9._-]{0,95})`?/i;
/** The intent id a map request carries into the brief Firstmate writes from it. */
export const REQUEST_MARKER_RE = /joyride-request:\s*`?([A-Za-z0-9][A-Za-z0-9._:-]{0,127})`?/;

export type BacklogSection = "in_flight" | "queued" | "done";
export type BacklogRow = {
  id: string; title: string; section: BacklogSection; checked: boolean;
  repo: string | null; kind: string | null; priority: string | null;
  /** The stored hold reason (possibly `fm-hold-v1:<base64>`); decodeHold gives the text. */
  hold: string | null; hold_kind: string | null; hold_until: string | null;
  /** The first body line's "Captain hold set:" stamp, and the "Captain hold origin:" task. */
  hold_set: string | null; hold_origin: string | null;
  blocked_by: string[]; since: string | null; completed: { verb: string; date: string } | null;
  report_path: string | null; links: string[]; notes: string[];
};
export type StatusEntry = { verb: string; text: string; at: string | null; key: string | null };
export type Secondmate = { id: string; summary: string; home: string | null; projects: string[]; host: string | null };
export type Project = { name: string; mode: string; flags: string[]; description: string };
export type TaskDetail = TaskView & {
  section: BacklogSection | null;
  repo: string | null;
  project: string | null;
  mode: string | null;
  window: string | null;
  pid: number | null;
  backend: string | null;
  /** The crewmate's Herdr pane id and Herdr session, from the meta (herdr backend only): its authoritative identity. */
  pane: string | null;
  herdr_session: string | null;
  /** The decoded hold reason (same text as hold_reason). */
  hold: string | null;
  hold_reason: string | null;
  hold_kind: string | null;
  hold_until: string | null;
  hold_set: string | null;
  hold_origin: string | null;
  /** The backlog row's "(since <date>)". */
  since: string | null;
  /** Who runs the task, from the meta: model, reasoning effort and the worker account Firstmate pinned. */
  model: string | null;
  effort: string | null;
  account: string | null;
  /** The `joyride-request: <intent id>` marker in the brief: the map request this task came from. */
  request: string | null;
  /** Keyed decisions still open per Firstmate's status fold (fold.ts), most recently opened last. */
  decisions: OpenDecision[];
  turn_ended: string | null;
  inbox_pending: number;
  brief: string | null; // brief.md path
  mission_source: "marker" | "crews" | null;
  secondmate: string | null;
};
export type HomeState = {
  home: string;
  present: boolean;
  tasks: TaskDetail[];
  secondmates: Secondmate[];
  projects: Project[];
  summary: { state: string; generated: string | null; valid: boolean; decisions_open: number; active: number; queued: number; landed: number } | null;
  /** Firstmate's own open decisions from state/home-summary.json: a cross-check, never the source. */
  summary_decisions: { id: string; key: string; verb: string }[];
  /** Firstmate's durable wake queue (state/.wake-queue): rows not drained yet and the oldest one's time. */
  wake: { pending: number; oldest: string | null };
  backend: string | null;
  errors: string[];
};

const SECTIONS: Record<string, BacklogSection> = { "in flight": "in_flight", queued: "queued", done: "done" };
const STATUS_VERBS = new Set(["working", "needs-decision", "blocked", "paused", "done", "failed", "note", "resolved", "captain-held"]);

const trim = (s: string) => s.replace(/^\s+|\s+$/g, "");
function meta(rest: string, key: string): string | null {
  const m = rest.match(new RegExp(`(?:\\(|,\\s*)${key}:\\s*([^,)]*)`));
  return m ? trim(m[1]) || null : null;
}
function metaWord(rest: string, key: string): string | null {
  const m = rest.match(new RegExp(`(?:\\(|,\\s*)${key}\\s+([^,)]*)`));
  return m ? trim(m[1]) || null : null;
}

/** Parse tasks-axi backlog markdown (mirrors backlog_json() in bin/fm-fleet-snapshot.sh). */
export function parseBacklog(text: string): BacklogRow[] {
  const rows: BacklogRow[] = [];
  let section: BacklogSection | null = null;
  let last: BacklogRow | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = SECTIONS[h[1].toLowerCase()] ?? null; last = null; continue; }
    if (!section) continue;
    const parts = line.match(/^[-*]\s+\[([ xX])\]\s+(\S+)\s+-\s+(.*)$/);
    const bold = parts ? null : line.match(/^[-*]\s+\*\*([^*]+)\*\*\s+-\s+(.*)$/);
    if (!parts && !bold) {
      if (last && /^\s{2,}\S/.test(line)) {
        const note = trim(line);
        if (!last.notes.length) last.hold_set = note.match(/^Captain hold set:\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?)$/)?.[1] ?? null;
        last.hold_origin ??= note.match(/^Captain hold origin:\s*(\S+)$/i)?.[1] ?? null;
        last.notes.push(note);
      }
      continue;
    }
    const checked = parts ? /[xX]/.test(parts[1]) : false;
    const id = trim(parts ? parts[2] : bold![1]);
    const rest = parts ? parts[3] : bold![2];
    const kindMeta = meta(rest, "kind");
    const kind = kindMeta ?? (/^SCOUT(?![A-Za-z0-9_])/.test(rest) ? "scout" : /^SHIP(?![A-Za-z0-9_])/.test(rest) ? "ship" : null);
    const blocked = [...rest.matchAll(/blocked-by:\s+([^\s)]+)/g)].map((x) => x[1]);
    const merged = metaWord(rest, "merged"), reported = metaWord(rest, "reported"), done = metaWord(rest, "done");
    const completed = merged ? { verb: "merged", date: merged } : reported ? { verb: "reported", date: reported } : done ? { verb: "done", date: done } : null;
    const title = trim(
      rest
        .replace(/<?https?:\/\/[^\s)"<>]+>?/g, "")
        .replace(/\s*blocked-by:\s+[^\s)]+\s+-\s+.*$/, "")
        .replace(/\s*blocked-by:\s+\S+/g, "")
        .replace(/(\s*\(\s*(?:(?:repo|kind|priority|hold|hold-kind|hold-until):\s*[^)]*|(?:since|merged|reported|done)\s+[^)]*)\s*\)\s*)+$/, "")
        .replace(/\s+-\s+data\/\S+\/report\.md$/, "")
        .replace(/\s+data\/\S+\/report\.md$/, "")
        .replace(/\s+-?\s*local main$/, "")
        .replace(/\s+-\s*$/, "")
        .replace(/\s+/g, " ")
        // tasks-axi marks kind with a leading SCOUT/SHIP word; the kind is shown separately.
        .replace(/^(?:SCOUT|SHIP)(?![A-Za-z0-9_])[\s:-]*/, ""),
    ).replace(/^[a-z]/, (c) => c.toUpperCase());
    last = {
      id, title: title || id, section, checked,
      repo: meta(rest, "repo"), kind, priority: meta(rest, "priority"),
      hold: rest.match(/\(hold:\s*([^)]*)/)?.[1]?.trim() ?? null,
      hold_kind: meta(rest, "hold-kind"), hold_until: meta(rest, "hold-until"), hold_set: null, hold_origin: null,
      blocked_by: [...new Set(blocked)], since: metaWord(rest, "since"), completed,
      report_path: rest.match(/(data\/[^\s)]+\/report\.md)/)?.[1] ?? null,
      links: [...rest.matchAll(/https?:\/\/[^\s)"<>]+/g)].map((x) => x[0]),
      notes: [],
    };
    rows.push(last);
  }
  return rows;
}

/** key=value lines; the last occurrence of a key wins (fm_meta_get). */
export function parseMeta(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

/** Status log: "<verb> [key=x] [corr=y] [at=epoch]: text". Non-matching lines continue the previous entry. */
export function parseStatusLog(text: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.match(/^([a-z][a-z-]*)((?:\s+\[[a-z_]+=[^\]]*\])*)\s*:\s?(.*)$/);
    if (m && STATUS_VERBS.has(m[1])) {
      const tags = Object.fromEntries([...m[2].matchAll(/\[([a-z_]+)=([^\]]*)\]/g)].map((t) => [t[1], t[2]]));
      const at = tags.at && /^\d+$/.test(tags.at) ? new Date(Number(tags.at) * 1000).toISOString() : null;
      out.push({ verb: m[1], text: m[3].trim(), at, key: tags.key ?? null });
    } else if (out.length) {
      out[out.length - 1].text += (out[out.length - 1].text ? " " : "") + line.trim();
    }
  }
  return out;
}

export function parseProjects(text: string): Project[] {
  const out: Project[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[-*]\s+(\S+)(?:\s+\[([^\]]*)\])?\s*(?:-\s*(.*))?$/);
    if (!m) continue;
    const tokens = (m[2] ?? "").split(/\s+/).filter(Boolean);
    out.push({ name: m[1], mode: tokens.find((t) => !t.startsWith("+") && !t.includes("=")) ?? "no-mistakes", flags: tokens.filter((t) => t.startsWith("+") || t.includes("=")), description: (m[3] ?? "").trim() });
  }
  return out;
}

export function parseSecondmates(text: string): Secondmate[] {
  const out: Secondmate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[-*]\s+(\S+)\s+-\s+(.*?)(?:\s+\(([^()]*)\))?\s*$/);
    if (!m) continue;
    const attrs = Object.fromEntries((m[3] ?? "").split(";").map((kv) => kv.trim().match(/^([a-z-]+):\s*(.*)$/)).filter(Boolean).map((x) => [x![1], x![2].trim()]));
    out.push({ id: m[1], summary: m[2].trim(), home: attrs.home ?? null, projects: attrs.projects ? attrs.projects.split(/,\s*/).filter(Boolean) : [], host: attrs.host ?? null });
  }
  return out;
}

const read = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const mtime = (f: string): number | null => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/**
 * Map the status log (plus backlog position) to the task status Joyride shows. A decision the fold
 * still holds open wins over any later line; a needs-decision or blocked line the fold has closed
 * is history, so the task reads as working again until a newer line says otherwise.
 */
export function taskStatus(row: BacklogRow | null, entries: StatusEntry[], open: Pick<OpenDecision, "verb">[] = []): string {
  if (row?.section === "done" || row?.checked) return row.completed?.verb === "merged" ? "merged" : row.completed?.verb === "reported" ? "reported" : "done";
  if (open.length) return open[open.length - 1].verb;
  const lastVerb = [...entries].reverse().find((e) => e.verb !== "note")?.verb;
  if (lastVerb) {
    if (lastVerb === "captain-held") return "held";
    if (lastVerb === "needs-decision" || lastVerb === "blocked" || lastVerb === "resolved") return "working";
    return lastVerb;
  }
  if (row?.hold) return "held";
  if (row?.blocked_by.length) return "waiting";
  if (row?.section === "queued") return "queued";
  if (row?.section === "in_flight") return "starting";
  return "unknown";
}

/**
 * The Herdr pane a task's meta records: `herdr_pane_id`/`herdr_session`, else the herdr backend's
 * `window=<session>:<pane-id>`. A tmux window names no Herdr pane, so it gives none.
 */
export function taskPane(m: Record<string, string>): { pane: string | null; herdr_session: string | null } {
  const backend = m.backend ?? (m.window ? "tmux" : null);
  if (backend !== "herdr") return { pane: null, herdr_session: null };
  const w = (m.window ?? "").match(/^([^:]+):(.+)$/);
  return { pane: w?.[2] || m.herdr_pane_id || null, herdr_session: w?.[1] || m.herdr_session || null };
}

/**
 * Read one FM_HOME. `crews` maps mission id -> authored task ids (Mission.crews); that link wins over a
 * brief's marker, except where it is only Joyride's own earlier auto-link of a marker (`autoLinked`:
 * task id -> the mission it linked) and the brief now names a different mission.
 */
export function readHome(home: string, crews: Record<string, string[]> = {}, autoLinked: Record<string, string> = {}): HomeState {
  const errors: string[] = [];
  const st: HomeState = { home, present: fs.existsSync(home), tasks: [], secondmates: [], projects: [], summary: null, summary_decisions: [], wake: { pending: 0, oldest: null }, backend: null, errors };
  if (!st.present) return st;
  const data = path.join(home, "data"), state = path.join(home, "state");

  const backlogText = read(path.join(data, "backlog.md"));
  let rows: BacklogRow[] = [];
  if (backlogText != null) { try { rows = parseBacklog(backlogText); } catch (e: any) { errors.push(`data/backlog.md: ${e.message}`); } }
  st.projects = parseProjects(read(path.join(data, "projects.md")) ?? "");
  st.secondmates = parseSecondmates(read(path.join(data, "secondmates.md")) ?? "");
  st.backend = (read(path.join(home, "config", "backend")) ?? "").trim() || null;

  const summaryText = read(path.join(state, "home-summary.json"));
  if (summaryText) {
    try {
      const s = JSON.parse(summaryText);
      st.summary = {
        state: String(s.state ?? "unknown"), generated: s.generated ?? null, valid: s.valid === true,
        decisions_open: Array.isArray(s.decisions_open) ? s.decisions_open.length : 0,
        active: Array.isArray(s.active_children) ? s.active_children.length : 0,
        queued: Array.isArray(s.queued) ? s.queued.length : 0,
        landed: Array.isArray(s.landed) ? s.landed.length : 0,
      };
      st.summary_decisions = (Array.isArray(s.decisions_open) ? s.decisions_open : [])
        .filter((d: any) => d && typeof d.id === "string")
        .map((d: any) => ({ id: d.id, key: String(d.key ?? d.id), verb: String(d.verb ?? "") }));
    } catch (e: any) { errors.push(`state/home-summary.json: ${e.message}`); }
  }
  st.wake = readWakeQueue(path.join(state, ".wake-queue"));

  // Task ids: backlog rows plus any state/<id>.meta without a row (spawned before the backlog caught up).
  const ids = new Map<string, BacklogRow | null>();
  for (const r of rows) ids.set(r.id, r);
  let stateFiles: string[] = [];
  try { stateFiles = fs.readdirSync(state); } catch {}
  for (const f of stateFiles) { const m = f.match(/^(.+)\.meta$/); if (m && !ids.has(m[1])) ids.set(m[1], null); }

  const crewOwner = new Map<string, string>();
  for (const [mission, list] of Object.entries(crews)) for (const id of list) if (!crewOwner.has(id)) crewOwner.set(id, mission);
  const secondmateOf = new Map<string, string>();
  for (const s of st.secondmates) secondmateOf.set(s.id, s.id);

  for (const [id, row] of ids) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id.startsWith(".")) continue;
    const metaFile = path.join(state, `${id}.meta`), statusFile = path.join(state, `${id}.status`), turnFile = path.join(state, `${id}.turn-ended`);
    const metaText = read(metaFile);
    const m = parseMeta(metaText ?? "");
    const statusText = read(statusFile) ?? "";
    const entries = parseStatusLog(statusText);
    const decisions = foldOpenDecisions(statusText, statusKind(metaText));
    const briefFile = [path.join(data, id, "brief.md"), path.join(data, id, "launch-brief.md")].find((f) => fs.existsSync(f)) ?? null;
    const briefText = briefFile ? read(briefFile) ?? "" : "";
    const marker = briefText.match(MISSION_MARKER_RE)?.[1]?.toLowerCase() ?? null;
    const reportFile = [row?.report_path ? path.join(home, row.report_path) : null, path.join(data, id, "report.md")].find((f) => f && fs.existsSync(f)) ?? null;
    const lastEntry = entries.at(-1) ?? null;
    const turnEnded = mtime(turnFile);
    const updatedMs = Math.max(mtime(statusFile) ?? 0, mtime(metaFile) ?? 0, turnEnded ?? 0, mtime(briefFile ?? "") ?? 0);
    let inbox = 0;
    try { inbox = fs.readdirSync(path.join(state, `${id}.inbox`)).filter((n) => n.endsWith(".msg")).length; } catch {}
    // The authored link (Mission.crews) wins: a captain's move or housekeeping can re-file a task its brief marked.
    const owner = crewOwner.get(id);
    const staleAuto = Boolean(owner && marker && marker !== owner && autoLinked[id] === owner);
    const mission = (staleAuto ? marker : owner) ?? marker ?? null;
    st.tasks.push({
      id,
      title: row?.title ?? (briefText.match(/^#\s+(.+)$/m)?.[1]?.trim() || id),
      status: taskStatus(row, entries, decisions),
      kind: row?.kind ?? m.kind ?? "",
      harness: m.harness ?? null,
      worktree: m.worktree ?? null,
      branch: m.branch ?? null,
      last_event: lastEntry ? `${lastEntry.verb}: ${lastEntry.text}`.slice(0, 400) : row?.completed ? `${row.completed.verb} ${row.completed.date}` : row?.notes.at(-1) ?? "",
      updated: lastEntry?.at ?? iso(updatedMs || null),
      report: reportFile,
      depends_on: row?.blocked_by ?? [],
      mission,
      section: row?.section ?? null,
      repo: row?.repo ?? (m.project ? path.basename(m.project) : null),
      project: m.project ?? null,
      mode: m.mode ?? null,
      window: m.window ?? null,
      pid: /^\d+$/.test(m.pid ?? m.worker_pid ?? m.agent_pid ?? "") ? Number(m.pid ?? m.worker_pid ?? m.agent_pid) : null,
      backend: m.backend ?? (m.window ? "tmux" : null),
      ...taskPane(m),
      hold: decodeHold(row?.hold),
      hold_reason: decodeHold(row?.hold),
      hold_kind: row?.hold_kind ?? null,
      hold_until: row?.hold_until ?? null,
      hold_set: row?.hold_set ?? null,
      hold_origin: row?.hold_origin ?? null,
      since: row?.since ?? null,
      model: m.model || null,
      effort: m.effort || null,
      account: m.account || null,
      request: briefText.match(REQUEST_MARKER_RE)?.[1] ?? null,
      decisions,
      turn_ended: iso(turnEnded),
      inbox_pending: inbox,
      brief: briefFile,
      mission_source: marker && mission === marker ? "marker" : owner ? "crews" : null,
      secondmate: m.kind === "secondmate" || secondmateOf.has(id) ? id : null,
    });
  }
  const order: Record<string, number> = { in_flight: 0, queued: 1, done: 2 };
  st.tasks.sort((a, b) => (order[a.section ?? "in_flight"] - order[b.section ?? "in_flight"]) || String(b.updated ?? "").localeCompare(String(a.updated ?? "")));
  return st;
}

/** Rows of Firstmate's durable wake queue: "<epoch>\t<seq>\t<kind>\t<key>\t<payload>" (bin/fm-wake-lib.sh). */
export function readWakeQueue(file: string): { pending: number; oldest: string | null } {
  const text = read(file);
  if (!text) return { pending: 0, oldest: null };
  const epochs = text.split("\n").map((l) => l.match(/^(\d+)\t/)?.[1]).filter((x): x is string => Boolean(x)).map(Number);
  return { pending: epochs.length, oldest: epochs.length ? new Date(Math.min(...epochs) * 1000).toISOString() : null };
}

/** Cheap change signature: names + mtimes + sizes of the files the reader looks at. */
export function homeSignature(home: string): string {
  const parts: string[] = [];
  const walk = (dir: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0 && !/^(handled|tmp|locks?)$/.test(e.name)) walk(p, depth - 1); continue; }
      try { const s = fs.statSync(p); parts.push(`${p}:${s.mtimeMs}:${s.size}`); } catch {}
    }
  };
  walk(path.join(home, "data"), 1);
  walk(path.join(home, "state"), 1);
  walk(path.join(home, "config"), 0);
  // A reply (fm-inbox.sh reply) lands two levels down, below the walk.
  walk(path.join(home, "state", "inbox", ".replies"), 0);
  return parts.sort().join("|");
}
