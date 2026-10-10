// Append-only JSONL event log shared by hooks (separate processes) and the
// daemon. The daemon tails every file and dispatches each line exactly once,
// tracking byte offsets in the index so restarts resume where they left off.
import fs from "node:fs";
import path from "node:path";
import { EventRecord } from "../shared/schema.ts";
import { paths } from "../shared/paths.ts";
import { ensureDir, now, rid } from "./util.ts";
import { performance } from "node:perf_hooks";

export function eventFileFor(ts = new Date()) {
  return path.join(paths.events, `${ts.toISOString().slice(0, 10)}.jsonl`);
}

/** Append one event. Safe from any process (single O_APPEND write per line). */
export function appendEvent(e: Omit<EventRecord, "ts" | "id"> & { ts?: string; id?: string }): EventRecord {
  const rec = { ...e, ts: e.ts ?? now(), id: e.id ?? rid("ev_"), data: e.data ?? {} } as EventRecord;
  if (process.env.JOYRIDE_PREVIEW === "1") return rec; // tier-2 previews never write the shared log
  ensureDir(paths.events);
  fs.appendFileSync(eventFileFor(new Date(rec.ts)), JSON.stringify(rec) + "\n");
  return rec;
}

type Offsets = { get(file: string): number; set(file: string, off: number): void };

export class EventTailer {
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private continuation: NodeJS.Immediate | null = null;
  private running = false;
  constructor(private offsets: Offsets, private onEvent: (e: EventRecord) => void) {}

  start() {
    this.running = true;
    ensureDir(paths.events);
    this.drain(8);
    try { this.watcher = fs.watch(paths.events, () => this.drain(8)); } catch { /* polling fallback only */ }
    this.timer = setInterval(() => this.drain(8), 1000);
  }
  stop() {
    this.running = false;
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    if (this.continuation) clearImmediate(this.continuation);
    this.continuation = null;
  }

  drain(budgetMs = Infinity) {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        const files = fs.readdirSync(paths.events).filter((f) => f.endsWith(".jsonl")).sort();
        const deadline = performance.now() + budgetMs;
        for (const f of files) {
          if (this.readFile(path.join(paths.events, f), deadline)) {
            if (this.running && !this.continuation) this.continuation = setImmediate(() => { this.continuation = null; this.drain(8); });
            return;
          }
        }
      } while (this.again);
    } finally { this.busy = false; }
  }

  private readFile(file: string, deadline: number): boolean {
    const size = fs.statSync(file).size;
    const off = this.offsets.get(file);
    if (size <= off) return false;
    const fd = fs.openSync(file, "r");
    try {
      let buf = Buffer.alloc(Math.min(size - off, Number.isFinite(deadline) ? 256 * 1024 : size - off));
      fs.readSync(fd, buf, 0, buf.length, off);
      // A large single event must still advance, even when it spans the normal batch size.
      while (!buf.includes(10) && off + buf.length < size) {
        buf = Buffer.alloc(Math.min(size - off, buf.length * 2));
        fs.readSync(fd, buf, 0, buf.length, off);
      }
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) return false; // partial line; wait
      const complete = text.slice(0, lastNl);
      let consumed = 0;
      for (const line of complete.split("\n")) {
        consumed += Buffer.byteLength(line, "utf8") + 1;
        try {
          const parsed = EventRecord.safeParse(JSON.parse(line));
          if (parsed.success) this.onEvent(parsed.data);
        } catch { /* skip corrupt line */ }
        if (performance.now() >= deadline) break;
      }
      this.offsets.set(file, off + consumed);
      return off + consumed < size && text.endsWith("\n") || consumed < Buffer.byteLength(complete, "utf8") + 1 || off + buf.length < size;
    } finally { fs.closeSync(fd); }
  }
}
