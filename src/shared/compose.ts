// What the one "New task" box was asked for: a task for Firstmate, a note, or a checklist.
// Deterministic and cheap: a leading cue ("note:", "add a note", "list:", "make a list", a block of
// "- [ ]" lines) decides it for certain. Text that only mentions notes or lists somewhere is "unsure"
// and goes to Jev with the placement question; everything else is a task. A note keeps its checkboxes and
// links line by line (a mixed board item, shared/board.ts); addresses alone, or "link:", "save this link",
// "bookmark", make a link card (a note whose lines are links).
import { parseLink, strictLink } from "./board.ts";

export type ComposeKind = "task" | "note" | "list";
export type ComposeRead = {
  kind: ComposeKind;
  /** True when a cue decided it; false sends the kind question to Jev with the placement. */
  sure: boolean;
  /** A list's name ("Groceries" from "make a grocery list: …"), else null. */
  title: string | null;
  /** The note's bullets or the list's items, the cue stripped. Empty for a task. */
  lines: string[];
};

const SEP = String.raw`\s*(?:[:\-–—,]\s*|\n|$)`;
const NOTE_CUES: RegExp[] = [
  new RegExp(String.raw`^note\s*[:\-–—]\s*`, "i"),
  new RegExp(String.raw`^note\s+to\s+self\b${SEP}`, "i"),
  /^note\s+that\s+/i,
  // "add a note: …", "make a note that …", "add a note on this idea: …". "add a note field to …" is not one.
  new RegExp(String.raw`^(?:please\s+)?(?:add|make|take|leave|write(?:\s+down)?|save|jot(?:\s+down)?|drop)\s+(?:me\s+)?(?:a|an|this\s+as\s+a)\s+(?:quick\s+|short\s+)?note\b(?:\s+(?:that|saying|of)\s+|\s+(?:about|on|for|to)\s+[^:\n]{1,60}?\s*(?:[:\n]|\s[-–—]\s)\s*|${SEP})`, "i"),
  new RegExp(String.raw`^jot\s+(?:this\s+|it\s+)?down\b${SEP}`, "i"),
];
const LIST_HEAD = String.raw`(?:please\s+)?(?:make|start|create|add|begin|new)\s+(?:me\s+)?(?:a|an|another|a\s+new|new)?\s*((?:[\w'’-]+\s+){0,3}?)(?:check\s*list|checklist|to-?do\s+list|list)`;
const LIST_CUES: RegExp[] = [
  new RegExp(String.raw`^(?:check\s*list|checklist|to-?do\s+list|list)\s*[:\-–—]\s*`, "i"),
  new RegExp(String.raw`^${LIST_HEAD}(?=\s*[:\-–—\n]|\s+(?:of|for|called|named)\b|\s*$)`, "i"),
];
const MENTION = /\b(?:notes?|jot|remember|reminder|lists?|checklist|to-?dos?)\b/i;
const MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;
const BOX = /^\s*(?:[-*•]\s+)?\[[ xX]\]\s+/;

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** One bullet per non-empty line, list markers dropped. */
function lineList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => tidy(l.replace(BOX, "").replace(MARKER, ""))).filter(Boolean);
}

/** A list's items from the rest of the text: one per line, else split on commas and semicolons ("a, b and c"). */
export function listItems(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (/\n/.test(t)) return lineList(t);
  const parts = t.split(/\s*[,;]\s*/).map(tidy).filter(Boolean);
  if (parts.length > 1) {
    const last = parts.pop()!;
    parts.push(...last.replace(/^(?:and|or)\s+/i, "").split(/\s+(?:and|&)\s+/).map(tidy).filter(Boolean));
  }
  return parts.map((p) => p.replace(/[.!]+$/, "")).filter(Boolean);
}

/** A note's bullets from the rest of the text: one per line, else the whole text as one bullet. Checkboxes stay checkboxes. */
export function noteLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => {
    const box = /^\s*(?:[-*•]\s+)?\[([ xX])\]\s+/.exec(l);
    return box ? `[${box[1] === " " ? " " : "x"}] ${tidy(l.slice(box[0].length))}` : tidy(l.replace(MARKER, ""));
  }).filter((l) => l && l !== "[ ]" && l !== "[x]");
}

