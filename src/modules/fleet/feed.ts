// The fleet feed: fleet events Firstmate needs, kept in order with a sequence number, and delivered to
// the joyride-fleet-feed Firstmate extension (install/firstmate-extension/joyride-fleet-feed) by long poll.
// Events: a watched member's move into blocked, needs-decision, failed or done (inferred); the captain
// taking the helm of a member (crew or watched) and it coming back; a member excluded or included.
//
// Delivery follows the process-event-adapter/1 contract: each `source.poll` carries a request id that a
// retry before capture repeats, and the first poll after a capture changes. So a consumer's last batch
// is replayed while its request id is the same, and counts as delivered once a new request id arrives.
// An empty batch is never replayed: a poll that found nothing waits again.
import type { DB } from "../../core/db.ts";
import { kvGet, kvSet } from "../../core/db.ts";
import { now } from "../../core/util.ts";

export type FeedType = "member.state" | "helm.captain" | "helm.firstmate" | "member.excluded" | "member.included";
export type FeedEvent = {
  seq: number; ts: string; type: FeedType; worker: string; session: string | null;
  tier: string; task: string | null; title: string; cwd: string; data: Record<string, any>;
};
export type FeedInput = Omit<FeedEvent, "seq" | "ts">;
export type Consumer = { id: string; cursor: number; request: string | null; batch: number[]; last_poll: string | null };

export const FEED_SQL = `
CREATE TABLE fleet_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, worker TEXT NOT NULL, json TEXT NOT NULL);
`;
export const BATCH_MAX = 20;
export const WAIT_MAX_MS = 55_000;
/**
 * A consumer's first poll, and its first poll after a day of silence (Firstmate away, the feed
 * reinstalled), skips events older than this: it starts from what is current, not from history.
 */
export const FIRST_POLL_BACKLOG_MS = 30 * 60_000;
export const STALE_CONSUMER_MS = 24 * 3600e3;
/** Events are kept this long (joyride fleet events shows them); the event log keeps them for good. */
export const KEEP_MS = 30 * 24 * 3600e3;

const consumerKey = (id: string) => `fleet:consumer:${id}`;
const blank = (id: string): Consumer => ({ id, cursor: 0, request: null, batch: [], last_poll: null });

export class FleetFeed {
  private waiters = new Set<() => void>();
  constructor(private db: DB) {}

  append(e: FeedInput): FeedEvent {
    const ts = now();
    const r = this.db.prepare("INSERT INTO fleet_events(ts, type, worker, json) VALUES (?,?,?,?)").run(ts, e.type, e.worker, JSON.stringify(e));
    const ev = { ...e, seq: Number(r.lastInsertRowid), ts };
    for (const w of [...this.waiters]) w();
    return ev;
  }

  private rows(sql: string, ...args: unknown[]): FeedEvent[] {
    return (this.db.prepare(sql).all(...args) as { seq: number; ts: string; json: string }[]).map((r) => ({ ...JSON.parse(r.json), seq: r.seq, ts: r.ts }));
  }
  after(seq: number, limit = 100): FeedEvent[] { return this.rows("SELECT seq, ts, json FROM fleet_events WHERE seq > ? ORDER BY seq LIMIT ?", seq, Math.min(limit, 1000)); }
  bySeq(seqs: number[]): FeedEvent[] { return seqs.length ? this.rows(`SELECT seq, ts, json FROM fleet_events WHERE seq IN (${seqs.map(() => "?").join(",")}) ORDER BY seq`, ...seqs) : []; }
  latest(limit = 50): FeedEvent[] { return this.rows("SELECT seq, ts, json FROM fleet_events ORDER BY seq DESC LIMIT ?", Math.min(limit, 1000)).reverse(); }
  lastSeq(): number { return Number((this.db.prepare("SELECT MAX(seq) AS s FROM fleet_events").get() as { s: number | null }).s ?? 0); }

  consumer(id: string): Consumer {
    const c = kvGet<Consumer | null>(this.db, consumerKey(id), null);
    if (c && !(c.last_poll && Date.now() - Date.parse(c.last_poll) > STALE_CONSUMER_MS)) return c;
    const since = new Date(Date.now() - FIRST_POLL_BACKLOG_MS).toISOString();
    const old = Number((this.db.prepare("SELECT MAX(seq) AS s FROM fleet_events WHERE ts < ?").get(since) as { s: number | null }).s ?? 0);
    return c ? { ...c, cursor: Math.max(c.cursor, ...c.batch, old), batch: [] } : { ...blank(id), cursor: old };
  }

