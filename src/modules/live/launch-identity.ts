import { z } from "zod";
import { kvGet, kvSet } from "../../core/db.ts";
import type { Ctx } from "../../core/context.ts";
import type { MachinePane } from "./herdr.ts";
import { readThreads, type CodexThread } from "../sessions/codex.ts";

const Identity = z.object({ session: z.string(), terminal: z.string(), cwd: z.string(), agent: z.string(), pids: z.array(z.number()) });
export function matchLaunchThread(threads: CodexThread[], cwd: string, marker: string, started: number): string | null {
  const matches = threads.filter(t => !t.subagent && t.cwd === cwd && t.created_ms >= started - 1000 && t.first_user_message.split("\n").some(line => line.trim() === marker));
  return matches.length === 1 ? `codex:${matches[0].id}` : null;
}
export function nativeLaunchSession(home: string, cwd: string, marker: string, started: number): string | null {
  const state = readThreads(home);
  return state ? matchLaunchThread(state.rows, cwd, marker, started) : null;
}
export function rememberLaunchSession(ctx: Ctx, pane: MachinePane, session: string) {
  kvSet(ctx.db, `live:launch-session:${pane.machine}:${pane.pane_id}`, { session, terminal: pane.terminal_id, cwd: pane.cwd, agent: pane.agent, pids: pane.fg_pids });
  ctx.bus.change({ entity: "workers" });
}
export function launchSessionForPane(ctx: Ctx, pane: MachinePane): string | null {
  const parsed = Identity.safeParse(kvGet<unknown>(ctx.db, `live:launch-session:${pane.machine}:${pane.pane_id}`, null));
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.terminal !== pane.terminal_id || record.agent !== pane.agent || record.cwd !== pane.cwd || !record.pids.length || !record.pids.some(pid => pane.fg_pids.includes(pid))) return null;
  return record.session;
}
