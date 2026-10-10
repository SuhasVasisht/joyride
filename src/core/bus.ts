import { EventEmitter } from "node:events";
import type { EventRecord } from "../shared/schema.ts";

/** Change notifications pushed to the UI over SSE; the UI refetches on receipt. */
export type Change = { entity: string; id?: string; op?: "upsert" | "delete" | "refresh"; data?: unknown };

export class Bus {
  private ee = new EventEmitter();
  constructor() { this.ee.setMaxListeners(200); }
  onEvent(fn: (e: EventRecord) => void) { this.ee.on("event", fn); return () => this.ee.off("event", fn); }
  emitEvent(e: EventRecord) { this.ee.emit("event", e); }
  onChange(fn: (c: Change) => void) { this.ee.on("change", fn); return () => this.ee.off("change", fn); }
  change(c: Change) { this.ee.emit("change", c); }
}
