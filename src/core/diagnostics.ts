import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

type Refresh = { started: number | null; finished: number | null; error: string | null };
type Request = { method: string; path: string; started: number };

/** Health reads only this in-memory state. The watchdog runs outside the daemon's event loop. */
export class Diagnostics {
  private lag = monitorEventLoopDelay({ resolution: 10 });
  private refreshers = new Map<string, Refresh>();
  private requests = new Map<number, Request>();
  private slow: (Request & { ms: number })[] = [];
  private seq = 0;
  private worker: Worker | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private counter = new Int32Array(new SharedArrayBuffer(4));
  constructor(private log: (msg: string, extra?: unknown) => void) {}

  start(port?: number) {
    if (this.heartbeat) return;
    this.lag.enable();
    const limit = Number(process.env.JOYRIDE_WATCHDOG_MS ?? 10000);
    this.worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const counter = new Int32Array(workerData.buffer);
      let previous = Atomics.load(counter, 0), last = Date.now(), reported = false, diagnostics = {};
      parentPort.on('message', (m) => { diagnostics = m; });
      const report = (reason, elapsed) => {
        // Worker stdout/stderr are relayed by the parent event loop. Write the fd directly.
        require('node:fs').writeSync(2, '[joyride watchdog] ' + JSON.stringify({ reason, elapsed_ms: elapsed, ...diagnostics }) + '\\n');
        if (workerData.supervised) process.kill(workerData.pid, 'SIGKILL');
      };
      setInterval(() => {
        const value = Atomics.load(counter, 0), now = Date.now();
        if (value !== previous) { previous = value; last = now; reported = false; }
        if (now - last < workerData.limit || reported) return;
        reported = true;
        report('event loop blocked', now - last);
      }, 250).unref();
      if (workerData.port) {
        let probing = false, healthyAt = Date.now(), healthReported = false;
        setInterval(() => {
          if (probing) return;
          probing = true;
          const failed = () => {
            probing = false;
            if (!healthReported && Date.now() - healthyAt > workerData.limit) {
              healthReported = true; report('health stopped answering', Date.now() - healthyAt);
            }
          };
          const req = require('node:http').get({ host: '127.0.0.1', port: workerData.port, path: '/api/health', agent: false }, (res) => {
            res.resume();
            if (res.statusCode === 200) { healthyAt = Date.now(); healthReported = false; probing = false; }
            else failed();
          });
          req.setTimeout(1500, () => req.destroy());
          req.on('error', failed);
        }, 1000).unref();
      }
    `, { eval: true, execArgv: [], workerData: { buffer: this.counter.buffer, limit, port, pid: process.pid, supervised: process.env.JOYRIDE_SUPERVISED === "1" } });
    this.worker.unref();
    let ticks = 0;
    this.heartbeat = setInterval(() => {
      Atomics.add(this.counter, 0, 1);
      this.publish();
      if (++ticks % 120 === 0) this.lag.reset();
    }, 250);
    this.heartbeat.unref();
  }

  beginRequest(method: string, path: string) {
    const id = ++this.seq;
    this.requests.set(id, { method, path, started: Date.now() });
    this.publish();
    return () => {
      const r = this.requests.get(id);
      this.requests.delete(id);
      if (r && !path.endsWith("/stream") && Date.now() - r.started > 300) {
        const item = { ...r, ms: Date.now() - r.started };
        this.slow = [...this.slow.slice(-19), item];
        this.log("slow request", item);
      }
    };
  }

  async refresh<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.refreshers.get(name);
    this.refreshers.set(name, { started: Date.now(), finished: previous?.finished ?? null, error: null });
    this.publish();
    try {
      const result = await fn();
      this.refreshers.set(name, { started: null, finished: Date.now(), error: null });
      return result;
    } catch (error) {
      this.refreshers.set(name, { started: null, finished: previous?.finished ?? null, error: String(error) });
      throw error;
    }
  }

  snapshot() {
    const now = Date.now();
    return {
      event_loop: { p99_ms: Number.isFinite(this.lag.mean) ? Math.round(this.lag.percentile(99) / 1e4) / 100 : 0, max_ms: Math.round(this.lag.max / 1e4) / 100 },
      refreshers: Object.fromEntries([...this.refreshers].map(([name, r]) => [name, { active_ms: r.started === null ? null : now - r.started, age_ms: r.finished === null ? null : now - r.finished, error: r.error }])),
      requests: [...this.requests.values()].map((r) => ({ ...r, ms: now - r.started })),
      slow_requests: this.slow,
    };
  }
  private publish() { this.worker?.postMessage(this.snapshot()); }
  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.lag.disable();
    await this.worker?.terminate();
    this.worker = null;
  }
}
