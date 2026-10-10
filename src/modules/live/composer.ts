// What already sits in an agent's input box, read off its styled screen, and how
// to empty it before Joyride relays a reply. agent.prompt pastes at the input's
// cursor and presses Enter, so any text already there (an old prompt recalled
// from history by an arrow key, a half-typed draft) would go out merged with
// the reply.
//   Claude Code: the input row starts "❯" + no-break space, between two rules;
//                the cursor is an inverse cell; placeholder hints are dim.
//   Codex:       the input row starts "› ", runs to the next blank line; the
//                placeholder ("Ask Codex to do anything") is dim.
// Both edit with Ctrl+K (kill to the end of the row, or the line break at its end),
// Ctrl+U (kill to the start of the row) and Backspace, which do nothing in an
// empty input (Backspace leaves Claude Code's queue of waiting messages alone).
// Ctrl+C and Esc are never used: they arm "press again to exit", open rewind, or
// interrupt a running turn.
// While the agent works, the input box is never cleared: Up there pops the messages
// queued for the end of the turn back into the box (Claude Code), so its text may be
// the human's own queued replies rather than a stale recall.

export type Composer = { found: boolean; text: string; rows: number };

type Cell = { ch: string; dim: boolean; inverse: boolean };

/** Split ANSI text into rows of cells that remember dim and inverse styling. */
export function styledRows(ansi: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let dim = false, inverse = false;
  const sgr = (params: string) => {
    const p = params.split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0) { dim = false; inverse = false; }
      else if (n === 2) dim = true;
      else if (n === 22) dim = false;
      else if (n === 7) inverse = true;
      else if (n === 27) inverse = false;
      else if (n === 38 || n === 48 || n === 58) i += p[i + 1] === 5 ? 2 : p[i + 1] === 2 ? 4 : 0;
    }
  };
  for (let i = 0; i < ansi.length; i++) {
    const ch = ansi[i];
    if (ch === "\x1b") {
      const rest = ansi.slice(i);
      const csi = rest.match(/^\x1b\[([0-?]*)[ -/]*([@-~])/);
      if (csi) { if (csi[2] === "m") sgr(csi[1]); i += csi[0].length - 1; continue; }
      const osc = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
      i += osc ? osc[0].length - 1 : 1;
      continue;
    }
    if (ch === "\n") { rows.push(row); row = []; continue; }
    if (ch === "\r") continue;
    row.push({ ch, dim, inverse });
  }
  rows.push(row);
  return rows;
}

const plain = (r: Cell[]) => r.map((c) => c.ch).join("");

/** The input's text: placeholder (dim) cells and the cursor cell left out. */
function inputText(rows: Cell[][]): string {
  const lines = rows.map((r) => {
    const kept = r.filter((c, i) => {
      if (c.dim) return false;
      // The cursor: a blank inverse cell, or the first letter of a dim placeholder drawn under it.
      if (c.inverse && (c.ch.trim() === "" || r[i + 1]?.dim)) return false;
      return true;
    });
    return plain(kept).trimEnd();
  });
  return lines.join("\n").trim();
}

/** Find the agent's input box on its screen (pane.read, format ansi). */
export function readComposer(ansi: string, agent: string | null | undefined): Composer {
  const rows = styledRows(ansi);
  const text = rows.map(plain);
  const none: Composer = { found: false, text: "", rows: 0 };
  const isRule = (s: string | undefined) => Boolean(s && /^─{3,}/.test(s));
  if (agent === "claude") {
    for (let i = rows.length - 1; i > 0; i--) {
      // "❯" + no-break space is the input; "❯ " with a plain space is an echoed prompt or a shell prompt.
      if (!(text[i].startsWith("❯\u00a0") || text[i].trimEnd() === "❯") || !isRule(text[i - 1])) continue;
      let end = i + 1;
      while (end < rows.length && !isRule(text[end])) end++;
      if (end >= rows.length) return none;
      return { found: true, text: inputText(rows.slice(i, end).map((r) => r.slice(2))), rows: end - i };
    }
    return none;
  }
  if (agent === "codex") {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!text[i].startsWith("› ")) continue;
      let end = i + 1;
      while (end < rows.length && text[end].trim() && text[end].startsWith("  ")) end++;
      return { found: true, text: inputText(rows.slice(i, end).map((r) => r.slice(2))), rows: end - i };
    }
    return none;
  }
  if (agent === "cursor") {
    for (let i = rows.length - 1; i >= 0; i--) {
      const arrow = text[i].match(/^\s*→ /);
      if (!arrow || !text.slice(i + 1).some((line) => line.includes("Run Everything") || /^\s*Press Ctrl\+C again to exit\s*$/.test(line))) continue;
      const offset = arrow[0].length;
      let end = i + 1;
      while (end < rows.length && text[end].trim() && text[end].startsWith(" ".repeat(offset))) end++;
      return { found: true, text: inputText(rows.slice(i, end).map((r) => r.slice(offset))), rows: end - i };
    }
    return none;
  }
  return none;
}

/** Agents whose input box Joyride can read and clear. */
export const composerAgents = new Set(["claude", "codex", "cursor"]);

/** Keys that empty an input of `rows` rows from any cursor position. */
export function clearKeys(rows: number): string[] {
  const n = Math.max(1, rows);
  return [...Array(2 * n + 1).fill("ctrl+k"), ...Array.from({ length: n + 1 }, () => ["ctrl+u", "backspace"]).flat()];
}

export class ComposerError extends Error {
  constructor(message: string, public code: "composer_not_found" | "composer_not_cleared" | "composer_busy" | "composer_draft" | "image_not_attached" | "images_unsupported", public leftover = "") { super(message); }
}

