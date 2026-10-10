// The helm: who is steering a live worker right now. Firstmate holds it by default. A steer by the
// captain takes it: a `steer.attributed` event with by=captain (any prompt the captain put in, directly
// or through Joyride), or a captain `reply` intent that reached the pane (Codex crewmates send no
// hooks, so their prompts are never attributed). The captain keeps the helm until that turn ends plus
// 15 quiet minutes; a later captain steer starts the count again. A steer by Firstmate never takes the
// helm back. The captain can hand it back sooner (a hand_back intent logs `helm.released`). The steer
// guard (steer-guard.ts) refuses Firstmate's steers and prompt answers while the captain holds the helm.
import type { EventRecord, WorkerHelm, WorkerStatus } from "../../shared/schema.ts";

export const HELM_QUIET_MS = 15 * 60_000;
/** A captain steer whose turn never visibly ended stops counting after this long. */
export const HELM_MAX_HOLD_MS = 12 * 3600e3;

/** The captain's last steer of one worker, and the first turn end seen after it. */
export type HelmMark = { at: string; via: string; turnEnded: string | null };

export const FIRSTMATE_HELM: WorkerHelm = { by: "firstmate", since: null, until: null, via: null };
const TURN_END = new Set(["turn.stop", "turn.stop_failure", "session.end"]);
const AT_REST = new Set<WorkerStatus>(["idle", "done", "exited"]);
const ms = (iso: string) => Date.parse(iso);

/**
 * The helm for a worker from its captain mark. Without a recorded turn end, a worker at rest since
 * after the steer counts as ended then (Herdr's status for agents without hooks).
 */
export function helmFor(mark: HelmMark | undefined, w: { status: WorkerStatus; updated: string }, now = Date.now()): WorkerHelm {
  if (!mark) return FIRSTMATE_HELM;
  const at = ms(mark.at);
  let end = mark.turnEnded ? ms(mark.turnEnded) : null;
  if (end == null && AT_REST.has(w.status) && ms(w.updated) > at) end = ms(w.updated);
  if (end == null) return now - at > HELM_MAX_HOLD_MS ? FIRSTMATE_HELM : { by: "captain", since: mark.at, until: null, via: mark.via };
  const until = end + HELM_QUIET_MS;
  return now >= until ? FIRSTMATE_HELM : { by: "captain", since: mark.at, until: new Date(until).toISOString(), via: mark.via };
}

export class HelmTracker {
  private byWorker = new Map<string, HelmMark>();
  private bySession = new Map<string, HelmMark>();
  /** The last hand-back per worker and session: a steer from before it (arriving late) never takes the helm again. */
  private released = new Map<string, string>();

  /** Feed every bus event. Returns true when a worker's helm may have changed. */
  observe(e: EventRecord): boolean {
    const d = e.data ?? {};
    if (e.source === "live" && e.type === "steer.attributed") {
      if (d.by !== "captain") return false;
      return this.mark(d.worker ? String(d.worker) : null, d.session ? String(d.session) : null, String(d.at ?? e.ts), String(d.via ?? "direct"));
    }
    if (e.source === "intent" && e.type === "intent.sent" && d.kind === "reply" && (d.origin ?? "captain") === "captain" && d.target) {
      return this.mark(String(d.target), null, e.ts, "joyride-reply");
    }
    if (e.source === "live" && e.type === "helm.released") return this.release(d.worker ? String(d.worker) : null, d.session ? String(d.session) : null, String(d.at ?? e.ts));
    if (e.source.startsWith("hook.") && e.session && TURN_END.has(e.type)) {
      const m = this.bySession.get(`${e.agent ?? e.source.slice(5)}:${e.session}`);
      if (m && !m.turnEnded && e.ts >= m.at) { m.turnEnded = e.ts; return true; }
    }
    return false;
  }

  /** The captain mark for a worker: by its id, else by its session. */
  markOf(worker: string, session: string | null): HelmMark | undefined {
    const a = this.byWorker.get(worker), b = session ? this.bySession.get(session) : undefined;
    return !a ? b : !b ? a : a.at >= b.at ? a : b;
  }

  /** The captain handed the helm back: drop every mark from before the hand-back (a later steer takes it again). */
  private release(worker: string | null, session: string | null, at: string): boolean {
    let changed = false;
    const drop = (m: Map<string, HelmMark>, k: string | null) => {
      if (!k) return;
      if (!(this.released.get(k)! >= at)) this.released.set(k, at);
      const cur = m.get(k);
      if (cur && cur.at <= at) { m.delete(k); changed = true; }
    };
    drop(this.byWorker, worker);
    drop(this.bySession, session);
    return changed;
  }

  private mark(worker: string | null, session: string | null, at: string, via: string): boolean {
    const cur = (worker && this.byWorker.get(worker)) || (session && this.bySession.get(session)) || undefined;
    if (cur && cur.at > at) return false;
    if ((worker && this.released.get(worker)! >= at) || (session && this.released.get(session)! >= at)) return false;
    const m: HelmMark = { at, via, turnEnded: null };
    if (worker) this.byWorker.set(worker, m);
    if (session) this.bySession.set(session, m);
    return true;
  }
}
