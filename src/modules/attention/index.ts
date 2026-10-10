// Attention: turns hook, herdr, guard and intent events into leveled items
// (DESIGN §6). Hard floors come from rules; Jev classifies turn stops and may
// only raise a level above the floor. The "why" line is always taken from the
// payload. Rail actions update the item without collecting training labels.
import { execFile } from "node:child_process";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { AttentionItem, Level, type EventRecord } from "../../shared/schema.ts";
import { jev, jevAvailable, jevStats } from "../../core/jev.ts";
import { llmStats } from "../../core/llm.ts";
import { now, rid, sha256, repoName, repoRootOf, truncate } from "../../core/util.ts";
import { editedPaths } from "../evidence/parse.ts";
import * as C from "./classify.ts";
import type { WorkersApi } from "../live/workers.ts";
import type { FirstmateApi } from "../firstmate/index.ts";

const FRESH_MS = 10 * 60e3; // newer events get Jev and notifications; older ones are replays
const OPEN_HORIZON_MS = 24 * 3600e3; // events older than this never open items (index rebuilds)
const OVERLAP_WINDOW_MS = 2 * 3600e3;
const NOTIFY_DEDUPE_MS = 10 * 60e3;
const RESUME_GRACE_MS = 2000; // parallel tool.pre events fire right after a permission request
const TURN_KINDS = new Set<C.Kind>(["question", "decision", "review", "progress", "idle", "approval", "error"]);
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write|str_replace_based_edit_tool)$/;
const NOT_UNBLOCKED = /^(acknowledged|dismissed|session ended|superseded|overridden)/; // excluded from blocked→unblocked latency

export type ListFilter = { open?: boolean; level?: Level; min_level?: Level; mission?: string; session?: string; kind?: string; include_snoozed?: boolean; limit?: number };
export type RaiseInput = {
  level: Level; kind: C.Kind; title: string; why?: string;
  floor?: Level; session?: string | null; worker?: string | null; mission?: string | null;
  jev?: AttentionItem["jev"]; ref?: Record<string, any>; opened?: string; id?: string;
  /** Items sharing a dedupe key update one open item instead of duplicating. Default `${session}|${kind}`. */
  dedupe?: string;
};
export type LabelKind = "ack" | "dismiss" | "snooze" | "override";
export type NotificationRecord = { item: string; level: Level; title: string; at: string; delivered: boolean; deduped: boolean };

