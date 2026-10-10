// A Herdr pane in the browser: xterm.js mirrors the pane's visible screen
// (ANSI frames streamed from /api/workers/:id/terminal) and sends what you type
// to /api/workers/:id/input, which hands it to Herdr. No terminal app needed.
// The pane keeps its own size; the font scales so its columns fit, down to a
// readable minimum, past which the screen scrolls sideways.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { post } from "../lib/api";
import "./terminal.css";

type Frame = { text: string; cols: number; rows: number; at: string };
type Send = { data: string } | { keys: string[] };
const enc = encodeURIComponent;

/** Redraw a whole frame in place: every row repainted at an absolute position, so nothing scrolls or flickers. */
export function frameToAnsi(text: string, rows: number): string {
  const shown = text.split(/\r?\n/).slice(-rows);
  let out = "\x1b[?25l";
  for (let i = 0; i < shown.length; i++) out += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${shown[i]}`;
  out += "\x1b[0m";
  if (shown.length < rows) out += `\x1b[${shown.length + 1};1H\x1b[0J`;
  return out;
}

function themeFrom(el: HTMLElement): ITheme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term-bg", "#121c33"), foreground: v("--term-fg", "#e6e9f0"), cursor: v("--term-fg", "#e6e9f0"), cursorAccent: v("--term-bg", "#121c33"),
    selectionBackground: v("--term-selection", "rgba(127,176,218,.35)"),
    black: "#1d2a47", red: "#e8806c", green: "#93c48e", yellow: "#e6c57f", blue: "#86b4dc", magenta: "#c9a0dc", cyan: "#7fc7c4", white: "#d8dce5",
    brightBlack: "#6f7a92", brightRed: "#f29b8a", brightGreen: "#addaa8", brightYellow: "#f0d69c", brightBlue: "#a7cbea", brightMagenta: "#dcbbe9", brightCyan: "#a2dcd9", brightWhite: "#f4f6fa",
  };
}

const QUICK_KEYS: { label: string; keys: string[]; title: string }[] = [
  { label: "Esc", keys: ["esc"], title: "Interrupt or dismiss" },
  { label: "Ctrl+C", keys: ["ctrl+c"], title: "Cancel" },
  { label: "Shift+Tab", keys: ["shift+tab"], title: "Cycle the permission mode" },
  { label: "Up", keys: ["up"], title: "Previous option or prompt" },
  { label: "Down", keys: ["down"], title: "Next option" },
  { label: "Enter", keys: ["enter"], title: "Confirm" },
];

export default function TerminalView({ worker, pane, name, controllable, terminalUrl, readOnlyHint }: { worker: string; pane: string; name?: string; controllable: boolean; terminalUrl?: string; readOnlyHint?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const size = useRef<{ cols: number; rows: number } | null>(null);
  const lastFrame = useRef<Frame | null>(null);
  const queue = useRef<Send[]>([]);
  const busy = useRef(false);
  const [state, setState] = useState<"connecting" | "live" | "error" | "paused">("connecting");
  const [problem, setProblem] = useState<string | null>(null);
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [fontPx, setFontPx] = useState<number | null>(null);

  // Keystrokes leave in order; while one request is out, the next ones collect into a single request.
  const pump = useCallback(async () => {
    if (!controllable || busy.current || !queue.current.length) return;
    busy.current = true;
    const first = queue.current.shift()!;
    let body: Send = first;
    // Merge plain typing only: an Esc followed by a letter must not turn into Alt+letter on the way.
    const plain = (x: Send | undefined): x is { data: string } => Boolean(x && "data" in x && !x.data.includes("\x1b"));
    if (plain(first)) { let d = first.data; while (plain(queue.current[0])) d += (queue.current.shift() as { data: string }).data; body = { data: d }; }
    try { await post(`/api/workers/${enc(worker)}/input`, body); setInputErr(null); }
    catch (e: any) { setInputErr(`That didn't reach the agent: ${e.message}`); }
    finally { busy.current = false; if (queue.current.length) pump(); }
  }, [worker, controllable]);
  const send = useCallback((s: Send) => { queue.current.push(s); pump(); }, [pump]);

  /** Fit the pane's columns to the available width by scaling the font (9 to 14 px). */
  const layout = useCallback(() => {
    const t = term.current, f = fit.current, sz = size.current;
    if (!t || !f || !sz) return;
    const dims = f.proposeDimensions();
    const cur = t.options.fontSize ?? 13;
    if (dims?.cols) {
      const want = Math.max(9, Math.min(14, Math.floor((cur * dims.cols) / sz.cols * 2) / 2));
      if (Math.abs(want - cur) >= 0.5) t.options.fontSize = want;
      setFontPx(t.options.fontSize ?? cur);
    }
    if (t.cols !== sz.cols || t.rows !== sz.rows) t.resize(sz.cols, sz.rows);
  }, []);

  // Open xterm once the mono font is loaded: it measures its cells when it opens.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let done = false;
    const ok = () => { if (!done) { done = true; setFontReady(true); } };
    (document.fonts?.load('13px "IBM Plex Mono"') ?? Promise.resolve()).then(ok, ok);
    const t = setTimeout(ok, 1200);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!fontReady) return;
    const el = host.current!;
    const t = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 1.12, letterSpacing: 0,
      cursorBlink: false, cursorStyle: "bar", cursorInactiveStyle: "none", scrollback: 0, minimumContrastRatio: 4.5,
      macOptionIsMeta: true, disableStdin: !controllable, theme: themeFrom(el), cols: 100, rows: 30, allowTransparency: false,
      altClickMovesCursor: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t; fit.current = f;
    // Bracketed paste on, so a multi-line paste reaches the agent as one paste instead of several Enters; our cursor stays hidden
    // (agents draw their own in the input box).
    t.write("\x1b[?2004h\x1b[?25l");
    const d1 = t.onData((data) => send({ data }));
    // The wheel scrolls the page. With no scrollback xterm would turn it into Up/Down keys (alt-click
    // too, so that is off), and Up in an agent's empty input box recalls an old prompt, which the
    // next reply then lands inside.
    t.attachCustomWheelEventHandler(() => false);
    t.attachCustomKeyEventHandler((e) => {
      // Shift+Enter is a newline in Claude Code; a browser terminal would send a plain Enter.
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { send({ keys: ["shift+enter"] }); return false; }
      return true;
    });
    const ta = el.querySelector("textarea");
    const onFocus = () => setFocused(true), onBlur = () => setFocused(false);
    ta?.addEventListener("focus", onFocus); ta?.addEventListener("blur", onBlur);
    ta?.setAttribute("aria-label", `Type into ${name || "the agent"}'s terminal`);
    const ro = new ResizeObserver(() => layout());
    ro.observe(el);
    document.fonts?.ready.then(() => layout()).catch(() => {});
    if (lastFrame.current) { const fr = lastFrame.current; size.current = { cols: fr.cols, rows: fr.rows }; layout(); t.write(frameToAnsi(fr.text, fr.rows)); }
    return () => { ro.disconnect(); d1.dispose(); ta?.removeEventListener("focus", onFocus); ta?.removeEventListener("blur", onBlur); t.dispose(); term.current = null; fit.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worker, fontReady]);

  useEffect(() => { if (term.current) term.current.options.disableStdin = !controllable; }, [controllable]);

  // The screen stream: SSE while this tab is visible (it frees the connection when the page is hidden).
  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    const draw = (fr: Frame) => {
      lastFrame.current = fr;
      const t = term.current;
      if (!t) return; // drawn when the terminal opens
      if (!size.current || size.current.cols !== fr.cols || size.current.rows !== fr.rows) { size.current = { cols: fr.cols, rows: fr.rows }; layout(); }
      t.write(frameToAnsi(fr.text, fr.rows));
    };
    const open = () => {
      if (closed) return;
      setState((s) => (s === "live" ? s : "connecting"));
      es = new EventSource(terminalUrl ?? `/api/workers/${enc(worker)}/terminal`);
      es.addEventListener("frame", (ev) => { try { draw(JSON.parse((ev as MessageEvent).data)); setState("live"); setProblem(null); } catch {} });
      es.addEventListener("pane-error", (ev) => { try { setProblem(JSON.parse((ev as MessageEvent).data).message); setState("error"); } catch {} });
      es.onerror = async () => {
        if (es?.readyState !== EventSource.CLOSED) { setState("connecting"); return; } // the browser reconnects on its own
        // Closed for good (the worker is gone or not in Herdr): say why, then retry slowly.
        try { const r = await fetch(`${terminalUrl ?? `/api/workers/${enc(worker)}/terminal`}/frame`); const j = await r.json(); if (!r.ok) { setProblem(j.error ?? `HTTP ${r.status}`); setState("error"); } } catch {}
        if (!closed) setTimeout(() => { if (!closed && !document.hidden) open(); }, 4000);
      };
    };
    const onVis = () => {
      if (document.hidden) { es?.close(); es = null; setState("paused"); }
      else if (!es) open();
    };
    open();
    document.addEventListener("visibilitychange", onVis);
    return () => { closed = true; es?.close(); document.removeEventListener("visibilitychange", onVis); };
  }, [worker, layout, terminalUrl]);

  const status = state === "live" ? (focused ? "Typing goes straight to the agent. Esc and Ctrl+C go to it too; click outside the terminal to leave it." : "Live. Click the terminal to type into it.")
    : state === "paused" ? "Paused while this page is in the background."
      : state === "error" ? problem
        : "Connecting to the pane…";
  return (
    <div className="term" data-terminal={worker} data-terminal-state={state}>
      <div className="term-bar">
        <span className={`term-dot s-${state}`} aria-hidden />
        <span className="term-where">Herdr pane <span className="mono">{pane}</span></span>
        {fontPx && size.current ? <span className="term-size">{size.current.cols} × {size.current.rows}</span> : null}
      </div>
      <div className={`term-screen${focused ? " focused" : ""}`} ref={host} onMouseDown={() => term.current?.focus()} />
      <div className="term-foot">
        <p className={`term-status${state === "error" ? " err" : ""}`} role="status">{state === "error" ? problem : controllable ? status : readOnlyHint ?? "Herdr is not connected right now, so this view is read only. Joyride reconnects on its own."}</p>
        {controllable ? (
          <div className="term-keys" role="group" aria-label="Send a key">
            {QUICK_KEYS.map((k) => <button key={k.label} type="button" className="btn small" title={k.title} onClick={() => { send({ keys: k.keys }); term.current?.focus(); }}>{k.label}</button>)}
          </div>
        ) : null}
      </div>
      {inputErr ? <p className="inline-error" role="alert">{inputErr}</p> : null}
    </div>
  );
}