const LINK_CUES: RegExp[] = [
  /^(?:link|url|pdf|bookmark|artifact)\s*[:\-–—]\s*/i,
  /^(?:please\s+)?(?:save|add|keep|pin|drop)\s+(?:me\s+)?(?:this|that|a|the)?\s*(?:link|url|pdf|page|artifact|bookmark)\s*:\s*/i,
  /^(?:please\s+)?(?:save|add|keep|pin|drop|bookmark)\s+(?:me\s+)?(?:this|that|a|the)?\s*(?:link|url|pdf|page|artifact|bookmark)?\s*[:\-–—]?\s*(?=\S*(?:https?:\/\/|www\.|artifact:|#\/artifacts\/))/i,
];
/**
 * Text that is only links, one per line, as the lines of a link card. After a link cue a line may carry a label
 * beside its address ("pdf: Launch spec https://…"); without one, only addresses and [label](address) count, so
 * "Fix the 404 on https://…" stays work.
 */
function onlyLinks(text: string, cued: boolean): string[] | null {
  const ls = text.split(/\r?\n/).map((l) => tidy(l.replace(MARKER, ""))).filter(Boolean);
  // Several bare addresses on one line are several links.
  const split = ls.length === 1 && ls[0].split(/\s+/).length > 1 && ls[0].split(/\s+/).every((w) => strictLink(w)) ? ls[0].split(/\s+/) : ls;
  const ok = cued ? parseLink : strictLink;
  return split.length && split.every((l) => ok(l)) ? split : null;
}

function readList(m: RegExpExecArray, text: string): ComposeRead {
  const adjective = tidy(m[1] ?? "");
  let rest = text.slice(m[0].length);
  let title: string | null = adjective && !/^(?:quick|short|little|small)$/i.test(adjective) ? `${adjective} list` : null;
  const named = /^\s+(?:of|for|called|named)\s+/i.exec(rest);
  if (named) {
    rest = rest.slice(named[0].length);
    const head = /^([^:\n–—]*?)\s*(?:[:\n–—]|\s-\s)\s*/.exec(rest);
    if (head) { title = tidy(head[1]) || title; rest = rest.slice(head[0].length); }
    else {
      // "a list of milk, eggs and bread" lists the items; "a list for the release" only names it.
      const items = listItems(rest);
      if (items.length > 1) return { kind: "list", sure: true, title: title ? cap(title) : null, lines: items };
      return { kind: "list", sure: true, title: cap(tidy(rest) || title || "") || null, lines: [] };
    }
  } else rest = rest.replace(/^\s*[:\-–—]\s*/, "");
  return { kind: "list", sure: true, title: title ? cap(title) : null, lines: listItems(rest) };
}

/** Read what the captain typed into the composer. */
export function readCompose(raw: string): ComposeRead {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { kind: "task", sure: true, title: null, lines: [] };
  if (/^artifact:[^\s]+$/.test(text) && strictLink(text)) return { kind: "note", sure: true, title: null, lines: [text] };
  for (const re of LIST_CUES) {
    const m = re.exec(text);
    if (m) return readList(m, text);
  }
  for (const re of NOTE_CUES) {
    const m = re.exec(text);
    if (m) return { kind: "note", sure: true, title: null, lines: noteLines(text.slice(m[0].length)) };
  }
  for (const re of LINK_CUES) {
    const m = re.exec(text);
    if (m) { const rest = text.slice(m[0].length); return { kind: "note", sure: true, title: null, lines: onlyLinks(rest, true) ?? noteLines(rest) }; }
  }
  const links = onlyLinks(text, false);
  if (links) return { kind: "note", sure: true, title: null, lines: links };
  // A block of checkboxes is a list; a first line ending in ":" names it.
  const ls = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const boxes = ls.filter((l) => BOX.test(l));
  if (boxes.length >= 2 && (boxes.length === ls.length || (boxes.length === ls.length - 1 && !BOX.test(ls[0]) && ls[0].endsWith(":")))) {
    return { kind: "list", sure: true, title: boxes.length === ls.length ? null : cap(tidy(ls[0].slice(0, -1))), lines: lineList(boxes.join("\n")) };
  }
  return { kind: "task", sure: !MENTION.test(text), title: null, lines: [] };
}

/** The same text as another kind, for "Change" on the card: a note keeps its lines, a list splits them into items. */
export function recast(raw: string, kind: ComposeKind): ComposeRead {
  const r = readCompose(raw);
  if (kind === "task") return { kind, sure: true, title: null, lines: [] };
  const body = r.kind === "task" ? raw.trim() : r.lines.join("\n");
  if (kind === r.kind) return { ...r, sure: true };
  if (kind === "note") return { kind, sure: true, title: null, lines: r.kind === "list" && r.title ? [r.title, ...r.lines] : noteLines(body) };
  const items = r.kind === "note" && r.lines.length > 1 ? r.lines : listItems(body);
  return { kind, sure: true, title: null, lines: items };
}
