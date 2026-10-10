// Small shared pieces for the knowledge views: markdown, kind marks, scope
// and provenance labels, and a busy/error hook for action buttons.
import { Fragment, useCallback, useState, type ReactNode } from "react";
import { href } from "../../lib/router";
import { repoLabel } from "../../lib/api";
import "./knowledge.css";
export { kindLabel } from "./model";

// ---------- markdown (headings, lists, code, emphasis, links; no raw HTML) ----------
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)|(\*[^*\s][^*]*\*)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{s.slice(2, -2)}</strong>);
    else if (m[3]) { const mm = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!; out.push(/^(https?:|mailto:|#|\/(?!\/))/.test(mm[2]) ? <a key={k} href={mm[2]} target={mm[2].startsWith("#/") ? undefined : "_blank"} rel="noreferrer">{mm[1]}</a> : <span key={k}>{mm[1]}</span>); }
    else if (m[4]) out.push(<a key={k} href={s} target="_blank" rel="noreferrer">{s}</a>);
    else out.push(<em key={k}>{s.slice(1, -1)}</em>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** `doc` renders a whole document: heading levels, tables, quotes and rules (the default keeps short notes compact). */
export function Markdown({ text, small, doc }: { text: string; small?: boolean; doc?: boolean }) {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (doc && /^\s*\|/.test(l) && TABLE_RULE.test(lines[i + 1] ?? "")) {
      const head = cells(l); i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      blocks.push(
        <div className="k-table-wrap" key={k++}><table className="k-table">
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, k * 100 + j)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "", k * 1000 + ri * 50 + j)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (doc && /^\s*>/.test(l)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={k++}>{inline(q.join(" "), k)}</blockquote>);
      continue;
    }
    if (doc && /^\s*(---+|\*\*\*+|___+)\s*$/.test(l)) { blocks.push(<hr key={k++} />); i++; continue; }
    if (doc) {
      const dh = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (dh) {
        const level = Math.min(dh[1].length + 1, 5);
        const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5";
        blocks.push(<Tag key={k++} className="k-doc-h">{inline(dh[2], k)}</Tag>);
        i++;
        continue;
      }
    }
    if (/^```/.test(l)) {
      const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) { blocks.push(<h4 key={k++}>{inline(h[2], k)}</h4>); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(item);
      }
      const kids = items.map((it, j) => <li key={j}>{inline(it, k * 100 + j)}</li>);
      blocks.push(ordered ? <ol key={k++}>{kids}</ol> : <ul key={k++}>{kids}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*]|\d+\.)\s+)/.test(lines[i]) && !(doc && /^\s*(\||>)/.test(lines[i]))) para.push(lines[i++].trim());
    if (!para.length) para.push(lines[i++].trim());
    blocks.push(<p key={k++}>{inline(para.join(" "), k)}</p>);
  }
  return <div className={`k-md${small ? " small" : ""}${doc ? " doc" : ""}`}>{blocks.length ? blocks : <p className="muted">No text.</p>}</div>;
}

/** Busy + error state for one async button action. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (...a: A) => {
    setBusy(true); setError(null);
    try { return await fn(...a); } catch (e: any) { setError(e.message ?? String(e)); return undefined; } finally { setBusy(false); }
  }, [fn]);
  return { run, busy, error, setError };
}

export function SearchBox({ value, onChange, placeholder, inputRef }: { value: string; onChange: (v: string) => void; placeholder: string; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <label className="k-search">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <input ref={inputRef} className="input" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <span className="k-seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={v} className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>)}
    </span>
  );
}

export const joinNodes = (nodes: ReactNode[]) => nodes.filter(Boolean).map((n, i) => <Fragment key={i}>{n}</Fragment>);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
