// Artifact auto-detection over Claude Code transcripts. Line-oriented and
// incremental: a cheap substring prefilter runs before JSON.parse, so large
// transcripts cost little. Detects
//   - Artifact tool publishes (tool_result + toolUseResult {url, path, title})
//   - claude.ai artifact, ChatGPT and GitHub/Bitbucket PR links in human
//     prompts and assistant text
import { parseJson } from "../sessions/lines.ts";
import { humanPrompt } from "../sessions/claude.ts";
import { findLinks, normalizeUrl, type ArtifactKind } from "./store.ts";

export type Detected = {
  url: string;
  kind: ArtifactKind;
  via: "artifact-tool" | "transcript";
  title: string | null;
  description: string | null;
  local_source: string | null;
  ts: string | null;
  role: "user" | "assistant" | "tool";
};

const HINT = /claude\.ai|chatgpt\.com|chat\.openai\.com|github\.com\/[^"\s]+\/pull\/|bitbucket\.org\/[^"\s]+\/pull-requests\/|"name":"Artifact"/;
const PUBLISHED = /Published (\S+) at (https:\/\/claude\.ai\/\S+)/;

/** Per-file scan state that survives incremental reads (pending Artifact tool calls). */
export type ScanState = { pending: Record<string, { file_path: string | null; title: string | null; description: string | null; action: string | null }> };
export const newScanState = (): ScanState => ({ pending: {} });

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
}

/** Feed one transcript line; returns the artifacts it reveals. */
export function detectLine(line: string, st: ScanState): Detected[] {
  if (!HINT.test(line)) return [];
  const r = parseJson(line);
  if (!r || (r.type !== "user" && r.type !== "assistant")) return [];
  const ts = typeof r.timestamp === "string" ? r.timestamp : null;
  const out: Detected[] = [];
  const content = r.message?.content;

  if (r.type === "assistant") {
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use" && b.name === "Artifact" && typeof b.id === "string") {
          const inp = b.input ?? {};
          st.pending[b.id] = {
            file_path: typeof inp.file_path === "string" ? inp.file_path : null,
            title: typeof inp.title === "string" ? inp.title : null,
            description: typeof inp.description === "string" ? inp.description : null,
            action: typeof inp.action === "string" ? inp.action : null,
          };
        }
      }
    }
    for (const l of findLinks(textBlocks(content))) out.push({ ...l, via: "transcript", title: null, description: null, local_source: null, ts, role: "assistant" });
    return out;
  }

  // user records: tool results (Artifact publishes) or human prompts
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
    for (const b of content) {
      if (b?.type !== "tool_result" || b.is_error) continue;
      const pend = st.pending[b.tool_use_id];
      if (!pend) continue;
      delete st.pending[b.tool_use_id];
      if (pend.action && pend.action !== "publish") continue; // read, list, upload_asset, ...
      const tur = r.toolUseResult && typeof r.toolUseResult === "object" ? r.toolUseResult : null;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? "").join("\n") : "";
      const m = text.match(PUBLISHED);
      const url = typeof tur?.url === "string" ? tur.url : m?.[2] ?? null;
      if (!url || !/claude\.ai\//.test(url)) continue;
      out.push({
        url: normalizeUrl(url), kind: "claude-artifact", via: "artifact-tool",
        title: typeof tur?.title === "string" && tur.title.trim() ? tur.title.trim() : pend.title,
        description: pend.description,
        local_source: typeof tur?.path === "string" ? tur.path : pend.file_path ?? m?.[1] ?? null,
        ts, role: "tool",
      });
    }
    return out;
  }
  const p = humanPrompt(r);
  if (p && !p.command) for (const l of findLinks(p.text)) out.push({ ...l, via: "transcript", title: null, description: null, local_source: null, ts, role: "user" });
  return out;
}
