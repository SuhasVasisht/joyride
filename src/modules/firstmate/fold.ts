// A TypeScript port of Firstmate's status-decision fold, status_open_decisions in
// vendor/firstmate/bin/fm-classify-lib.sh. The status log is an append-only event
// log, so the last line never says whether a decision is still open: a
// `needs-decision`/`blocked` line opens a keyed decision, and only a `resolved` or
// `captain-held` line naming the same key closes it. A ship or scout `done:`/`failed:`
// clears every open decision. tests/unit/asks-fold.test.ts runs the vendored
// library against the same fixtures, so the two can never drift silently.
//
// Line grammar (mirrors the library, including its quirks):
//   <verb> [corr=<16 hex>]* [name=value]* : <note>      "[key=<slug>]" names the decision
//   <verb>: [key=<slug>] <note>                          the note-head position, accepted too
// A line without a key uses "default"; a key outside [A-Za-z0-9._-] is not a transition;
// "[at=<epoch>]" stamps before the colon are ignored when finding the head; a reserved
// `pending-reply-` key only moves when its note starts with `pending-reply-…:`.

export type OpenDecision = {
  key: string;
  verb: "needs-decision" | "blocked";
  note: string;
  /** The opener's [at=<epoch>] stamp as an ISO time, else null. */
  at: string | null;
  /** False when the line named no key (the shared "default" decision). */
  keyed: boolean;
  /** 0-based line index of the opener in the status file. */
  line: number;
};

export type FoldKind = "ship" | "scout" | "secondmate" | "unknown";

const OPENERS = new Set(["needs-decision", "blocked"]);
const CLOSERS = new Set(["resolved", "captain-held"]);
const FOLDED = new Set([...OPENERS, ...CLOSERS, "done", "failed"]);
export const RESERVED_KEY_PREFIXES = ["pending-reply-"];

const WS = "[ \\t\\n\\v\\f\\r]";
const lstrip = (s: string) => s.replace(new RegExp(`^${WS}+`), "");
const strip = (s: string) => lstrip(s).replace(new RegExp(`${WS}+$`), "");
const head = (s: string) => { const i = s.indexOf(":"); return i < 0 ? s : s.slice(0, i); };
const afterColon = (s: string) => s.slice(s.indexOf(":") + 1);
/** Bash glob `*[key=*]*`: a "[key=" with a "]" somewhere after it. */
const hasKeyToken = (s: string) => { const i = s.indexOf("[key="); return i >= 0 && s.indexOf("]", i + 5) >= 0; };
const CORR_RE = /^corr=[0-9A-Fa-f]{16}$/;

/** The line with every [at=…] stamp before its first colon removed (_fm_status_unstamped). */
export function unstamped(line: string): string {
  let rest = line, keep = "";
  for (;;) {
    const i = rest.indexOf("[at=");
    if (i < 0 || rest.indexOf("]", i + 4) < 0) break;
    const before = rest.slice(0, i);
    if (before.includes(":")) break;
    keep += before.endsWith(" ") ? before.slice(0, -1) : before;
    rest = rest.slice(i + 4);
    rest = rest.slice(rest.indexOf("]") + 1);
  }
  return keep + rest;
}

/** The leading verb: the head up to its first tag, without unbracketed corr tokens (status_line_verb). */
export function statusLineVerb(line: string): string {
  let v = head(line);
  const b = v.indexOf("[");
  if (b >= 0) v = v.slice(0, b);
  v = strip(v);
  if (!v.includes("corr=")) return v;
  const words = v.split(new RegExp(`${WS}+`));
  return [words[0], ...words.slice(1).filter((w) => !CORR_RE.test(w))].join(" ");
}

const keyBeforeColon = (s: string) => hasKeyToken(head(s));

function keyAtNoteHead(s: string): string | null {
  if (!s.includes(":")) return null;
  const rest = lstrip(afterColon(s));
  if (!rest.startsWith("[key=")) return null;
  const end = rest.indexOf("]", 5);
  return end < 0 ? null : rest.slice(5, end);
}

const slugOk = (k: string) => /^[A-Za-z0-9._-]+$/.test(k);

/** The note: text after the first colon, left-trimmed, minus a note-head key token (status_line_note). */
export function statusLineNote(line: string): string {
  const u = unstamped(line);
  if (!u.includes(":")) return u;
  let n = lstrip(afterColon(u));
  const k = keyBeforeColon(u) ? null : keyAtNoteHead(u);
  if (k != null && slugOk(k)) {
    if (n.startsWith(`[key=${k}]`)) n = n.slice(k.length + 6);
    n = lstrip(n);
  }
  return n;
}

/** The decision key, "default" when the line names none, null when the stated slug is malformed (_fm_decision_key). */
export function decisionKey(line: string): { key: string; keyed: boolean } | null {
  const u = unstamped(line);
  let k: string | null;
  if (keyBeforeColon(u)) {
    const h = head(u);
    k = h.slice(h.indexOf("[key=") + 5);
    const end = k.indexOf("]");
    if (end >= 0) k = k.slice(0, end);
  } else {
    k = keyAtNoteHead(u);
    if (k == null) return { key: "default", keyed: false };
  }
  return slugOk(k) ? { key: k, keyed: true } : null;
}

function transitionAllowed(key: string, note: string): boolean {
  for (const p of RESERVED_KEY_PREFIXES) {
    if (key.startsWith(p)) return note.startsWith(p) && note.indexOf(":", p.length) >= 0;
  }
  return true;
}

/** The task kind the terminal rule needs, from the sibling .meta text (_fm_status_kind): last kind= wins, default ship. */
export function statusKind(metaText: string | null): FoldKind {
  if (metaText == null) return "unknown";
  let kind = "";
  const lines = metaText.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const l of lines) if (l.startsWith("kind=")) kind = l.slice(5);
  kind ||= "ship";
  return kind === "ship" || kind === "scout" || kind === "secondmate" ? kind : "unknown";
}

function stampOf(line: string): string | null {
  const m = line.match(/\[at=(\d+)\]/);
  return m ? new Date(Number(m[1]) * 1000).toISOString() : null;
}

/** Fold a whole status log into the decisions still open, most recently opened last. */
export function foldOpenDecisions(text: string, kind: FoldKind): OpenDecision[] {
  let open: OpenDecision[] = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, i) => {
    const verb = statusLineVerb(line);
    if (!FOLDED.has(verb)) return;
    const u = unstamped(line);
    if (!u.includes(":") && !hasKeyToken(u)) return;
    if (u.includes(":") && (verb === "done" || verb === "failed") && (kind === "ship" || kind === "scout")) { open = []; return; }
    if (!OPENERS.has(verb) && !CLOSERS.has(verb)) return;
    const k = decisionKey(line);
    if (!k) return;
    const note = statusLineNote(line);
    if (!transitionAllowed(k.key, note)) return;
    open = open.filter((d) => d.key !== k.key);
    if (OPENERS.has(verb)) open.push({ key: k.key, verb: verb as OpenDecision["verb"], note, at: stampOf(line), keyed: k.keyed, line: i });
  });
  return open;
}

/** The library's own output shape: one "<key>\t<verb>\t<note>" line per open decision. */
export const formatOpenDecisions = (open: OpenDecision[]) => open.map((d) => `${d.key}\t${d.verb}\t${d.note}`).join("\n");
