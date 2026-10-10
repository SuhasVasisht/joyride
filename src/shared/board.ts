// Board items: the captain's freeform cards on the map. One model for every kind: a note is lines of text,
// a list is lines that are all checkboxes, a link is lines that are all links (a PDF, an artifact, a web page),
// and anything else is mixed. Stored as a note (shared/notes.ts): one bullet per line, so agents read plain
// markdown ("- [ ] milk", "- [Spec](https://x/spec.pdf)"). Pure, no imports: the hook and the UI share it.

export type LinkType = "pdf" | "artifact" | "url" | "file";
export type Link = {
  /** What opens: a web address, Joyride's own "#/artifacts/<id>", or a local path. */
  href: string;
  type: LinkType;
  /** A readable name: the label it was saved with, else one made from the address. */
  title: string;
  /** Where it lives, in a few words: "github.com", "Joyride artifact", "~/Documents". */
  where: string;
  /** Set when the title came from the address rather than a label. */
  derived: boolean;
  /** A Joyride artifact's id, so the UI can name it by its registered title. */
  artifact?: string;
};
export type Block =
  | { kind: "text"; text: string }
  | { kind: "todo"; text: string; done: boolean }
  | { kind: "link"; link: Link; note?: string };
export type ItemKind = "note" | "list" | "link" | "mixed";

const TODO_RE = /^\[([ xX])\]\s+/;
const MD_LINK_RE = /^\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)\s*(?:[-–—:·]\s*(.*))?$/;
const URL_RE = /^(?:https?:\/\/|www\.)[^\s<>"]+$/i;
const ARTIFACT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_RE = /^(?:~|\/)[^\s<>"]*[^\s<>".,;:!?)]$/;

