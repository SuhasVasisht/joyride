// Reading an agent's visible terminal and finding the option that matches a choice.
import type { HerdrApi } from "./herdr.ts";

export function screenText(r: any): string {
  const text = r?.read?.text ?? r?.text ?? r?.content ?? r?.output ?? (Array.isArray(r?.lines) ? r.lines.join("\n") : typeof r === "string" ? r : JSON.stringify(r ?? ""));
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Only used for checkouts Joyride owns, under the launcher's autoTrust flag. */
export function codexHookTrustKeys(screen: string): string[] | null {
  if (!/Hooks need review/.test(screen)) return null;
  const option = screen.match(/^\s*[›❯]?\s*([1-9])\. Trust all and continue\s*$/m);
  return option ? [option[1], "enter"] : null;
}

/** The visible part of a Herdr pane (last ~40 lines), ANSI stripped. */
export async function readScreen(herdr: HerdrApi, pane: string, machine?: string): Promise<string> {
  try {
    const r: any = await herdr.call("pane.read", { pane_id: pane, source: "visible", lines: 60, strip_ansi: true }, { machine });
    return screenText(r);
  } catch { return ""; }
}

const NUMBERED = /^[\s│|>❯›*]*([1-9])[.)]\s+(.+?)\s*[│|]?\s*$/;

const YES_NO = /\(y\/n\)|\[y\/n\]|\(y\)es|yes \(y\)/i;

const MENU_FOOTER = /^(?:esc to (?:cancel|exit)|enter to (?:confirm|select)|press enter to continue)(?:\s|$)/i;
const menuLine = (line: string) => line.replace(/^\s*[│|]\s?/, " ").replace(/\s+[│|]\s*$/, " ").trim();

/**
 * The last numbered menu, counting up from 1. Wrapped labels must be indented to
 * the label column, so unrelated text cannot bridge two runs of numbered lines.
 */
export function menuBlock(lines: string[]): { first: number; last: number; opts: { key: string; label: string }[]; tail: number } | null {
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (NUMBERED.test(lines[i])) { last = i; break; }
  if (last < 0) return null;
  const top = lines[last].match(NUMBERED);
  if (!top) return null;
  const starts = [last];
  let expected = Number(top[1]) - 1;
  for (let i = last - 1; i >= 0 && expected > 0; i--) {
    const m = lines[i].match(NUMBERED);
    if (m) {
      if (Number(m[1]) !== expected) return null;
      starts.unshift(i);
      expected--;
    } else if (!lines[i].trim()) return null;
  }
  if (expected !== 0) return null;
  const opts: { key: string; label: string }[] = [];
  let end = last;
  for (const [n, start] of starts.entries()) {
    const m = lines[start].match(NUMBERED);
    if (!m) return null;
    const column = lines[start].indexOf(m[2]);
    const parts = [m[2].trim()];
    const next = starts[n + 1];
    for (let i = start + 1; i < (next ?? lines.length); i++) {
      const text = menuLine(lines[i]);
      const indent = lines[i].match(/^[\s│|]*/)?.[0].length ?? 0;
      if (!text || MENU_FOOTER.test(text) || indent < column) {
        if (next !== undefined) return null;
        break;
      }
      parts.push(text);
      if (next === undefined) end = i;
    }
    opts.push({ key: m[1], label: parts.join(" ") });
  }
  return { first: starts[0], last: end, opts, tail: lines.slice(end + 1).filter((l) => l.trim()).length };
}

/**
 * Find the menu option for a choice on a Claude Code / Codex prompt screen. `strict` (a guarded
 * answer from Firstmate) takes only an option of the prompt's own menu at the bottom of the screen
 * whose label says it is that choice, never the first or last option as a fallback.
 */
