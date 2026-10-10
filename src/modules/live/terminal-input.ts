// Browser terminal input -> Herdr. xterm.js hands us the bytes a terminal would
// send (onData); we turn them into Herdr's logical keys where Herdr has one,
// because Herdr encodes keys for the pane's live terminal modes (application
// cursor keys, kitty keyboard protocol) and the browser mirror can't know those.
// Printable runs and sequences Herdr has no key for (Home, End, Delete, PageUp,
// bracketed paste) go through as literal text, which pane.send_text writes raw.

export type InputOp = { text: string } | { keys: string[]; raw: string[] };

const ARROW: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
const MOD: Record<string, string> = { "2": "shift", "3": "alt", "4": "shift+alt", "5": "ctrl", "6": "ctrl+shift", "7": "ctrl+alt", "8": "ctrl+shift+alt" };
const TILDE_FN: Record<string, string> = { "11": "f1", "12": "f2", "13": "f3", "14": "f4", "15": "f5", "17": "f6", "18": "f7", "19": "f8", "20": "f9", "21": "f10", "23": "f11", "24": "f12" };
const CTRL_PUNCT: Record<number, string> = { 0: "ctrl+space", 0x1c: "ctrl+backslash", 0x1d: "ctrl+]", 0x1f: "ctrl+_" };

/** Split xterm onData output into ordered text and key operations (adjacent ones merged). */
export function inputOps(data: string): InputOp[] {
  const ops: InputOp[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = ops[ops.length - 1];
    if (last && "text" in last) last.text += t; else ops.push({ text: t });
  };
  const key = (k: string, raw: string) => {
    const last = ops[ops.length - 1];
    if (last && "keys" in last) { last.keys.push(k); last.raw.push(raw); } else ops.push({ keys: [k], raw: [raw] });
  };
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    const code = data.charCodeAt(i);
    if (ch === "\x1b") {
      const rest = data.slice(i);
      let m: RegExpMatchArray | null;
      if (rest.startsWith("\x1b[200~")) { // bracketed paste: the app takes it as one paste
        const end = data.indexOf("\x1b[201~", i);
        const stop = end < 0 ? data.length : end + 6;
        text(data.slice(i, stop)); i = stop; continue;
      }
      if ((m = rest.match(/^\x1b\[(?:1;([2-8]))?([ABCD])/))) { key((m[1] ? MOD[m[1]] + "+" : "") + ARROW[m[2]], m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^\x1bO([ABCD])/))) { key(ARROW[m[1]], m[0]); i += m[0].length; continue; }
      if (rest.startsWith("\x1b[Z")) { key("shift+tab", "\x1b[Z"); i += 3; continue; }
      if ((m = rest.match(/^\x1bO([PQRS])/))) { key(`f${"PQRS".indexOf(m[1]) + 1}`, m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^\x1b\[(\d+)(;[2-8])?~/))) { const f = TILDE_FN[m[1]]; if (f && !m[2]) key(f, m[0]); else text(m[0]); i += m[0].length; continue; }
      if ((m = rest.match(/^\x1b\[[IO]/))) { i += m[0].length; continue; } // focus in/out reports: not input
      if ((m = rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)) || (m = rest.match(/^\x1bO[@-~]/))) { text(m[0]); i += m[0].length; continue; } // Home/End and friends: raw
      const n = data[i + 1];
      if (n === "\x7f") { key("alt+backspace", "\x1b\x7f"); i += 2; continue; }
      if (n === "\r") { key("alt+enter", "\x1b\r"); i += 2; continue; }
      if (n && /^[a-z0-9]$/.test(n)) { key(`alt+${n}`, `\x1b${n}`); i += 2; continue; }
      if (n && n !== "\x1b" && n.charCodeAt(0) >= 0x20) { text(`\x1b${n}`); i += 2; continue; }
      key("esc", "\x1b"); i += 1; continue;
    }
    if (ch === "\r") { key("enter", ch); i++; continue; }
    if (ch === "\x7f" || ch === "\b") { key("backspace", ch); i++; continue; }
    if (ch === "\t") { key("tab", ch); i++; continue; }
    if (ch === "\n") { key("ctrl+j", ch); i++; continue; }
    if (CTRL_PUNCT[code]) { key(CTRL_PUNCT[code], ch); i++; continue; }
    if (code >= 1 && code <= 26) { key(`ctrl+${String.fromCharCode(code + 96)}`, ch); i++; continue; }
    if (code < 0x20) { text(ch); i++; continue; } // ctrl+^ and other strays: raw
    text(ch); i++;
  }
  return ops;
}

/** Explicit keys from the API (quick-key buttons): Herdr's own names, validated loosely here and strictly by Herdr. */
export function validKeyName(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && k.length <= 32 && /^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]+|[\x21-\x7e])$/i.test(k);
}

/** One line for logs and the API response: "text(5) enter" (never the typed text itself). */
export function describeOps(ops: InputOp[]): string[] {
  return ops.map((o) => ("text" in o ? `text(${[...o.text].length})` : o.keys.join(" ")));
}