  prune(now = Date.now()): number {
    return this.db.prepare("DELETE FROM fleet_events WHERE ts < ?").run(new Date(now - KEEP_MS).toISOString()).changes;
  }
  consumers(): (Consumer & { pending: number })[] {
    const rows = this.db.prepare("SELECT k FROM kv WHERE k LIKE 'fleet:consumer:%'").all() as { k: string }[];
    const last = this.lastSeq();
    return rows.map((r) => { const c = this.consumer(r.k.slice("fleet:consumer:".length)); return { ...c, pending: Math.max(0, last - c.cursor) }; });
  }

  /** One `source.poll`: the batch for this request id, waiting up to waitMs for something new. */
  async poll(id: string, request: string, waitMs: number): Promise<FeedEvent[]> {
    let c = this.consumer(id);
    if (c.request === request && c.batch.length) { this.save({ ...c, last_poll: now() }); return this.bySeq(c.batch); }
    if (c.request !== request && c.batch.length) c = { ...c, cursor: Math.max(c.cursor, ...c.batch), batch: [] };
    c = { ...c, request, last_poll: now() };
    this.save(c);
    let evs = this.after(c.cursor, BATCH_MAX);
    if (!evs.length && waitMs > 0) {
      await this.wait(Math.min(waitMs, WAIT_MAX_MS));
      evs = this.after(c.cursor, BATCH_MAX);
    }
    // Another poll may have run meanwhile (a host retry); this request's batch is whatever it recorded last.
    const cur = this.consumer(id);
    if (cur.request !== request) return evs;
    this.save({ ...cur, batch: evs.map((e) => e.seq), last_poll: now() });
    return evs;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.waiters.add(done);
    });
  }

  /** Wake every long poll now (the daemon is stopping). */
  release() { for (const w of [...this.waiters]) w(); }

  private save(c: Consumer) { kvSet(this.db, consumerKey(c.id), c); }
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const HELM_VIA: Record<string, string> = { direct: "a direct steer in its pane", "joyride-reply": "a reply from Joyride", "joyride-terminal": "typing in Joyride's terminal" };

/** The member as Firstmate reads it: id, title and who owns it. */
function who(e: FeedEvent): string {
  const owner = e.tier === "crew" ? `crew ${e.task ?? ""}`.trim() : e.tier;
  return `${e.worker}${e.title ? ` "${e.title.replace(/\s+/g, " ").slice(0, 80)}"` : ""} (${owner}${e.cwd ? `, ${e.cwd}` : ""})`;
}

export function eventLine(e: FeedEvent): string {
  const d = e.data ?? {};
  const why = String(d.why ?? "").replace(/\s+/g, " ").slice(0, 300);
  let says: string;
  switch (e.type) {
    case "member.state":
      says = d.state === "blocked" ? `blocked: ${why}. If it is yours to answer, use \`joyride steer ${e.worker} --answer allow|allow_always|deny --why "<reason>"\`; otherwise leave it for the captain.`
        : d.state === "needs-decision" ? `needs a decision: ${why}. Relay it to the captain, or answer with \`joyride steer ${e.worker} "<text>"\` when it is yours to decide.`
        : d.state === "failed" ? `failed: ${why}.`
        : `done (inferred): ${why}.`;
      break;
    case "helm.captain": says = `the captain took the helm (${HELM_VIA[d.via] ?? d.via ?? "a direct steer"}${d.since ? ` at ${clock(d.since)}` : ""}). Do not steer it, fm-send included, until the feed says the helm is back.`; break;
    case "helm.firstmate": says = `the helm is back with you (${d.via === "hand_back" ? "the captain handed it back" : "15 quiet minutes after the captain's turn"}).`; break;
    case "member.excluded": says = "the captain keeps this session to themself now. Leave it alone."; break;
    case "member.included": says = "back in the fleet as a watched session."; break;
    default: says = e.type;
  }
  return `- ${clock(e.ts)} ${who(e)}: ${says}`.slice(0, 900);
}

/** The text a poll returns: one machine line Firstmate's classifier reads, then one line per event. */
export function feedText(events: FeedEvent[], refs: { doc: string; bin: string }): string {
  if (!events.length) return "";
  const kinds = [...new Set(events.map((e) => (e.type === "member.state" ? `member.${e.data?.state}` : e.type)))];
  const span = events.length === 1 ? `${events[0].seq}` : `${events[0].seq}-${events[events.length - 1].seq}`;
  return [
    `joyride-fleet-feed/1 seq=${span} kinds=${kinds.join(",")}`,
    `Joyride fleet: ${events.length} event${events.length === 1 ? "" : "s"} for Firstmate.`,
    ...events.map(eventLine),
    `\`joyride\` above is ${refs.bin}. Roster: joyride fleet. How to act on these: ${refs.doc}`,
  ].join("\n");
}
