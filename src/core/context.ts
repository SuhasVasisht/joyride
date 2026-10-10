import type { Hono } from "hono";
import type { DB } from "./db.ts";
import type { Bus } from "./bus.ts";
import type { Config, EventRecord } from "../shared/schema.ts";
import { appendEvent } from "./eventlog.ts";

export type Log = (msg: string, extra?: unknown) => void;

export interface Ctx {
  db: DB;
  bus: Bus;
  config: Config;
  app: Hono;
  log: Log;
  /** Append to the shared event log; the tailer dispatches it back through bus.onEvent. */
  emit: typeof appendEvent;
  /** Cross-module service registry (modules expose typed APIs here). */
  services: Map<string, any>;
  service<T = any>(name: string): T;
}

export interface JoyrideModule {
  name: string;
  /** Lower runs first. Readers/projection before consumers. */
  order?: number;
  migrations?: Record<string, string>;
  register(ctx: Ctx): void | Promise<void>;
  /** Background loops; called after every module registered. */
  start?(ctx: Ctx): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export const defineModule = (m: JoyrideModule) => m;
export type { EventRecord };