/** A web address, Joyride artifact or local path a line can link to, or null. */
export function linkTarget(raw: string): { href: string; type: LinkType; artifact?: string } | null {
  // Sentence punctuation after an address isn't part of it; a closing bracket is, when it opened one.
  let s = raw.trim().replace(/[.,;:!?]+$/, "");
  if (s.endsWith(")") && !s.includes("(")) s = s.slice(0, -1);
  if (!s) return null;
  const art = /^(?:artifact:|#\/artifacts\/)([A-Za-z0-9._-]{1,128})$/.exec(s);
  if (art && ARTIFACT_ID_RE.test(art[1])) return { href: `#/artifacts/${art[1]}`, type: "artifact", artifact: art[1] };
  if (URL_RE.test(s)) {
    const href = /^www\./i.test(s) ? `https://${s}` : s;
    let u: URL;
    try { u = new URL(href); } catch { return null; }
    if (/(^|\.)claude\.(ai|site)$/i.test(u.hostname) && /\/(?:code\/)?artifacts?\//i.test(u.pathname) || /(^|\.)claudeusercontent\.com$/i.test(u.hostname)) return { href, type: "artifact" };
    const local = /^\/#\/artifacts\/([A-Za-z0-9._-]{1,128})$/.exec(`${u.pathname}${u.hash}`);
    if (local && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return { href: `#/artifacts/${local[1]}`, type: "artifact", artifact: local[1] };
    return { href, type: /\.pdf$/i.test(u.pathname) ? "pdf" : "url" };
  }
  if (PATH_RE.test(s) && /\.[A-Za-z0-9]{1,8}$/.test(s)) return { href: s, type: /\.pdf$/i.test(s) ? "pdf" : "file" };
  return null;
}

const words = (s: string) => s.replace(/[_+]+/g, " ").replace(/(?<=\w)-(?=\w)/g, " ").replace(/\s+/g, " ").trim();
const cap = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** A readable name and place for an address the captain saved without a label. */
export function describeLink(href: string, type: LinkType, artifact?: string): { title: string; where: string } {
  if (artifact) return { title: "Artifact", where: "Joyride artifact" };
  if (type === "file" || (type === "pdf" && !/^https?:/i.test(href))) {
    const parts = href.split("/").filter(Boolean);
    const file = parts.pop() ?? href;
    const dir = parts.length ? (href.startsWith("~") ? "~/" : "/") + parts.slice(href.startsWith("~") ? 1 : 0).slice(-2).join("/") : "";
    return { title: cap(words(file.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) || file, where: dir || "Local file" };
  }
  let u: URL;
  try { u = new URL(href); } catch { return { title: href, where: "" }; }
  const host = u.hostname.replace(/^www\./, "");
  if (type === "artifact") return { title: "Claude artifact", where: host };
  const segs = u.pathname.split("/").filter(Boolean).map(safeDecode);
  if (type === "pdf") {
    const file = segs[segs.length - 1] ?? "document.pdf";
    return { title: cap(words(file.replace(/\.pdf$/i, ""))) || file, where: host };
  }
  // A forge's pull request or issue reads as "owner/repo #12".
  const forge = /^(?:github\.com|gitlab\.com)$/.test(host) && segs.length >= 4 && /^(pull|pulls|issues|merge_requests)$/.test(segs[2] === "-" ? segs[3] : segs[2]);
  if (forge) {
    const n = segs[segs.length - 1];
    const what = /issues/.test(segs.join("/")) ? "issue" : "PR";
    return { title: `${segs[0]}/${segs[1]} ${what} #${n}`, where: host };
  }
  if (/^(?:github\.com|gitlab\.com)$/.test(host) && segs.length === 2) return { title: `${segs[0]}/${segs[1]}`, where: host };
  // The last readable path segment, else the site itself.
  const last = [...segs].reverse().find((s) => /[A-Za-z]{3}/.test(s) && !/^(index|default)\.\w+$/i.test(s));
  if (last) return { title: cap(words(last.replace(/\.(html?|php|aspx?)$/i, ""))).slice(0, 80), where: host };
  return { title: host, where: host };
}

/** A link line as the captain saved it: "[label](href)", a bare address, or "[label](href) - why". */
export function parseLink(line: string): { link: Link; note?: string } | null {
  const t = line.trim();
  const md = MD_LINK_RE.exec(t);
  if (md) {
    const target = linkTarget(md[2]);
    if (!target) return null;
    const d = describeLink(target.href, target.type, target.artifact);
    const label = md[1].trim();
    return { link: { ...target, title: label || d.title, where: d.where, derived: !label }, ...(md[3]?.trim() ? { note: md[3].trim() } : {}) };
  }
  // "https://x.pdf Quarterly plan" or "Quarterly plan https://x.pdf": an address and a label on one line.
  const parts = t.split(/\s+/);
  const at = parts.findIndex((p) => linkTarget(p));
  if (at < 0 || (at !== 0 && at !== parts.length - 1)) return null;
  const target = linkTarget(parts[at])!;
  const rest = [...parts.slice(0, at), ...parts.slice(at + 1)].join(" ").replace(/^[-–—:·]\s*|\s*[-–—:·]$/g, "").trim();
  const d = describeLink(target.href, target.type, target.artifact);
  if (rest && rest.split(/\s+/).length > 12) return null; // a sentence that mentions a link is text
  return { link: { ...target, title: rest || d.title, where: d.where, derived: !rest } };
}

/** A line that is only a link: "[label](address)" or a bare address, never words beside one. */
export function strictLink(line: string): { link: Link; note?: string } | null {
  const t = line.trim();
  return MD_LINK_RE.test(t) || linkTarget(t) ? parseLink(t) : null;
}

/** One line of an item as what it is. */
export function parseBlock(line: string): Block {
  const todo = TODO_RE.exec(line);
  if (todo) return { kind: "todo", done: todo[1] !== " ", text: line.slice(todo[0].length).trim() };
  const link = parseLink(line);
  if (link) return { kind: "link", ...link };
  return { kind: "text", text: line };
}
export const parseBlocks = (lines: string[]): Block[] => lines.map(parseBlock);

/** A block back as the line it is stored as. */
export function blockLine(b: Block): string {
  if (b.kind === "todo") return `[${b.done ? "x" : " "}] ${b.text.replace(/\s+/g, " ").trim()}`;
  if (b.kind === "text") return b.text;
  const href = b.link.artifact ? `artifact:${b.link.artifact}` : b.link.href;
  const label = b.link.derived ? "" : b.link.title;
  return `${label ? `[${label.replace(/[[\]]/g, "")}](${href})` : href}${b.note ? ` - ${b.note}` : ""}`;
}
/** A link as a stored line: "[title](href)", or the bare address when it has no title. */
export const linkLine = (href: string, title?: string | null) => blockLine({ kind: "link", link: { href, type: "url", title: title?.trim() || href, where: "", derived: !title?.trim() } });

/** What an item is, from its lines. */
export function itemKind(lines: string[]): ItemKind {
  const bs = parseBlocks(lines);
  if (!bs.length) return "note";
  if (bs.every((b) => b.kind === "todo")) return "list";
  if (bs.every((b) => b.kind === "link")) return "link";
  if (bs.every((b) => b.kind === "text")) return "note";
  return "mixed";
}

export const ITEM_NOUN: Record<ItemKind, string> = { note: "note", list: "list", link: "link", mixed: "note" };
export const ITEM_LABEL: Record<ItemKind, string> = { note: "Note", list: "List", link: "Link", mixed: "Mixed" };

/** Ticked and total todos anywhere in an item (a list, or a mixed item's checkboxes). */
export function todoCount(lines: string[]): { done: number; total: number } {
  let done = 0, total = 0;
  for (const b of parseBlocks(lines)) if (b.kind === "todo") { total++; if (b.done) done++; }
  return { done, total };
}

/** A list saved without a name of its own (shared/notes.ts LIST_TITLE). */
const UNNAMED = new Set(["List", ""]);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** What an item is called in one line: a list's name, a link's title, else its first line. */
export function itemLabel(item: { title?: string | null; bullets: string[] }, max = 60): string {
  const kind = itemKind(item.bullets);
  const bs = parseBlocks(item.bullets);
  const named = item.title && !UNNAMED.has(item.title.trim()) ? item.title.trim() : null;
  // An unnamed list reads as its first items.
  if (kind === "list") return clip(named ?? (bs.map((b) => (b.kind === "todo" ? b.text : "")).filter(Boolean).join(", ") || "List"), max);
  if (kind === "link") return clip(bs.length === 1 && bs[0].kind === "link" ? bs[0].link.title : named ?? `${bs.length} links`, max);
  const first = bs[0];
  const line = !first ? named ?? "Note" : first.kind === "link" ? first.link.title : first.text;
  return clip(line || "Note", max);
}

/** Text a search matches: the title, every line, and each link's readable title and place. */
export function itemText(item: { title?: string | null; bullets: string[] }): string {
  const parts = [item.title ?? ""];
  for (const b of parseBlocks(item.bullets)) parts.push(b.kind === "link" ? `${b.link.title} ${b.link.where} ${b.link.href} ${b.note ?? ""}` : b.text);
  return parts.join(" \n ").toLowerCase();
}
