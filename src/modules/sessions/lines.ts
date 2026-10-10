// Async JSONL line reader that starts at a byte offset and reports how far it
// consumed (up to the last complete line), so parsers can resume incrementally.
import fs from "node:fs";

const CHUNK = 64 << 10;

/**
 * Calls onLine for every complete line from `start`. Returns the byte offset
 * just past the last complete line (a partial trailing line is left for the
 * next call). Yields to the event loop between chunks.
 */
export async function readLines(file: string, start: number, onLine: (line: string) => void): Promise<{ end: number; size: number }> {
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size;
    let pos = start;
    let consumed = start;
    let carry: Buffer | null = null;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const data: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let from = 0;
      let idx: number;
      while ((idx = data.indexOf(10, from)) !== -1) {
        if (idx > from) onLine(data.toString("utf8", from, idx));
        consumed += idx - from + 1;
        from = idx + 1;
      }
      carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { end: consumed, size };
  } finally {
    await fh.close();
  }
}

export function parseJson(line: string): any {
  try { return JSON.parse(line); } catch { return null; }
}

/** One-line, trimmed, truncated text for titles and summaries. */
export function oneLine(s: string | null | undefined, n: number): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Cap long text but keep line breaks (transcript bodies). */
export function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** ["bash", "-lc", "git status"] -> "git status"; other argv arrays are joined. */
export function argv(a: unknown[]): string {
  const s = a.map(String);
  if (s.length === 3 && /(^|\/)(ba|z)?sh$/.test(s[0]) && /^-l?c$/.test(s[1])) return s[2];
  return s.join(" ");
}

/** Short human summary of a tool call input, for transcript drill-in. */
export function toolSummary(name: string, input: any): string {
  if (input == null) return "";
  if (typeof input === "string") {
    const parsed = parseJson(input);
    if (parsed && typeof parsed === "object") return toolSummary(name, parsed);
    return oneLine(input, 160);
  }
  if (Array.isArray(input)) return oneLine(argv(input), 160);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v) return v;
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return argv(v);
    }
    return null;
  };
  const s =
    pick("command", "cmd") ??
    pick("file_path", "notebook_path", "path") ??
    pick("pattern", "query", "url", "description", "prompt", "title", "message", "skill", "task_name", "target") ??
    Object.values(input).find((v) => typeof v === "string") as string | undefined ??
    "";
  return oneLine(s, 160);
}
