// "Log in to GitHub" from the setup page: runs `gh auth login --web` in a new Herdr pane
// (a plain shell, not an agent), reads the one-time code and URL off that pane's screen,
// presses Enter once so gh opens the browser and starts polling, and closes the pane when
// gh reports success. Only ever types into the pane it created.
import os from "node:os";
import type { HerdrApi } from "../live/herdr.ts";
import { CLEAN_AGENT_ENV } from "../live/herdr.ts";
import { screenText } from "../live/screen.ts";

export const GH_LOGIN_ARGS = ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"];
export type GhLoginState = { machine: string; pane_id: string; workspace_id: string | null; started: string; enter_sent: boolean; done: boolean; closed: boolean };
export type GhLoginView = {
  active: boolean; worker: string | null; started: string | null;
  code: string | null; url: string | null; question: string | null; account: string | null; done: boolean; error: string | null;
  screen: string;
};

/** What gh shows: the one-time code, the device URL, a yes/no question, success, or an error. */
export function parseGhLogin(screen: string) {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const code = screen.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? null;
  const url = screen.match(/https:\/\/github\.com\/login\/device/)?.[0] ?? null;
  const pressEnter = /Press Enter to open/i.test(screen);
  const account = screen.match(/Logged in as (\S+)/)?.[1] ?? null;
  const done = Boolean(account) || /Authentication complete/i.test(screen);
  const tail = lines.filter((l) => l.trim()).slice(-3);
  const q = tail.map((l) => l.match(/^\s*\?\s+(.+?\?)\s*\((?:Y\/n|y\/N)\)\s*$/)?.[1]).filter(Boolean).pop() ?? null;
  const err = tail.map((l) => l.match(/^\s*(?:error|X)\b[: ]\s*(.+)$/i)?.[1]).filter(Boolean).pop() ?? null;
  return { code, url, pressEnter, question: done ? null : q, account, done, error: done ? null : err };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startGhLogin(herdr: HerdrApi, ghPath: string): Promise<GhLoginState> {
  const machine = herdr.defaultMachine();
  if (!herdr.connected(machine)) throw Object.assign(new Error(`Herdr on ${machine} is not connected. Start Herdr, or run the command below in any terminal.`), { status: 503 });
  const r = await herdr.call("workspace.create", { cwd: os.homedir(), label: "GitHub login", focus: false, env: { ...CLEAN_AGENT_ENV } }, { machine });
  const root = r?.root_pane ?? r?.workspace?.root_pane ?? r;
  const pane_id: string = root?.pane_id;
  if (!pane_id) throw new Error("Herdr did not return a pane for the login.");
  // Give the shell a moment to draw its prompt so the typed command is not swallowed.
  for (let i = 0; i < 10; i++) {
    try { if (screenText(await herdr.call("pane.read", { pane_id, source: "visible", lines: 20, strip_ansi: true }, { machine })).trim()) break; } catch {}
    await wait(300);
  }
  const cmd = [ghPath, ...GH_LOGIN_ARGS].map((a) => (/^[\w./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
  await herdr.call("pane.send_text", { pane_id, text: cmd }, { machine });
  await herdr.call("pane.send_keys", { pane_id, keys: ["enter"] }, { machine });
  return { machine, pane_id, workspace_id: root?.workspace_id ?? null, started: new Date().toISOString(), enter_sent: false, done: false, closed: false };
}

/** Read the login pane; press Enter once gh shows the code (it then opens the browser itself). */
export async function pollGhLogin(herdr: HerdrApi, s: GhLoginState): Promise<{ view: GhLoginView; state: GhLoginState }> {
  let screen = "";
  let gone = false;
  try { screen = screenText(await herdr.call("pane.read", { pane_id: s.pane_id, source: "visible", lines: 40, strip_ansi: true }, { machine: s.machine })); }
  catch (e: any) { gone = /not.?found/i.test(String(e?.code ?? e?.message ?? "")); }
  const p = parseGhLogin(screen);
  const next = { ...s };
  if (p.code && p.pressEnter && !s.enter_sent) {
    try { await herdr.call("pane.send_keys", { pane_id: s.pane_id, keys: ["enter"] }, { machine: s.machine }); next.enter_sent = true; } catch {}
  }
  if (p.done && !s.done) {
    next.done = true;
    // Leave Herdr tidy: close the workspace this login created.
    if (s.workspace_id) { try { await herdr.call("workspace.close", { workspace_id: s.workspace_id }, { machine: s.machine }); next.closed = true; } catch {} }
  }
  if (gone) next.closed = true;
  const tail = screen.split("\n").filter((l) => l.trim()).slice(-12).join("\n");
  return {
    state: next,
    view: {
      active: !next.done && !next.closed, worker: `${s.machine}:${s.pane_id}`, started: s.started,
      code: p.code, url: p.url, question: p.question, account: p.account, done: next.done,
      error: gone && !next.done ? "The login pane was closed before gh finished. Start the login again." : p.error,
      screen: tail,
    },
  };
}

export async function answerGhLogin(herdr: HerdrApi, s: GhLoginState, answer: "y" | "n") {
  await herdr.call("pane.send_text", { pane_id: s.pane_id, text: answer }, { machine: s.machine });
  await herdr.call("pane.send_keys", { pane_id: s.pane_id, keys: ["enter"] }, { machine: s.machine });
}
