// Firstmate's investigation reports as artifacts: a read-only pass over
// <FM_HOME>/data/<task>/report.md plus the backlog (data/backlog.md and
// data/done-archive.md) for each report's project, its captain decisions
// (rows held for the captain that point back at the report) and the
// follow-up tasks that apply it. Never writes into the Firstmate home.
import fs from "node:fs";
import path from "node:path";
import { MISSION_MARKER_RE, parseBacklog, parseMeta, parseStatusLog, type BacklogRow } from "../firstmate/state.ts";
import { decodeHold } from "../firstmate/hold.ts";
import { htmlTitle } from "./store.ts";

export type FmDecision = { task: string; title: string; open: boolean; question: string | null; answer: string | null; mode: string | null };
export type FmFollowup = { task: string; title: string; done: boolean };
/** decision-open: a captain decision on the report is still held; applying/applied: a task that carries it out is in flight/done. */
export type FmReportStatus = "decision-open" | "applying" | "applied" | "decided" | "reported" | "in-progress";
export type FmReport = {
  task: string; file: string; identity_file: string; heading: string; task_title: string | null; repo: string | null; mission: string | null;
  final: boolean; status: FmReportStatus; decisions: FmDecision[]; followups: FmFollowup[]; modified: string;
};

const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const read = (f: string): string | null => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

export { decodeHold };

/** The "Captain decision:" paragraph Firstmate records under a resolved hold. */
function captainAnswer(notes: string[]): string | null {
  const i = notes.findIndex((n) => /^Captain decision:/i.test(n));
  if (i < 0) return null;
  const out: string[] = [];
  const first = notes[i].replace(/^Captain decision:\s*/i, "");
  if (first) out.push(first);
  for (const n of notes.slice(i + 1)) {
    if (/^(Captain hold origin|Origin|Resolution|Decision digest|Mode |local main)\b/i.test(n)) break;
    out.push(n);
  }
  return out.join(" ").trim() || null;
}

/** Backlog rows from the live backlog and its archive (archived rows are done). */
export function readBacklogRows(home: string): BacklogRow[] {
  const data = path.join(home, "data");
  const rows: BacklogRow[] = [];
  const live = read(path.join(data, "backlog.md"));
  if (live) { try { rows.push(...parseBacklog(live)); } catch { /* unreadable backlog: no metadata */ } }
  const arch = read(path.join(data, "done-archive.md"));
  if (arch) { try { rows.push(...parseBacklog(arch.replace(/^##\s+Archived\b.*$/gm, "## Done"))); } catch { /* ignore */ } }
  // The live backlog wins over an archived copy of the same row.
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

const isDone = (r: BacklogRow) => r.section === "done" || r.checked;

/** What the backlog says about the report of task `task`. */
export function reportStatus(task: string, rows: BacklogRow[]): { status: FmReportStatus; decisions: FmDecision[]; followups: FmFollowup[] } {
  const refs = [`data/${task}/report.md`, `data/${task}/report.html`];
  const self = rows.find((r) => r.id === task) ?? null;
  const decisions: FmDecision[] = [];
  const followups: FmFollowup[] = [];
  for (const r of rows) {
    const question = decodeHold(r.hold);
    const origin = r.notes.some((n) => new RegExp(`^(Captain hold )?origin:\\s*${task.replace(/[.]/g, "\\.")}\\s*$`, "i").test(n));
    const mentions = refs.some(ref => `${r.title} ${r.notes.join(" ")} ${r.report_path ?? ""}`.includes(ref));
    if (r.id === task) {
      if (r.hold && !isDone(r)) decisions.push({ task: r.id, title: r.title, open: true, question, answer: null, mode: null });
      continue;
    }
    const held = Boolean(r.hold) || r.kind === "captain";
    if (held && (origin || refs.some((ref) => (question ?? "").includes(ref)) || mentions)) {
      const mode = r.notes.map((n) => n.match(/^Resolution mode:\s*(\S+)/i)?.[1]).find(Boolean) ?? null;
      decisions.push({ task: r.id, title: r.title, open: !isDone(r), question, answer: captainAnswer(r.notes), mode });
    } else if (mentions || origin) {
      followups.push({ task: r.id, title: r.title, done: isDone(r) });
    }
  }
  let status: FmReportStatus;
  if (decisions.some((d) => d.open)) status = "decision-open";
  else if (followups.some((f) => !f.done)) status = "applying";
  else if (followups.length) status = "applied";
  else if (decisions.length) status = "decided";
  else if (!self || isDone(self)) status = "reported";
  else status = "in-progress";
  return { status, decisions, followups };
}

/** Every data/<task>/report.html or report.md, preferring nonempty HTML in the home, with its metadata. Missing or unreadable homes give []. */
export function readFirstmateReports(home: string): FmReport[] {
  const data = path.join(home, "data");
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(data, { withFileTypes: true }).filter((e) => e.isDirectory() && TASK_RE.test(e.name)).map((e) => e.name); } catch { return []; }
  const rows = readBacklogRows(home);
  const out: FmReport[] = [];
  for (const task of dirs.sort()) {
    const identity_file = path.join(data, task, "report.md");
    const html = path.join(data, task, "report.html");
    const htmlText = read(html);
    const file = htmlText?.trim() ? html : identity_file;
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const text = read(file);
    if (text == null) continue;
    const row = rows.find((r) => r.id === task) ?? null;
    const meta = parseMeta(read(path.join(home, "state", `${task}.meta`)) ?? "");
    const brief = read(path.join(data, task, "brief.md")) ?? read(path.join(data, task, "launch-brief.md")) ?? "";
    const heading = (file === html ? htmlTitle(text) : null) || text.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() || row?.title || task;
    out.push({
      task, file, identity_file, heading, task_title: row?.title ?? null,
      repo: row?.repo ?? (meta.project ? path.basename(meta.project) : null),
      mission: brief.match(MISSION_MARKER_RE)?.[1]?.toLowerCase() ?? null,
      final: Boolean(row && isDone(row)) || parseStatusLog(read(path.join(home, "state", `${task}.status`)) ?? "").at(-1)?.verb === "done",
      ...reportStatus(task, rows),
      modified: new Date(st.mtimeMs).toISOString(),
    });
  }
  return out;
}

/** Cheap change signature over everything readFirstmateReports looks at. */
export function reportsSignature(home: string): string {
  const data = path.join(home, "data");
  const parts: string[] = [];
  const stamp = (f: string) => { try { const s = fs.statSync(f); parts.push(`${f}:${s.mtimeMs}:${s.size}`); } catch { /* absent */ } };
  stamp(path.join(data, "backlog.md"));
  stamp(path.join(data, "done-archive.md"));
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(data); } catch { return ""; }
  for (const d of dirs.sort()) { stamp(path.join(data, d, "report.md")); stamp(path.join(data, d, "report.html")); stamp(path.join(data, d, "brief.md")); stamp(path.join(data, d, "launch-brief.md")); stamp(path.join(home, "state", `${d}.meta`)); stamp(path.join(home, "state", `${d}.status`)); }
  return parts.join("|");
}