/**
 * For a steer that must never type over someone's typing (Firstmate's, through `joyride steer`): the
 * input box has to be visible and empty. Text there is the captain's draft (or a recalled prompt), and
 * it is left exactly as it is: a ComposerError with code composer_draft refuses the steer.
 */
export async function keepComposer(o: { agent: string; read: () => Promise<string>; where: string }): Promise<void> {
  const c = readComposer(await o.read(), o.agent);
  if (!c.found) throw new ComposerError(`Joyride can't see the input box of the agent in ${o.where}, so it can't tell whether the captain is typing there. Nothing was sent.`, "composer_not_found");
  if (c.text) throw new ComposerError(`The input box of the agent in ${o.where} holds text ("${clip(c.text)}"), most likely the captain's draft. Joyride sent nothing and left the draft as it is. Try again once the captain has sent or cleared it.`, "composer_draft", c.text);
}

/**
 * Make sure the input box is empty: clear it when it holds text, then check the screen again.
 * Returns the text that was cleared (null when it was already empty). Throws ComposerError when
 * the input box can't be seen or still holds text after a few rounds, so nothing gets merged.
 */
export async function emptyComposer(o: {
  agent: string; read: () => Promise<string>; send: (keys: string[]) => Promise<unknown>;
  rounds?: number; settleMs?: number; stepMs?: number; where: string;
  /** The agent is working: text in the box may be queued messages pulled back to edit, so it is never cleared. */
  busy?: boolean;
}): Promise<string | null> {
  const settle = o.settleMs ?? 1500, step = o.stepMs ?? 80;
  const unseen = () => new ComposerError(`Joyride can't see the input box of the agent in ${o.where}, so it did not send your reply: the text could land in a dialog or merge with something else. Open the agent's terminal, get it back to its input box, then send again.`, "composer_not_found");
  let c = readComposer(await o.read(), o.agent);
  if (!c.found) throw unseen();
  if (!c.text) return null;
  const before = c.text;
  if (o.busy) {
    throw new ComposerError(`The agent in ${o.where} is working, and its input box holds text ("${clip(before)}"): a draft, or messages queued for the end of its turn that the Up arrow pulled back to edit. Joyride did not send your reply and left that text alone, so nothing queued is lost. In the agent's terminal, press Enter to queue that text again (or clear it), then send your reply again.`, "composer_busy", before);
  }
  for (let round = 0; round < (o.rounds ?? 3); round++) {
    await o.send(clearKeys(c.rows));
    const until = Date.now() + settle;
    do {
      await new Promise((r) => setTimeout(r, step));
      c = readComposer(await o.read(), o.agent);
      if (c.found && !c.text) return before;
    } while (Date.now() < until);
    if (!c.found) throw unseen();
  }
  const left = c.text || before;
  throw new ComposerError(`The input box of the agent in ${o.where} already holds text that Joyride could not clear ("${clip(left)}"). Your reply was not sent, so the two don't merge. Clear the input box in the agent's terminal, then send again.`, "composer_not_cleared", left);
}

// Images go in before the text. Pasted on its own, an image's path becomes an "[Image #N]"
// attachment in both Claude Code and Codex, which read the file and send it to the model as an
// image. Pasted together with other text (or inside agent.prompt's text) Codex keeps it as plain
// text, so each path gets its own bracketed paste. Checked in a Herdr lab (Claude Code 2.1.289,
// Codex 0.160): png, jpg, gif and webp, and a quoted path with a space.

const PLACEHOLDER = /\[Image #\d+\]/g;

/** "[Image #N]" attachments in an input box's text. */
export function imageCount(text: string): number {
  return (text.match(PLACEHOLDER) ?? []).length;
}

/** One path as a bracketed paste, single-quoted when it has characters the agents would split on. */
export function imagePaste(p: string): string {
  const quoted = /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
  return `\x1b[200~${quoted}\x1b[201~`;
}

/**
 * Paste each image path into an empty input box and wait until the agent shows it as an
 * attachment. When one doesn't turn into "[Image #N]" (the file can't be read, or the agent
 * doesn't load images from paths), the box is cleared again and a ComposerError says which image,
 * so nothing half-attached is ever sent.
 */
export async function attachImages(o: {
  agent: string; where: string; paths: string[];
  read: () => Promise<string>; paste: (text: string) => Promise<unknown>; send: (keys: string[]) => Promise<unknown>;
  settleMs?: number; stepMs?: number;
}): Promise<void> {
  const settle = o.settleMs ?? 6000, step = o.stepMs ?? 100;
  for (let i = 0; i < o.paths.length; i++) {
    await o.paste(imagePaste(o.paths[i]));
    let c: Composer = { found: false, text: "", rows: 0 };
    const until = Date.now() + settle;
    let ok = false;
    do {
      await new Promise((r) => setTimeout(r, step));
      c = readComposer(await o.read(), o.agent);
      ok = c.found && imageCount(c.text) === i + 1 && !c.text.replace(PLACEHOLDER, "").trim();
    } while (!ok && Date.now() < until);
    if (ok) continue;
    const name = o.paths[i].split("/").pop();
    const shows = c.found ? `its input box shows "${clip(c.text)}" instead of an [Image #${i + 1}] attachment` : "Joyride lost sight of its input box";
    const cleared = c.found && (await o.send(clearKeys(c.rows)).then(() => true, () => false));
    throw new ComposerError(`The agent in ${o.where} did not take ${name} as an image (${shows}), so Joyride sent nothing${cleared ? " and cleared the box again" : "; clear its input box in the terminal"}. Check that the agent can read ${o.paths[i]}, then send again, or send the text without the image.`, "image_not_attached", c.text);
  }
}

const clip = (t: string) => (t.length > 120 ? `${t.slice(0, 120)}…` : t);
