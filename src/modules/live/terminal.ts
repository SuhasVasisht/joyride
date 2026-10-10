// The browser terminal for a Herdr pane: one poller per watched pane reads the
// visible screen WITH its ANSI styling (pane.read source "visible", format
// "ansi") about four times a second and pushes a frame to every subscriber
// only when it changed. Herdr has no screen-change event (pane.output_matched
// needs a pattern, pane.scroll_changed is scroll only), so polling a local
// socket is the honest option; input pokes an immediate re-read so typing feels
// direct. The pane keeps its own size: the frame carries cols/rows (from
// pane.layout) and the browser sizes xterm.js to match.
import type { HerdrApi } from "./herdr.ts";
import { describeOps, type InputOp } from "./terminal-input.ts";

export type TermFrame = { text: string; cols: number; rows: number; at: string };
export type TermEvent = { type: "frame"; frame: TermFrame } | { type: "error"; message: string };
type Sub = (e: TermEvent) => void;
type Stream = {
  machine: string; pane: string; subs: Set<Sub>; timer: NodeJS.Timeout | null; reading: boolean; again: boolean;
  last: TermFrame | null; size: { cols: number; rows: number } | null; sizeAt: number; error: string | null; errors: number;
};

const visibleWidth = (s: string) => [...s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")].length;

/** Pull the ANSI text out of a pane.read result. */
export function frameText(r: any): string {
  const t = r?.read?.text ?? r?.text ?? "";
  return String(t);
}

export class TerminalHub {
  private streams = new Map<string, Stream>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private herdr: () => HerdrApi, private opts: { intervalMs?: number; errorIntervalMs?: number } = {}) {}

  private key(machine: string, pane: string) { return `${machine}|${pane}`; }
  private get interval() { return this.opts.intervalMs ?? Number(process.env.JOYRIDE_TERMINAL_POLL_MS ?? 250); }

  /** Read the pane's size (cols x rows); refreshed every few seconds while watched. */
  private async size(s: Stream, lines: string[]): Promise<{ cols: number; rows: number }> {
    if (s.size && Date.now() - s.sizeAt < 5000) return s.size;
    let size: { cols: number; rows: number } | null = null;
    try {
      const r = await this.herdr().call("pane.layout", { pane_id: s.pane }, { machine: s.machine, timeoutMs: 3000 });
      const rect = (r?.layout?.panes ?? []).find((p: any) => p.pane_id === s.pane)?.rect;
      if (rect?.width > 0 && rect?.height > 0) size = { cols: Number(rect.width), rows: Number(rect.height) };
    } catch { /* older Herdr or a pane that just closed: estimate from the text */ }
    size ??= { cols: Math.max(80, ...lines.map(visibleWidth)), rows: Math.max(24, lines.length) };
    s.size = size; s.sizeAt = Date.now();
    return size;
  }

  /** One fresh frame (also used by the JSON endpoint). */
  async read(machine: string, pane: string, s?: Stream): Promise<TermFrame> {
    const r = await this.herdr().call("pane.read", { pane_id: pane, source: "visible", format: "ansi", strip_ansi: false }, { machine, timeoutMs: 3000 });
    const text = frameText(r).replace(/\r?\n$/, "");
    const lines = text.split(/\r?\n/);
    const st = s ?? this.streams.get(this.key(machine, pane)) ?? ({ machine, pane, size: null, sizeAt: 0 } as Stream);
    const { cols, rows } = await this.size(st, lines);
    return { text, cols, rows, at: new Date().toISOString() };
  }

  private async poll(s: Stream) {
    if (s.reading) { s.again = true; return; }
    s.reading = true;
    try {
      const f = await this.read(s.machine, s.pane, s);
      if (s.error) s.error = null;
      s.errors = 0;
      const changed = !s.last || s.last.text !== f.text || s.last.cols !== f.cols || s.last.rows !== f.rows;
      if (changed) { s.last = f; for (const fn of s.subs) fn({ type: "frame", frame: f }); }
    } catch (e: any) {
      s.errors++;
      const msg = e?.code === "pane_not_found" ? `Pane ${s.pane} is gone. The agent may have exited; close this view.` : `Can't read pane ${s.pane}: ${e?.message ?? e}`;
      if (msg !== s.error) { s.error = msg; for (const fn of s.subs) fn({ type: "error", message: msg }); }
    } finally {
      s.reading = false;
    }
    this.schedule(s, s.again ? 0 : s.errors ? (this.opts.errorIntervalMs ?? 2000) : this.interval);
    s.again = false;
  }

  private schedule(s: Stream, ms: number) {
    if (!s.subs.size) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; this.poll(s); }, ms);
    s.timer.unref?.();
  }

  subscribe(machine: string, pane: string, fn: Sub): () => void {
    const k = this.key(machine, pane);
    let s = this.streams.get(k);
    if (!s) {
      s = { machine, pane, subs: new Set(), timer: null, reading: false, again: false, last: null, size: null, sizeAt: 0, error: null, errors: 0 };
      this.streams.set(k, s);
    }
    s.subs.add(fn);
    if (s.last) fn({ type: "frame", frame: s.last });
    if (s.subs.size === 1) this.schedule(s, 0);
    const st = s;
    return () => {
      st.subs.delete(fn);
      if (st.subs.size) return;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      this.streams.delete(k);
    };
  }

  /** Re-read soon (after input), without waiting for the next tick. */
  poke(machine: string, pane: string, ms = 40) {
    const s = this.streams.get(this.key(machine, pane));
    if (s) this.schedule(s, ms);
  }

  watching(machine: string, pane: string) { return this.streams.get(this.key(machine, pane))?.subs.size ?? 0; }

  /** Type into the pane. Calls for one pane are serialized so keystrokes keep their order. */
  send(machine: string, pane: string, ops: InputOp[]): Promise<string[]> {
    const k = this.key(machine, pane);
    const prev = this.queues.get(k) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const h = this.herdr();
      const call = (method: string, params: Record<string, unknown>) => h.call(method, { pane_id: pane, ...params }, { machine, timeoutMs: 5000 });
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const next = ops[i + 1];
        if ("text" in op && next && "keys" in next) {
          // "hello" + Enter in one ordered call.
          try { await call("pane.send_input", { text: op.text, keys: next.keys }); i++; continue; }
          catch (e: any) { if (e?.code !== "unknown_method" && e?.code !== "invalid_key") throw e; }
        }
        if ("text" in op) { await call("pane.send_text", { text: op.text }); continue; }
        try { await call("pane.send_keys", { keys: op.keys }); }
        catch (e: any) {
          if (e?.code !== "invalid_key") throw e;
          // A key name this Herdr doesn't know: send the terminal's own bytes instead.
          await call("pane.send_text", { text: op.raw.join("") });
        }
      }
      this.poke(machine, pane);
      return describeOps(ops);
    });
    this.queues.set(k, run);
    run.finally(() => { if (this.queues.get(k) === run) this.queues.delete(k); }).catch(() => {});
    return run;
  }

  stop() {
    for (const s of this.streams.values()) { if (s.timer) clearTimeout(s.timer); s.subs.clear(); }
    this.streams.clear();
  }
}