export type AttentionService = {
  list(f?: ListFilter): AttentionItem[];
  get(id: string): AttentionItem | null;
  raise(item: RaiseInput): AttentionItem | null;
  resolve(id: string, resolution: string, at?: string): AttentionItem | null;
  label(id: string, label: LabelKind, extra?: { level?: Level; reason?: string; until?: string; minutes?: number }): { item: AttentionItem | null };
  snooze(id: string, until: string): AttentionItem;
  metrics(): any;
  notifications(): NotificationRecord[];
  /** Resolves when in-flight classifications finish (tests, shutdown). */
  settle(): Promise<void>;
};

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export default defineModule({
  name: "attention",
  order: 40,
  // Existing label tables are left untouched. Fresh indexes do not create a labels store.
  migrations: {
    "001": `CREATE TABLE attention_items (
              id TEXT PRIMARY KEY, dedupe TEXT NOT NULL, session TEXT, worker TEXT, mission TEXT, kind TEXT NOT NULL,
              level TEXT NOT NULL, level_rank INTEGER NOT NULL, opened TEXT NOT NULL, resolved TEXT, resolution TEXT,
              snoozed_until TEXT, json TEXT NOT NULL);
            CREATE INDEX attention_open ON attention_items(resolved, level_rank);
            CREATE INDEX attention_dedupe ON attention_items(dedupe, resolved);
            CREATE INDEX attention_session ON attention_items(session, resolved);
            CREATE TABLE attention_touches (session TEXT NOT NULL, path TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (session, path));
            CREATE INDEX attention_touches_path ON attention_touches(path, ts);`,
  },
  register(ctx: Ctx) {
    const { db, app } = ctx;
    const pending = new Set<Promise<unknown>>();
    const track = (p: Promise<unknown>) => { pending.add(p); p.catch((e) => ctx.log(`attention: ${e?.message ?? e}`)).finally(() => pending.delete(p)); };
    const notified = new Map<string, { at: number; level: Level }>();
    const notifications: NotificationRecord[] = [];
    const lastMessage = new Map<string, string>(); // session key → last assistant message

    // ---------- storage ----------
    const parse = (row: any): AttentionItem => JSON.parse(row.json);
    const get = (id: string): AttentionItem | null => { const r = db.prepare("SELECT json FROM attention_items WHERE id = ?").get(id); return r ? parse(r) : null; };
    const dedupeOf = (id: string): string | null => (db.prepare("SELECT dedupe FROM attention_items WHERE id = ?").get(id) as any)?.dedupe ?? null;
    const openByDedupe = (k: string): AttentionItem | null => { const r = db.prepare("SELECT json FROM attention_items WHERE dedupe = ? AND resolved IS NULL ORDER BY opened DESC LIMIT 1").get(k); return r ? parse(r) : null; };
    const openForSession = (s: string | null): AttentionItem[] => (s ? (db.prepare("SELECT json FROM attention_items WHERE session = ? AND resolved IS NULL").all(s) as any[]).map(parse) : []);
    const seenForSession = (session: string): AttentionItem | null => {
      const row = db.prepare("SELECT json FROM attention_items WHERE session = ? AND resolution = 'acknowledged' ORDER BY resolved DESC LIMIT 1").get(session);
      return row ? parse(row) : null;
    };
    const allOpen = (): AttentionItem[] => (db.prepare("SELECT json FROM attention_items WHERE resolved IS NULL").all() as any[]).map(parse);
    function save(it: AttentionItem, dedupe: string) {
      db.prepare(`INSERT INTO attention_items(id, dedupe, session, worker, mission, kind, level, level_rank, opened, resolved, resolution, snoozed_until, json)
                  VALUES (@id, @dedupe, @session, @worker, @mission, @kind, @level, @rank, @opened, @resolved, @resolution, @snoozed_until, @json)
                  ON CONFLICT(id) DO UPDATE SET session=excluded.session, worker=excluded.worker, mission=excluded.mission, kind=excluded.kind, level=excluded.level,
                    level_rank=excluded.level_rank, resolved=excluded.resolved, resolution=excluded.resolution, snoozed_until=excluded.snoozed_until, json=excluded.json`)
        .run({ id: it.id, dedupe, session: it.session, worker: it.worker, mission: it.mission, kind: it.kind, level: it.level, rank: C.rank(it.level),
          opened: it.opened, resolved: it.resolved, resolution: it.resolution, snoozed_until: it.snoozed_until, json: JSON.stringify(it) });
    }

    const missionOf = (session: string | null): string | null => {
      if (!session) return null;
      try { return ctx.service<any>("missions").missionOfSession(session) ?? null; } catch { return null; }
    };
    const workerOf = (session: string | null, e?: EventRecord): string | null => {
      if (session) { try { const w = ctx.service<any>("workers").forSession(session); if (w?.id) return w.id; } catch { /* live module absent */ } }
      const pane = e?.pane ?? (typeof e?.data?.pane === "string" ? e.data.pane : null);
      return pane ? `${e?.data?.machine ?? "local"}:${pane}` : null;
    };
    const liveWorker = (session: string | null, worker: string | null) => {
      const workers = ctx.services.has("workers") ? ctx.service<WorkersApi>("workers") : undefined;
      return (session ? workers?.forSession(session) : null) ?? (worker ? workers?.get(worker) : null) ?? null;
    };
    const isControl = (session: string | null, worker: string | null) => {
      const firstmate = ctx.services.has("firstmate") ? ctx.service<FirstmateApi>("firstmate") : undefined;
      return worker === "local:wH:p1" || liveWorker(session, worker)?.owner?.tier === "control" ||
        Boolean(worker && firstmate?.controlWorker() === worker);
    };
    const changed = (id?: string) => { ctx.bus.change({ entity: "attention", id }); ctx.bus.change({ entity: "metrics" }); };
    const record = (type: string, it: AttentionItem, emit: boolean, extra: Record<string, unknown> = {}) => {
      if (!emit) return;
      try { ctx.emit({ source: "attention", type, session: C.rawSession(it.session) ?? undefined, data: { item: it, ...extra } }); } catch (e: any) { ctx.log(`attention emit failed: ${e.message}`); }
    };

    // ---------- notifications ----------
    function maybeNotify(it: AttentionItem) {
      const min = ctx.config.notifications?.min_level ?? "L3";
      if (C.rank(it.level) < C.rank(min)) return;
      if (it.snoozed_until && it.snoozed_until > now()) return;
      const key = it.session ?? it.worker ?? it.id;
      const last = notified.get(key);
      const deduped = Boolean(last && Date.now() - last.at < NOTIFY_DEDUPE_MS && C.rank(it.level) <= C.rank(last.level));
      const muted = process.env.JOYRIDE_NO_NOTIFY === "1" || process.env.JOYRIDE_TEST === "1" || ctx.config.notifications?.macos === false || process.platform !== "darwin";
      notifications.unshift({ item: it.id, level: it.level, title: it.title, at: now(), delivered: !muted && !deduped, deduped });
      notifications.length = Math.min(notifications.length, 100);
      if (deduped) return;
      notified.set(key, { at: Date.now(), level: it.level });
      if (muted) return;
      const esc = (s: string) => truncate(s, 200).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
      const script = `display notification "${esc(it.why || it.title)}" with title "Joyride · ${it.level}" subtitle "${esc(it.title)}"${it.level === "L4" ? ' sound name "Glass"' : ""}`;
      try { execFile("osascript", ["-e", script], { timeout: 5000 }, () => {}).unref(); } catch { /* notifications are best effort */ }
    }

    // ---------- core operations ----------
    /** Open a new item or update the open one with the same dedupe key. */
    function upsert(inp: RaiseInput, opts: { emit?: boolean; notify?: boolean } = {}): { item: AttentionItem | null; created: boolean } {
      const emit = opts.emit ?? true, notify = opts.notify ?? true;
      const informational = inp.kind === "progress" || inp.kind === "idle";
      const requestedFloor = inp.floor ?? inp.level;
      const floor = informational && C.rank(requestedFloor) >= 3 ? "L1" : requestedFloor;
      const raised = C.maxLevel(floor, inp.level);
      const level = informational && C.rank(raised) >= 3 ? "L1" : raised;
      const dedupe = inp.dedupe ?? `${inp.session ?? inp.worker ?? "-"}|${inp.kind}`;
      const seen = inp.session ? seenForSession(inp.session) : null;
      if (seen && ((inp.ref?.event && inp.ref.event === seen.ref.event) ||
        (inp.ref?.event_ts && inp.ref.event_ts <= seen.ref.acked_at))) return { item: null, created: false };
      const existing = openByDedupe(dedupe);
      if (level === "L0") return { item: existing, created: false }; // L0 is ambient: never stored
      if (existing) {
        const ets = inp.ref?.event_ts, prevTs = existing.ref?.event_ts;
        if (ets && prevTs && ets < prevTs) return { item: existing, created: false }; // an older classification finished late
        const next: AttentionItem = {
          ...existing, level, floor, kind: inp.kind, title: inp.title, why: inp.why ?? existing.why,
          worker: inp.worker ?? existing.worker, mission: inp.mission ?? existing.mission ?? missionOf(existing.session),
          jev: inp.jev !== undefined ? inp.jev : existing.jev,
          ref: { ...existing.ref, ...(inp.ref ?? {}), updates: (existing.ref?.updates ?? 0) + 1 },
        };
        save(next, dedupe);
        if (next.level !== existing.level || next.kind !== existing.kind) record("attention.update", next, emit, { prev_level: existing.level });
        changed(next.id);
        if (notify && C.rank(next.level) > C.rank(existing.level)) maybeNotify(next);
        return { item: next, created: false };
      }
      const opened = inp.opened ?? now();
      const item = AttentionItem.parse({
        id: inp.id ?? `att_${sha256(`${dedupe}|${inp.ref?.event ?? rid()}`).slice(0, 14)}`,
        level, floor, kind: inp.kind, title: inp.title, why: inp.why ?? "",
        session: inp.session ?? null, worker: inp.worker ?? null, mission: inp.mission ?? missionOf(inp.session ?? null),
        opened, resolved: null, resolution: null, snoozed_until: null, jev: inp.jev ?? null, ref: inp.ref ?? {},
      });
      if (get(item.id)) item.id = `att_${rid()}`; // a resolved item already holds this deterministic id
      save(item, dedupe);
      record("attention.open", item, emit);
      changed(item.id);
      if (notify) maybeNotify(item);
      return { item, created: true };
    }

    function resolve(id: string, resolution: string, at?: string, emit = true): AttentionItem | null {
      const it = get(id);
      if (!it || it.resolved) return it;
      const resolved = at && at >= it.opened ? at : now();
      const next = { ...it, resolved, resolution };
      save(next, dedupeOf(id) ?? `${it.session}|${it.kind}`);
      record("attention.resolve", next, emit);
      changed(id);
      return next;
    }
    const resolveWhere = (items: AttentionItem[], pred: (it: AttentionItem) => boolean, resolution: string, at: string, emit: boolean) => {
      for (const it of items) if (pred(it)) resolve(it.id, resolution, at, emit);
    };

    // Upgrade agreement-only acknowledgements before new events can update them.
    for (const it of allOpen()) if (it.ref.acked_at) resolve(it.id, "acknowledged", it.ref.acked_at);

    function list(f: ListFilter = {}): AttentionItem[] {
      for (const it of allOpen()) {
        if (it.kind === "guard") continue;
        if (it.kind === "progress" || it.kind === "idle") {
          if (C.rank(it.level) >= 3) save({ ...it, level: "L1", floor: "L1" }, dedupeOf(it.id)!);
          continue;
        }
        const worker = it.worker ?? workerOf(it.session);
        const w = liveWorker(it.session, worker);
        if (isControl(it.session, worker)) {
          resolve(it.id, "Firstmate decisions use held tasks");
          continue;
        }
        if ((it.kind === "approval" || it.ref.herdr || it.ref.herdr_blocked) && w && w.status !== "blocked" && w.updated > (it.ref.event_ts ?? it.opened)) {
          resolve(it.id, "agent resumed");
          continue;
        }
        if (it.session && ["question", "decision"].includes(it.kind)) {
          const later = activityAfter(it.session, it.ref.event_ts ?? it.opened);
          if (later) resolve(it.id, later.type === "prompt.submit" ? "human replied" : "superseded", later.ts);
        }
      }
      const where: string[] = [], args: any[] = [];
      if (f.open === true) where.push("resolved IS NULL");
      if (f.open === false) where.push("resolved IS NOT NULL");
      if (f.level) { where.push("level = ?"); args.push(f.level); }
      if (f.min_level) { where.push("level_rank >= ?"); args.push(C.rank(f.min_level)); }
      if (f.session) { where.push("session = ?"); args.push(f.session); }
      if (f.kind) { where.push("kind = ?"); args.push(f.kind); }
      if (f.open === true && !f.include_snoozed) { where.push("(snoozed_until IS NULL OR snoozed_until <= ?)"); args.push(now()); }
      if (ctx.config.knowledge.pipeline === "off") where.push("NOT (kind = 'nudge' AND json_extract(json, '$.ref.nudge_kind') IS NOT NULL)");
      const order = f.open === true ? "level_rank DESC, opened DESC" : "opened DESC";
      const limit = Math.min(f.limit ?? 200, 2000);
      let items = (db.prepare(`SELECT json FROM attention_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ?`).all(...args, f.mission ? 5000 : limit) as any[]).map(parse);
      if (f.mission) items = items.filter((it) => (it.mission ?? missionOf(it.session)) === f.mission).slice(0, limit);
      return items;
    }

    // ---------- rail actions ----------
    function label(id: string, kind: LabelKind, extra: { level?: Level; reason?: string; until?: string; minutes?: number } = {}) {
      const it = get(id);
      if (!it) throw new HttpError(404, `No attention item ${id}. Refresh the list and try again.`);
      if (!["ack", "dismiss", "snooze", "override"].includes(kind)) throw new HttpError(400, `Unknown label "${kind}". Use ack, dismiss, snooze or override.`);
      if (kind === "override" && !C.isLevel(extra.level)) throw new HttpError(400, "An override needs a level (L0 to L4).");
      const until = kind === "snooze" ? (extra.until ?? new Date(Date.now() + (extra.minutes ?? 60) * 60e3).toISOString()) : null;
      const at = now();
      let next: AttentionItem | null = it;
      if (kind === "ack") { next = { ...it, ref: { ...it.ref, acked_at: at } }; save(next, dedupeOf(id)!); next = resolve(id, "acknowledged", at); }
      else if (kind === "dismiss") next = resolve(id, "dismissed");
      else if (kind === "snooze") { next = { ...it, snoozed_until: until }; save(next, dedupeOf(id)!); }
      else if (kind === "override") {
        next = { ...it, level: extra.level!, ref: { ...it.ref, overridden_from: it.level } };
        save(next, dedupeOf(id)!);
        if (extra.level === "L0") next = resolve(id, "overridden to L0");
      }
      if (next && (kind === "snooze" || kind === "override")) record("attention.update", next, true);
      changed(id);
      return { item: next };
    }
    // ---------- metrics ----------
    function metrics() {
      const nowMs = Date.now();
      const latency = (windowMs: number) => {
        const since = new Date(nowMs - windowMs).toISOString();
        const rows = db.prepare("SELECT opened, resolved, resolution FROM attention_items WHERE level_rank >= 3 AND resolved IS NOT NULL AND resolved >= ?").all(since) as any[];
        const ms = rows.filter((r) => !NOT_UNBLOCKED.test(r.resolution ?? "")).map((r) => Date.parse(r.resolved) - Date.parse(r.opened)).filter((x) => x >= 0).sort((a, b) => a - b);
        return { count: ms.length, p50_ms: C.quantile(ms, 0.5), p90_ms: C.quantile(ms, 0.9), mean_ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null };
      };
      const open: Record<Level, number> = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
      let snoozed = 0;
      const nowIso = new Date(nowMs).toISOString();
      for (const r of db.prepare("SELECT level, snoozed_until FROM attention_items WHERE resolved IS NULL").all() as any[]) {
        if (r.snoozed_until && r.snoozed_until > nowIso) snoozed++; else open[r.level as Level]++;
      }
      // "Checking" proxy: herdr pane focus switches while nothing at L3/L4 was waiting.
      const since24 = new Date(nowMs - 24 * 3600e3).toISOString();
      const focus = (db.prepare("SELECT ts FROM events WHERE type = 'pane.focused' AND ts >= ? ORDER BY ts").all(since24) as any[]).map((r) => r.ts as string);
      const openAt = db.prepare("SELECT count(*) AS n FROM attention_items WHERE level_rank >= 3 AND opened <= ? AND (resolved IS NULL OR resolved > ?)");
      const hours = new Map<string, { hour: string; focus: number; checking: number }>();
      for (let h = 23; h >= 0; h--) { const k = new Date(nowMs - h * 3600e3).toISOString().slice(0, 13); hours.set(k, { hour: k, focus: 0, checking: 0 }); }
      let checking = 0;
      for (const ts of focus) {
        const idle = ((openAt.get(ts, ts) as any).n ?? 0) === 0;
        if (idle) checking++;
        const b = hours.get(ts.slice(0, 13));
        if (b) { b.focus++; if (idle) b.checking++; }
      }
      const notif24 = notifications.filter((n) => Date.parse(n.at) >= nowMs - 24 * 3600e3);
      return {
        generated: nowIso,
        blocked_to_unblocked: { "1d": latency(24 * 3600e3), "7d": latency(7 * 24 * 3600e3) },
        open, snoozed,
        checking: { focus_switches: focus.length, while_nothing_pending: checking, per_hour: [...hours.values()] },
        notifications: { sent_24h: notif24.filter((n) => n.delivered).length, deduped_24h: notif24.filter((n) => n.deduped).length },
        jev: jevStats(), llm: llmStats(),
      };
    }

    // ---------- classification ----------
    /** Later activity wins even when an older classification finishes afterwards. */
    const activityAfter = (session: string | null, at: string): { ts: string; type: string } | undefined =>
      session ? db.prepare("SELECT ts, type FROM events WHERE session IN (?, ?) AND type IN ('prompt.submit', 'turn.stop', 'tool.pre', 'session.end') AND ts > ? ORDER BY ts LIMIT 1").get(session, C.rawSession(session), at) as { ts: string; type: string } | undefined : undefined;
    const where = (e: EventRecord) => (e.cwd ? ` in ${repoName(repoRootOf(e.cwd) ?? e.cwd)}` : "");

    async function askJev(state: unknown): Promise<C.JevAttention | null> {
      if (!jevAvailable()) return null;
      try { return C.readAttention(await jev(state, C.attentionQuestions(), { timeoutMs: 8000, retries: 1 })); }
      catch (err: any) { ctx.log(`attention: jev failed, using the rule fallback: ${err.message}`); return null; }
    }
    const jevField = (j: C.JevAttention | null): AttentionItem["jev"] =>
      j ? { level: j.level ?? undefined, p_needs_human: j.p_needs_human ?? undefined, probabilities: j.probabilities } : null;

    /** turn.stop / idle_prompt: one Jev call decides level, needs-human and kind; the floor still holds. */
    function classifyTurn(e: EventRecord, key: string | null, trigger: "stop" | "idle", fresh: boolean) {
      if (!key) return;
      const worker = workerOf(key, e);
      if (isControl(key, worker)) {
        resolveWhere(openForSession(key), (it) => TURN_KINDS.has(it.kind), "Firstmate decisions use held tasks", e.ts, fresh);
        return;
      }
      const last = trigger === "stop" ? String(e.data?.last ?? "") : (lastMessage.get(key) ?? "");
      if (trigger === "stop") lastMessage.set(key, last);
      const floor: Level = trigger === "idle" ? "L1" : "L0";
      if (trigger === "idle") {
        const seen = seenForSession(key);
        if (seen && !db.prepare("SELECT 1 FROM events WHERE session IN (?, ?) AND type = 'turn.stop' AND ts > ? LIMIT 1").get(key, C.rawSession(key), seen.ref.acked_at)) return;
        // Idle reminders never demote what the turn stop already raised.
        const held = openForSession(key).find((it) => TURN_KINDS.has(it.kind) && C.rank(it.level) >= 2);
        if (held) { save({ ...held, ref: { ...held.ref, idle_since: e.ts } }, dedupeOf(held.id)!); changed(held.id); return; }
      }
      const why = C.whyFromMessage(last) || (trigger === "idle" ? truncate(String(e.data?.message ?? "Waiting for your input"), 240) : "");
      const state = {
        event: trigger === "stop" ? "turn.stop" : "idle_prompt",
        agent: e.agent ?? "claude", repo: e.cwd ? repoName(repoRootOf(e.cwd) ?? e.cwd) : null,
        last_message: truncate(last.length > 1500 ? "…" + last.slice(-1500) : last, 1600),
      };
      const apply = (j: C.JevAttention | null) => {
        if (isControl(key, workerOf(key, e))) return;
        let level: Level, kind: C.Kind;
        if (j?.level) { level = C.finalLevel(floor, j.level); kind = j.kind ?? (trigger === "idle" ? "idle" : "progress"); }
        else { const fb = C.fallbackClassify(last); level = C.finalLevel(floor, fb.level); kind = trigger === "idle" && fb.kind === "progress" ? "idle" : fb.kind; }
        const activity = activityAfter(key, e.ts);
        // The new turn state supersedes the session's previous turn-state items.
        resolveWhere(openForSession(key), (it) => TURN_KINDS.has(it.kind) && it.kind !== kind && (it.ref.event_ts ?? it.opened) <= e.ts, "superseded", e.ts, fresh);
        if (level === "L0") { const same = openByDedupe(`${key}|${kind}`); if (same) resolve(same.id, "superseded", e.ts, fresh); return; }
        const { item } = upsert({
          level, floor, kind, title: C.KIND_TITLES[kind] + where(e), why, session: key, worker: workerOf(key, e), opened: e.ts,
          jev: jevField(j), ref: { event: e.id, event_ts: e.ts, trigger, jev_kind: j ? { choice: j.kind, probabilities: j.kind_probabilities } : null, rule_fallback: !j },
        }, { emit: fresh && !activity, notify: fresh && !activity });
        if (item && activity && item.ref.event_ts === e.ts && (C.rank(item.level) >= 3 || item.kind === "idle")) {
          resolve(item.id, activity.type === "prompt.submit" ? "human replied" : "superseded", activity.ts, false);
        }
      };
      // Replayed events take the rule path synchronously so they interleave correctly with later replies.
      if (!fresh || !jevAvailable()) { apply(null); return; }
      track(askJev(state).then(apply));
    }

    /** Events with a hard floor open immediately; Jev may raise them afterwards. */
    function floorItem(e: EventRecord, inp: RaiseInput, fresh: boolean, jevState?: unknown) {
      const { item, created } = upsert(inp, { emit: fresh, notify: fresh });
      if (!item || !created || !fresh || jevState === undefined) return;
      track((async () => {
        const j = await askJev(jevState);
        const cur = get(item.id);
        if (!j || !cur || cur.resolved) return;
        const level = C.finalLevel(cur.floor, j.level);
        const next: AttentionItem = { ...cur, level, jev: jevField(j), ref: { ...cur.ref, jev_kind: { choice: j.kind, probabilities: j.kind_probabilities } } };
        save(next, dedupeOf(cur.id)!);
        if (level !== cur.level) record("attention.update", next, true, { prev_level: cur.level });
        changed(cur.id);
        if (C.rank(level) > C.rank(cur.level)) maybeNotify(next);
      })());
    }

    function overlap(e: EventRecord, key: string, canOpen: boolean, fresh: boolean) {
      const files = editedPaths(e.data?.input, e.cwd);
      if (!files.length) return;
      const since = new Date(Date.parse(e.ts) - OVERLAP_WINDOW_MS).toISOString();
      for (const file of files) {
        db.prepare("INSERT INTO attention_touches(session, path, ts) VALUES (?,?,?) ON CONFLICT(session, path) DO UPDATE SET ts = max(ts, excluded.ts)").run(key, file, e.ts);
        if (!canOpen) continue;
        const others = (db.prepare("SELECT session, ts FROM attention_touches WHERE path = ? AND session != ? AND ts >= ?").all(file, key, since) as any[])
          .filter((o) => !db.prepare("SELECT 1 FROM events WHERE type = 'session.end' AND session = ? AND ts > ? LIMIT 1").get(C.rawSession(o.session), o.ts));
        for (const o of others) {
          const pair = [key, o.session].sort();
          const dedupe = `overlap:${pair.join("|")}`;
          const prev = openByDedupe(dedupe);
          const pathsSeen = [...new Set([...(prev?.ref?.paths ?? []), file])];
          upsert({
            level: "L2", floor: "L2", kind: "overlap", dedupe, session: key, worker: workerOf(key, e),
            title: `Two sessions editing ${path.basename(file)}${pathsSeen.length > 1 ? ` and ${pathsSeen.length - 1} more` : ""}`,
            why: `${file} was edited by ${pair[0]} and ${pair[1]} within 2 hours`, opened: e.ts,
            ref: { event: e.id, event_ts: e.ts, paths: pathsSeen, sessions: pair },
          }, { emit: fresh, notify: fresh });
        }
      }
    }

    function handle(e: EventRecord) {
      if (e.source === "attention") return;
      const age = Date.now() - Date.parse(e.ts);
      const fresh = age < FRESH_MS;
      const canOpen = age < OPEN_HORIZON_MS;
      const key = C.sessionKeyOf(e);
      const d = e.data ?? {};
      switch (e.type) {
        case "prompt.submit":
          resolveWhere(openForSession(key), (it) => (C.rank(it.level) >= 3 && it.kind !== "guard") || it.kind === "idle", "human replied", e.ts, fresh);
          return;
        case "permission.request":
          if (!canOpen || !key) return;
          floorItem(e, {
            level: "L3", floor: "L3", kind: "approval", title: `Needs permission: ${d.tool ?? "tool"}${where(e)}`, why: C.whyFromTool(d.tool, d.input),
            session: key, worker: workerOf(key, e), opened: e.ts, ref: { event: e.id, event_ts: e.ts, tool: d.tool ?? null },
          }, fresh, { event: "tool prompt", note: "the agent wants to run a tool and is held at a prompt until the person allows it", tool: d.tool ?? null, input: truncate(String(typeof d.input === "string" ? d.input : JSON.stringify(d.input ?? "")), 600) });
          return;
        case "notification": {
          const kind = String(d.kind ?? "");
          if (kind === "permission_prompt") {
            if (!canOpen || !key) return;
            // The notification text is generic ("Claude needs your permission"); the tool call that
            // triggered it is the last tool.pre for this session, so show that instead.
            const lastTool = e.session ? (db.prepare("SELECT json FROM events WHERE session = ? AND type = 'tool.pre' AND ts <= ? ORDER BY ts DESC LIMIT 1").get(e.session, e.ts) as any) : null;
            const tp = lastTool ? JSON.parse(lastTool.json) : null;
            const generic = /needs your permission|waiting for (your )?(approval|permission)/i.test(String(d.message ?? ""));
            const why = tp && (generic || !d.message) && Date.parse(e.ts) - Date.parse(tp.ts) < 120000
              ? C.whyFromTool(tp.data?.tool, tp.data?.input)
              : truncate(String(d.message ?? "The agent is waiting for approval"), 240);
            floorItem(e, {
              level: "L3", floor: "L3", kind: "approval", title: `Needs permission${where(e)}`, why,
              session: key, worker: workerOf(key, e), opened: e.ts, ref: { event: e.id, event_ts: e.ts },
            }, fresh, { event: "tool prompt", note: "the agent is held at a prompt until the person allows it", message: truncate(String(d.message ?? ""), 600) });
          } else if (kind === "idle_prompt" && canOpen) classifyTurn(e, key, "idle", fresh);
          return;
        }
        case "turn.stop":
          resolveWhere(openForSession(key), (it) => ["question", "decision"].includes(it.kind) && it.opened < e.ts, "superseded", e.ts, fresh);
          resolveWhere(openForSession(key), (it) => it.kind === "approval" && !it.ref?.herdr, "agent resumed", e.ts, fresh);
          if (canOpen) classifyTurn(e, key, "stop", fresh);
          return;
        case "turn.stop_failure":
          if (!canOpen || !key) return;
          resolveWhere(openForSession(key), (it) => TURN_KINDS.has(it.kind) && it.kind !== "error" && it.opened <= e.ts, "superseded", e.ts, fresh);
          upsert({
            level: "L3", floor: "L3", kind: "error", title: C.KIND_TITLES.error + where(e), why: truncate(String(typeof d.error === "string" ? d.error : JSON.stringify(d.error ?? "The turn failed")), 240),
            session: key, worker: workerOf(key, e), opened: e.ts, ref: { event: e.id, event_ts: e.ts },
          }, { emit: fresh, notify: fresh });
          return;
        case "tool.pre": {
          if (!key) return;
          const ms = Date.parse(e.ts);
          resolveWhere(openForSession(key), (it) => ["question", "decision"].includes(it.kind) && it.opened < e.ts, "superseded", e.ts, fresh);
          resolveWhere(openForSession(key), (it) => it.kind === "approval" && !it.ref?.herdr && ms - Date.parse(it.opened) > RESUME_GRACE_MS, "agent resumed", e.ts, fresh);
          if (EDIT_TOOLS.test(String(d.tool ?? ""))) overlap(e, key, canOpen, fresh);
          return;
        }
        case "session.end":
          resolveWhere(openForSession(key), (it) => it.kind !== "guard", "session ended", e.ts, fresh);
          return;
        case "agent.status": {
          const status = String(d.status ?? "");
          const sKey = C.sessionRefKey(d.session_ref, d.agent) ?? key;
          const pane = e.pane ?? d.pane ?? null;
          const worker = typeof d.worker === "string" ? d.worker : pane ? `${d.machine ?? "local"}:${pane}` : null;
          if (status === "blocked") {
            if (!canOpen || isControl(sKey, worker)) return;
            const held = openForSession(sKey).find((it) => C.rank(it.level) >= 3 && it.kind !== "guard");
            if (held) { save({ ...held, worker: held.worker ?? worker, ref: { ...held.ref, herdr_blocked: e.ts } }, dedupeOf(held.id)!); changed(held.id); return; }
            upsert({
              level: "L3", floor: "L3", kind: "question", title: `Waiting on you${where(e)}`, why: truncate(String(d.last ?? d.message ?? `Herdr reports the ${d.agent ?? "agent"} is blocked`), 240),
              session: sKey, worker, dedupe: sKey ? `${sKey}|question` : `${worker}|blocked`, opened: e.ts, ref: { event: e.id, event_ts: e.ts, herdr: true },
            }, { emit: fresh, notify: fresh });
          } else if (["working", "idle", "done", "exited"].includes(status)) {
            const candidates = [...openForSession(sKey), ...(worker ? (db.prepare("SELECT json FROM attention_items WHERE worker = ? AND resolved IS NULL").all(worker) as any[]).map(parse) : [])];
            resolveWhere(candidates, (it) => Boolean(it.ref?.herdr || it.ref?.herdr_blocked) || it.kind === "approval", "agent resumed", e.ts, fresh);
          }
          return;
        }
        case "guard.request":
          if (!canOpen || !d.request) return;
          upsert({
            level: "L4", floor: "L4", kind: "guard", title: `Approve: ${d.title ?? d.rule ?? "gated action"}`, why: truncate(String(d.summary ?? ""), 240),
            session: key, worker: workerOf(key, e), dedupe: `guard:${d.request}`, opened: e.ts,
            ref: { event: e.id, event_ts: e.ts, request: d.request, rule: d.rule ?? null, deadline: d.deadline ?? null },
          }, { emit: fresh, notify: fresh });
          return;
        case "guard.decision": {
          const it = d.request ? openByDedupe(`guard:${d.request}`) : null;
          if (it) resolve(it.id, `guard ${d.decision ?? "decided"}${d.reason ? `: ${truncate(String(d.reason), 120)}` : ""}`, e.ts, fresh);
          return;
        }
        case "intent.sent":
        case "intent.acked": {
          const intent = d.intent ?? d;
          const kind = String(intent.kind ?? "");
          if (!["reply", "approve", "deny"].includes(kind)) return;
          const target = String(intent.target ?? "");
          const payload = intent.payload ?? {};
          const itemId = payload.attention ?? payload.attention_id ?? payload.item;
          const resolution = kind === "reply" ? "human replied" : kind === "approve" ? "approved" : "denied";
          if (itemId) { resolve(String(itemId), resolution, e.ts, fresh); return; }
          const targets = new Set([target, intent.result?.worker, intent.result?.session].filter((x): x is string => typeof x === "string" && x.length > 0));
          const pool = allOpen().filter((it) => (it.session && targets.has(it.session)) || (it.worker && targets.has(it.worker)) || targets.has(String(it.ref?.request ?? "")) || (key && it.session === key));
          resolveWhere(pool, (it) => kind === "reply" ? ((C.rank(it.level) >= 3 && it.kind !== "guard") || it.kind === "idle") : (it.kind === "approval" || it.kind === "guard"), resolution, e.ts, fresh);
          return;
        }
      }
    }
    ctx.bus.onEvent((e) => { try { handle(e); } catch (err: any) { ctx.log(`attention: ${e.type} handler failed: ${err.message}`); } });

    // ---------- service ----------
    const service: AttentionService = {
      list, get, metrics,
      raise: (inp) => upsert(inp).item,
      resolve: (id, resolution, at) => resolve(id, resolution, at),
      label,
      snooze: (id, until) => label(id, "snooze", { until }).item!,
      notifications: () => [...notifications],
      async settle() { while (pending.size) await Promise.allSettled([...pending]); },
    };
    ctx.services.set("attention", service);

    // ---------- routes ----------
    const wrap = (fn: (c: any) => Promise<Response> | Response) => async (c: any) => {
      try { return await fn(c); } catch (e: any) { return c.json({ error: e.message }, e instanceof HttpError ? e.status : 500); }
    };
    const bool = (v: string | undefined) => (v === undefined ? undefined : ["1", "true", "yes"].includes(v));
    app.get("/api/attention", (c) => {
      const qy = c.req.query();
      return c.json(list({
        open: bool(qy.open), level: C.isLevel(qy.level) ? qy.level : undefined, min_level: C.isLevel(qy.min_level) ? qy.min_level : undefined,
        mission: qy.mission || undefined, session: qy.session || undefined, kind: qy.kind || undefined,
        include_snoozed: bool(qy.include_snoozed), limit: qy.limit ? Number(qy.limit) : undefined,
      }));
    });
    app.get("/api/attention/notifications", (c) => c.json(service.notifications()));
    app.post("/api/attention", wrap(async (c) => {
      const b = await c.req.json();
      if (!C.isLevel(b.level) || !b.kind || !b.title) throw new HttpError(400, "An attention item needs level, kind and title.");
      const parsed = AttentionItem.shape.kind.safeParse(b.kind);
      if (!parsed.success) throw new HttpError(400, `Unknown kind "${b.kind}".`);
      return c.json(service.raise(b));
    }));
    app.get("/api/attention/:id", (c) => { const it = get(c.req.param("id")); return it ? c.json(it) : c.json({ error: "No such attention item." }, 404); });
    app.post("/api/attention/:id/resolve", wrap(async (c) => {
      const b = await c.req.json().catch(() => ({}));
      const it = resolve(c.req.param("id"), String(b.resolution ?? "resolved in Joyride"));
      if (!it) throw new HttpError(404, "No such attention item.");
      return c.json(it);
    }));
    app.post("/api/attention/:id/label", wrap(async (c) => {
      const b = await c.req.json().catch(() => ({}));
      return c.json(label(c.req.param("id"), b.label, { level: b.level, reason: b.reason, until: b.until, minutes: b.minutes }));
    }));
    app.post("/api/attention/:id/undo-ack", wrap(async (c) => {
      const it = get(c.req.param("id"));
      if (!it) throw new HttpError(404, "No such attention item.");
      if (it.resolution !== "acknowledged") throw new HttpError(409, "This item is no longer acknowledged. Refresh the list.");
      const { acked_at, ...ref } = it.ref;
      const next = { ...it, resolved: null, resolution: null, ref };
      save(next, dedupeOf(it.id)!);
      record("attention.update", next, true);
      changed(it.id);
      return c.json(next);
    }));
    app.post("/api/attention/:id/snooze", wrap(async (c) => {
      const b = await c.req.json().catch(() => ({}));
      return c.json(label(c.req.param("id"), "snooze", { until: b.until, minutes: b.minutes, reason: b.reason }));
    }));
    app.get("/api/metrics", (c) => c.json(metrics()));
  },
});
