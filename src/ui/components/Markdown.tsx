// Light, safe markdown for agent messages: paragraphs (single newlines kept),
// headings, lists (nested by indent), fenced code, block quotes, tables, rules,
// and inline `code`, **bold**, *em*, ~~strike~~ and http(s) links. It builds
// React nodes, never HTML strings, so transcript text can't inject markup.
import { createContext, Fragment, useContext, type ReactNode } from "react";
import { ImageGallery, ImagePreview, type ChatImage } from "./ImageGallery";
import "./chat.css";

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; children: string }[] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push({ t: "h", level: h[1].length, text: h[2] }); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ t: "hr" }); i++; continue; }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      out.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ t: "table", head, rows });
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: { text: string; children: string }[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST);
        if (m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered) { items.push({ text: m[3], children: "" }); i++; continue; }
        if (!l.trim()) {
          // A blank line ends the list unless the next line continues it.
          const nx = lines[i + 1];
          if (nx && ((nx.match(LIST) && nx.match(LIST)![1].length >= base) || /^\s{2,}\S/.test(nx))) { i++; continue; }
          break;
        }
        if (!items.length || (!/^\s/.test(l) && !m)) break;
        const it = items[items.length - 1];
        if (m || /^\s{2,}/.test(l)) it.children += (it.children ? "\n" : "") + l.slice(Math.min(base + 2, l.length - l.trimStart().length));
        else it.text += "\n" + l.trim();
        i++;
      }
      out.push({ t: "list", ordered, start: ordered ? parseInt(li[2], 10) || 1 : 1, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>)/.test(lines[i]) && !(para.length && LIST.test(lines[i]))) para.push(lines[i++]);
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

const INLINE = /(!\[[^\]\n]*\]\((?:https?:\/\/|\/api\/uploads\/)[^)\s]+\)|`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|\[[^\]\n]+\]\((?:https?:\/\/|mailto:|#\/)[^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|(?<![\w*])\*(?!\s)[^*\n]+?(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)[^_\n]+?(?<!\s)_(?![\w_]))/g;

const MarkdownGallery = createContext<ChatImage[] | null>(null);
const IMAGE = /!\[([^\]\n]*)\]\(((?:https?:\/\/|\/api\/uploads\/)[^)\s]+)\)/g;
export function markdownImages(text: string): ChatImage[] {
  return [...text.matchAll(IMAGE)].map((m) => ({ src: m[2], label: m[1] || "Image" }));
}

export function Inline({ text }: { text: string }): ReactNode {
  const images = useContext(MarkdownGallery) ?? [];
  const parts = text.split(INLINE);
  return parts.map((p, i) => {
    if (i % 2 === 0) {
      const segs = p.split("\n");
      return <Fragment key={i}>{segs.map((s, j) => <Fragment key={j}>{j ? <br /> : null}{s}</Fragment>)}</Fragment>;
    }
    if (p.startsWith("![")) {
      const image = markdownImages(p)[0];
      return image ? <ImagePreview key={i} image={image} index={images.findIndex((x) => x.src === image.src)} /> : p;
    }
    if (p.startsWith("`")) return <code key={i} className="md-code">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") || p.startsWith("__")) return <strong key={i}><Inline text={p.slice(2, -2)} /></strong>;
    if (p.startsWith("~~")) return <s key={i}>{p.slice(2, -2)}</s>;
    if (p.startsWith("[")) {
      const m = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      return <a key={i} href={m[2]} target={m[2].startsWith("#/") ? undefined : "_blank"} rel="noreferrer noopener">{m[1]}</a>;
    }
    if (/^https?:/.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="md-url">{p}</a>;
    return <em key={i}>{p.slice(1, -1)}</em>;
  });
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case "p": return <p><Inline text={b.text} /></p>;
    case "h": return <p className={`md-h md-h${Math.min(b.level, 3)}`}><Inline text={b.text} /></p>;
    case "hr": return <hr />;
    case "code": return <pre className="md-pre" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
    case "quote": return <blockquote><Markdown text={b.text} /></blockquote>;
    case "table":
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr>{b.head.map((c, i) => <th key={i}><Inline text={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{b.head.map((_, j) => <td key={j}><Inline text={r[j] ?? ""} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "list": {
      const items = b.items.map((it, i) => <li key={i}><Inline text={it.text} />{it.children.trim() ? <Markdown text={it.children} /> : null}</li>);
      return b.ordered ? <ol start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
  }
}

export function Markdown({ text, className, images }: { text: string; className?: string; images?: ChatImage[] }) {
  const inherited = useContext(MarkdownGallery);
  const gallery = inherited ?? images ?? markdownImages(text);
  const blocks = parseBlocks(text ?? "");
  const body = <div className={`md${className ? ` ${className}` : ""}`}>{blocks.map((b, i) => <BlockView key={i} b={b} />)}</div>;
  return inherited ? body : <MarkdownGallery.Provider value={gallery}><ImageGallery images={gallery}>{body}</ImageGallery></MarkdownGallery.Provider>;
}