export function pickOption(screen: string, choice: "allow" | "allow_always" | "deny", opts0: { strict?: boolean } = {}): { keys: string[]; label: string } | null {
  const lines = screen.split("\n").slice(-40);
  const block = menuBlock(lines);
  if (opts0.strict) {
    // A malformed numbered menu must not fall through to cursor or y/n guessing.
    if (!block && lines.some((l) => NUMBERED.test(l))) return null;
    if (block && lines.slice(block.last + 1).some((l) => {
      const text = menuLine(l);
      return text && !MENU_FOOTER.test(text) && !/^[╰╯╚╝─━═╌╍┄┅┈┉]+$/.test(text);
    })) return null;
  }
  const opts = block?.opts ?? [];
  const autoMode = (l: string) => /\bauto mode\b/i.test(l);
  const always = (l: string) => /don.?t ask|always|for this session|remember/i.test(l);
  if (opts.length) {
    const matches = opts.filter((x) => {
      if (autoMode(x.label)) return false;
      if (choice === "allow") return /^(yes|allow|approve|proceed|ok)\b/i.test(x.label) && !always(x.label);
      if (choice === "allow_always") return /^(yes|allow|approve)\b/i.test(x.label) && always(x.label);
      return /^(no|deny|reject|cancel)\b/i.test(x.label);
    });
    if (opts0.strict && matches.length !== 1) return null;
    const o = matches[0] ?? (!opts0.strict && choice !== "allow_always" ? (choice === "deny" ? opts.at(-1) : opts[0]) : undefined);
    return o && !autoMode(o.label) ? { keys: [o.key], label: o.label } : null;
  }
  // Arrow-cursor menus (Claude Code's trust dialog and similar): "❯ No, exit" / "  Yes, I trust…" + "Enter to confirm".
  // The LAST cursor line: shell prompts like "❯ claude" higher up the screen use the same glyph.
  let cursorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*[❯›>]\s+\S/.test(lines[i])) { cursorIdx = i; break; }
  if (cursorIdx >= 0 && lines.slice(cursorIdx).some((l) => /enter to (confirm|select)/i.test(l))) {
    const items: { label: string; idx: number }[] = [];
    for (let i = cursorIdx; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:[❯›>]\s+)?(\S.*?)\s*$/);
      if (!lines[i].trim() || /enter to (confirm|select)|esc to/i.test(lines[i])) break;
      if (m) items.push({ label: m[1], idx: i });
    }
    // include options above the cursor line (cursor may not be on the first one)
    for (let i = cursorIdx - 1; i >= 0 && lines[i].trim() && /^\s{2,}\S/.test(lines[i]); i--) items.unshift({ label: lines[i].trim(), idx: i });
    const cur = items.findIndex((x) => x.idx === cursorIdx);
    let t = -1;
    if (choice === "deny") t = items.findIndex((x) => /^(no|deny|reject|cancel|exit)/i.test(x.label));
    else if (choice === "allow_always") t = items.findIndex((x) => !autoMode(x.label) && /^(yes|allow)/i.test(x.label) && always(x.label));
    else t = items.findIndex((x) => !autoMode(x.label) && /^(yes|allow|approve|proceed|ok|trust)/i.test(x.label) && !always(x.label));
    if (t < 0 || cur < 0) return null;
    const moves = t > cur ? Array(t - cur).fill("down") : Array(cur - t).fill("up");
    return { keys: [...moves, "enter"], label: items[t].label };
  }
  // A y/n question: for a guarded answer only on the last lines of the screen, and never as "always".
  const tail = opts0.strict ? lines.filter((l) => l.trim()).slice(-3).join("\n") : lines.join("\n");
  if (YES_NO.test(tail)) {
    if (opts0.strict && choice === "allow_always") return null;
    return choice === "deny" ? { keys: ["n", "enter"], label: "n" } : { keys: ["y", "enter"], label: "y" };
  }
  return null;
}


/**
 * The prompt the agent shows, as recorded with an answer: its question (the lines just above the
 * options, box drawing stripped) and the options it offers. Null when no menu or y/n question is on screen.
 */
export function promptOf(screen: string): { question: string; options: string[] } | null {
  const raw = screen.split("\n").slice(-40);
  const lines = raw.map((l) => l.replace(/[│┃║╭╮╰╯╔╗╚╝─━═╌╍┄┅┈┉]+/g, " ").replace(/\s+$/, ""));
  // Claude Code's hint line above its permission menu ("Tip: auto mode handles these prompts…") is not the question.
  const strip = (l: string) => { const t = l.replace(/^[\s>❯›*]+/, "").trim(); return /^tip:/i.test(t) ? "" : t; };
  const block = menuBlock(lines);
  if (!block) {
    let yn = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (YES_NO.test(lines[i])) { yn = i; break; }
    if (yn < 0) return null;
    return { question: strip(lines[yn]), options: ["y", "n"] };
  }
  const first = block.first;
  const options = block.opts.map((o) => `${o.key}. ${o.label}`);
  const above: string[] = [];
  for (let i = first - 1; i >= 0 && above.length < 4; i--) {
    const t = strip(lines[i]);
    // A blank line ends the question; a rule or a tip line inside it is skipped.
    if (!t) { if (above.length && !raw[i].trim()) break; continue; }
    above.unshift(t);
  }
  return { question: above.join(" ").slice(-300), options };
}
