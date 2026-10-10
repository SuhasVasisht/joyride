// One fleet (docs/fleet-operator.md): every live session is a fleet member that Firstmate supervises.
// Crew is what Firstmate launched for its tasks and owns; watched is what the captain started, which
// Firstmate guides through Joyride and may retire idle panes only after preserving their context;
// excluded is what the captain keeps to themself. Firstmate's own pane is not a member.
//   authored  fleet.yaml (policy.ts): membership, exclusions and Firstmate's authority over watched sessions
//   runtime   .joyride/state/fleet.json: each member's last state and helm, and the sessions already announced
//   feed      fleet events Firstmate needs (feed.ts), long-polled by the joyride-fleet-feed extension
//   relay     captain inbox notes (relay.ts): sessions that joined, and the captain's hand-backs
//   service `fleet`: policy(), excluded(w), list(), member(id), events({after, limit}), poll(...), steer(worker, text), answer(worker, choice, why)
//   routes: /api/fleet, /api/fleet/members/:id, /api/fleet/events, /api/fleet/feed, POST /api/fleet/{steer, answer, hand-back, exclude, include}
//   intents: exclude_session, include_session (the captain's; they edit fleet.yaml)
//   bus entity: fleet (data.policy when fleet.yaml changed)
import fs from "node:fs";
import { createPruning } from "./pruning.ts";
import path from "node:path";
import { defineModule, type Ctx } from "../../core/context.ts";
import { commitPaths } from "../../core/gitstore.ts";
import { readJson, writeFileAtomic, writeJsonAtomic } from "../../core/util.ts";
import { paths } from "../../shared/paths.ts";
import type { AttentionItem, EventRecord, WorkerView } from "../../shared/schema.ts";
import { IntentError } from "../live/intents.ts";
import { promptOf, readScreen } from "../live/screen.ts";
import { DEFAULT_POLICY, closedPolicy, isExcluded, readPolicy, renderPolicy, withMembership, type FleetPolicy } from "./policy.ts";
import { counts, roster, type FleetMember } from "./roster.ts";
import { REPORTED_STATES } from "./state.ts";
import { HELM_MAX_HOLD_MS } from "../live/helm.ts";
import { FEED_SQL, FleetFeed, feedText, type FeedEvent, type FeedInput } from "./feed.ts";
import { handBackNote, joinedNote, joinedRequestId, type CaptainSaid } from "./relay.ts";

export const operatorDoc = () => path.join(paths.code, "docs", "fleet-operator.md");
export const joyrideBin = () => path.join(paths.code, "bin", "joyride");
const stateFile = () => path.join(paths.state, "fleet.json");
/** A feed consumer that polled within this long counts as attached. */
export const ATTACHED_MS = 3 * 60_000;
const JOIN_BATCH_MS = Number(process.env.JOYRIDE_FLEET_JOIN_BATCH_MS ?? 20_000);
const RETRY_MS = 60_000;
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

/** A member's last seen tier, state and helm (`since`/`until` of a captain helm), kept a day after it was last seen. */
type Snap = { tier: string; state: string; helm: string; since?: string | null; until: string | null; session: string | null; seen: string };
const SNAP_KEEP_MS = 24 * 3600e3;
type FleetFile = { members: Record<string, Snap>; announced: string[] };

let lifecycle: { start(): void; stop(): void } | null = null;

export default defineModule({
  name: "fleet",
  order: 70,
  migrations: { "001": FEED_SQL },
  register(ctx: Ctx) {
    const { app, db } = ctx;
    const feed = new FleetFeed(db);
    let policy: FleetPolicy = DEFAULT_POLICY;
    let lastGood: FleetPolicy | null = null;
    let policyError: string | null = null;
    let policyMtime = -1;
    let policyChecked = 0;
    const optional = <T,>(name: string): T | null => { try { return (ctx.services.get(name) as T | undefined) ?? null; } catch { return null; } };

    /** fleet.yaml, re-read when its mtime changes (the captain may edit it by hand). */
    function currentPolicy(): FleetPolicy {
      // The workers projection asks once per worker per recompute: look at the file at most once a second.
      if (policyMtime !== -1 && Date.now() - policyChecked < 1000) return policy;
      policyChecked = Date.now();
      let m = 0;
      try { m = fs.statSync(paths.fleet).mtimeMs; } catch { m = 0; }
      if (m !== policyMtime) {
        policyMtime = m;
        const r = readPolicy(paths.fleet);
        // Broken: closed, keeping the last good membership so no session silently changes tier.
        policy = r.error ? closedPolicy(lastGood) : r.policy;
        if (!r.error) lastGood = r.policy;
        if (r.error && r.error !== policyError) ctx.log(`fleet: ${r.error}`);
        policyError = r.error;
      }
      return policy;
    }

    function savePolicy(next: FleetPolicy, message: string): string | null {
      writeFileAtomic(paths.fleet, renderPolicy(next));
      policyMtime = -1;
      const sha = commitPaths([paths.fleet], message);
      ctx.bus.change({ entity: "fleet", data: { policy: true } });
      return sha;
    }

    const workers = () => optional<{ list(): WorkerView[]; get(id: string): WorkerView | null; forSession(k: string): WorkerView | null }>("workers");
    const attention = (): AttentionItem[] => { try { return optional<any>("attention")?.list({ open: true }) ?? []; } catch { return []; } };
    const goalOf = (session: string): string | null => { try { return optional<any>("intentions")?.get(session)?.goal ?? null; } catch { return null; } };

    function list(): FleetMember[] {
      const w = workers();
      if (!w) return [];
      return roster(w.list(), attention(), goalOf);
    }
    const member = (id: string) => list().find((m) => m.worker === id || m.session === id) ?? null;

    function consumersStatus() {
      const t = Date.now();
      const cs = feed.consumers().map((c) => ({ ...c, attached: Boolean(c.last_poll && t - Date.parse(c.last_poll) < ATTACHED_MS) }));
      return { attached: cs.some((c) => c.attached), consumers: cs, last_seq: feed.lastSeq() };
    }

    const intents = () => optional<any>("intents");
    async function viaIntent(kind: string, target: string, payload: Record<string, unknown>, origin: "captain" | "firstmate") {
      const r = intents();
      if (!r) throw new IntentError("The live module is not running, so nothing can be sent.");
      return r.create(kind, target, payload, { origin });
    }

    const api = {
      policy: () => currentPolicy(),
      policyError: () => (currentPolicy(), policyError),
      excluded: (w: { id: string; session: string | null; cwd: string }) => isExcluded(currentPolicy(), w),
      list,
      member,
      counts: () => counts(list()),
      events: (o: { after?: number; limit?: number } = {}) => (o.after != null ? feed.after(o.after, o.limit) : feed.latest(o.limit)),
      poll: (consumer: string, request: string, waitMs: number) => feed.poll(consumer, request, waitMs),
      feed: consumersStatus,
      /** Firstmate's guarded steer of a watched session: a reply intent with origin firstmate (steer-guard.ts). */
      steer: (worker: string, text: string) => viaIntent("reply", worker, { text }, "firstmate"),
      /** Firstmate's guarded answer to a watched session's own permission prompt. */
      answer: (worker: string, choice: string, why: string) => viaIntent("answer_prompt", worker, { choice, why }, "firstmate"),
    };
    const pruning = createPruning(ctx, currentPolicy, () => (currentPolicy(), policyError));
    ctx.services.set("fleet", { ...api, ...pruning });

    // ---------- membership intents (the captain's) ----------
    const reg = intents();
    const membership = (keep: "exclude" | "include") => async (it: any) => {
      if ((it.origin ?? "captain") !== "captain") throw new IntentError(`Only the captain decides which sessions ${keep === "exclude" ? "stay out of" : "join"} the fleet.`, { refused: "captain_only" });
      const target = String(it.target ?? "").trim();
      if (!target) throw new IntentError("Say which session: a worker id, a session key or an absolute folder.");
      const w = workers()?.get(target) ?? workers()?.forSession(target) ?? null;
      if (!w && !path.isAbsolute(target) && !/^(claude|codex):/.test(target)) throw new IntentError(`${target} is not a live worker, a session key (claude:<id>) or an absolute folder.`);
      const tier = w?.owner?.tier;
      if (tier === "crew") throw new IntentError(`${w!.title || w!.id} is crew on task ${w!.owner.task}: Firstmate launched it and owns it, so it can't be kept out of the fleet. Ask Firstmate to stop the task instead.`);
      if (tier === "control") throw new IntentError("That is Firstmate's own pane; it is not a fleet member.");
      const m = w ? { id: w.id, session: w.session, cwd: w.cwd } : null;
      const cur = currentPolicy();
      if (policyError) throw new IntentError(`${policyError} Fix fleet.yaml first, then ${keep === "exclude" ? "keep" : "include"} the session again.`, { refused: "policy_broken" });
      const next = withMembership(cur, target, m, keep);
      if (!next) return { target, changed: false, excluded: m ? isExcluded(cur, m) : cur.excluded.includes(target) };
      if (keep === "include" && m && isExcluded(next, m)) throw new IntentError(`${w!.title || w!.id} is kept out by a folder rule in fleet.yaml (${next.excluded.find((e) => path.isAbsolute(e) && m.cwd.startsWith(e)) ?? "membership: opt-in"}). Edit fleet.yaml to change that rule.`);
      const label = w ? `${w.title || w.id}` : target;
      const commit = savePolicy(next, `fleet: ${keep === "exclude" ? "keep" : "include"} ${label}${keep === "exclude" ? " out of the fleet" : " in the fleet"}`);
      pass(); // report the change now, even if the captain flips it back before the next scheduled pass
      return { target, entry: w ? (w.session ?? w.id) : target, changed: true, commit };
    };
    reg?.registerHandler("exclude_session", membership("exclude"));
    reg?.registerHandler("include_session", membership("include"));

    // ---------- watching: transitions into the feed, new members into one note ----------
    let file: FleetFile = { members: {}, announced: [] };
    let loaded = false;
    const handedBack = new Map<string, number>(); // worker -> when the captain handed its helm back
    /** How the helm came back: the captain's hand-back, else the quiet time (or the 12-hour cap) ran out. */
    function helmBackVia(worker: string, prev: Snap): "hand_back" | "quiet" {
      const t = handedBack.get(worker);
      handedBack.delete(worker);
      if (t && Date.now() - t < 10 * 60_000) return "hand_back";
      if (prev.until) return Date.parse(prev.until) <= Date.now() ? "quiet" : "hand_back";
      return prev.since && Date.now() - Date.parse(prev.since) >= HELM_MAX_HOLD_MS ? "quiet" : "hand_back";
    }
    const joinQueue = new Map<string, FleetMember>();
    let joinTimer: NodeJS.Timeout | null = null;
    let joinFailing = false;

    function load() {
      if (loaded) return;
      loaded = true;
      file = readJson<FleetFile>(stateFile(), { members: {}, announced: [] });
      file.members ??= {}; file.announced ??= [];
    }
    function persist() {
      try { if (file.announced.length > 2000) file.announced = file.announced.slice(-2000); writeJsonAtomic(stateFile(), file); }
      catch (e: any) { ctx.log(`fleet: could not save ${stateFile()}: ${e.message}`); }
    }

    function append(e: FeedInput): FeedEvent {
      const ev = feed.append(e);
      try { ctx.emit({ source: "fleet", type: `fleet.${e.type}`, data: { seq: ev.seq, worker: e.worker, session: e.session, tier: e.tier, ...e.data } }); } catch {}
      ctx.bus.change({ entity: "fleet" });
      return ev;
    }
    const base = (m: FleetMember) => ({ worker: m.worker, session: m.session, tier: m.tier, task: m.task, title: m.goal || m.title, cwd: m.cwd });

    let rosterSnapshot: FleetMember[] = [];
    function pass() {
      load();
      let members: FleetMember[];
      try { members = list(); } catch (e: any) { ctx.log(`fleet: could not read the roster: ${e.message}`); return; }
      rosterSnapshot = members;
      const seen = new Set<string>();
      const announced = new Set(file.announced);
      const at = new Date().toISOString();
      // While fleet.yaml is broken, membership is frozen: a tier change then is the parse error, not news.
      const frozen = Boolean((currentPolicy(), policyError));
      let dirty = false;
      for (const m0 of members) {
        const was = file.members[m0.worker];
        const m = frozen && was && (was.tier === "watched" || was.tier === "excluded") && m0.tier !== "crew" ? { ...m0, tier: was.tier as FleetMember["tier"] } : m0;
        seen.add(m.worker);
        const cur: Snap = { tier: m.tier, state: m.state, helm: m.helm?.by ?? "firstmate", since: m.helm?.since ?? null, until: m.helm?.until ?? null, session: m.session, seen: at };
        const prev = file.members[m.worker];
        file.members[m.worker] = cur;
        if (!prev || prev.tier !== cur.tier || prev.state !== cur.state || prev.helm !== cur.helm || prev.until !== cur.until) dirty = true;
        if (!prev) {
          // A newcomer is announced in the joined note; what Firstmate must act on is in the feed as well.
          if (m.tier === "watched" && !announced.has(m.session ?? m.worker)) joinQueue.set(m.worker, m);
          if (m.tier === "watched" && REPORTED_STATES.has(m.state)) append({ ...base(m), type: "member.state", data: { state: m.state, prev: null, why: m.why } });
          if (m.tier !== "excluded" && cur.helm === "captain") append({ ...base(m), type: "helm.captain", data: { via: m.helm?.via ?? null, since: m.helm?.since ?? null } });
          continue;
        }
        if (prev.tier !== m.tier && (m.tier === "excluded" || prev.tier === "excluded")) {
          append({ ...base(m), type: m.tier === "excluded" ? "member.excluded" : "member.included", data: {} });
          if (m.tier === "watched" && !announced.has(m.session ?? m.worker)) joinQueue.set(m.worker, m);
        }
        if (m.tier === "watched" && prev.tier === "watched" && cur.state !== prev.state && REPORTED_STATES.has(m.state)) {
          append({ ...base(m), type: "member.state", data: { state: m.state, prev: prev.state, why: m.why } });
        }
        if (m.tier !== "excluded" && cur.helm !== prev.helm) {
          if (cur.helm === "captain") append({ ...base(m), type: "helm.captain", data: { via: m.helm?.via ?? null, since: m.helm?.since ?? null } });
          else append({ ...base(m), type: "helm.firstmate", data: { via: helmBackVia(m.worker, prev) } });
        }
      }
      // A member out of sight (Herdr reconnecting, a restart) keeps its last state for a while, so a
      // change made meanwhile is still reported when it comes back.
      for (const [id, snap] of Object.entries(file.members)) if (!seen.has(id) && Date.now() - Date.parse(snap.seen ?? "") > SNAP_KEEP_MS) { delete file.members[id]; dirty = true; }
      if (dirty) persist();
      if (joinQueue.size && !joinTimer) { joinTimer = setTimeout(flushJoined, JOIN_BATCH_MS); joinTimer.unref(); }
    }

    async function flushJoined() {
      joinTimer = null;
      if (!joinQueue.size) return;
      const fm = optional<{ note(id: string, body: string): Promise<unknown> }>("firstmate");
      // A member that left (or was excluded) before the note went out is not announced.
      const live = new Map(list().filter((m) => m.tier === "watched").map((m) => [m.worker, m]));
      const batch = [...joinQueue.keys()].map((id) => live.get(id)).filter((m): m is FleetMember => Boolean(m));
      for (const id of [...joinQueue.keys()]) if (!live.has(id)) joinQueue.delete(id);
      if (!batch.length) return;
      const keys = batch.map((m) => m.session ?? m.worker);
      try {
        if (!fm?.note) throw new Error("the firstmate module is not running");
        await fm.note(joinedRequestId(keys), joinedNote(batch, operatorDoc()));
        for (const m of batch) joinQueue.delete(m.worker);
        file.announced.push(...keys);
        persist();
        if (joinFailing) ctx.log("fleet: the joined-the-fleet note went through");
        joinFailing = false;
      } catch (e: any) {
        if (!joinFailing) ctx.log(`fleet: could not tell Firstmate that ${batch.length} session(s) joined the fleet (${e.message}); retrying every minute`);
        joinFailing = true;
        joinTimer = setTimeout(flushJoined, RETRY_MS);
        joinTimer.unref();
      }
    }

    /** The captain handed a session's helm back: tell Firstmate what they said meanwhile and where the session stands. */
    async function relayHandBack(e: EventRecord) {
      const d = e.data ?? {};
      const worker = String(d.worker ?? "");
      const fm = optional<{ note(id: string, body: string): Promise<unknown> }>("firstmate");
      if (!fm?.note) { ctx.log(`fleet: the hand-back of ${worker} was not relayed: the firstmate module is not running`); return; }
      const m = member(worker) ?? { worker, title: "", cwd: e.cwd ?? "", tier: "watched" as const, task: null };
      const session = d.session ? String(d.session) : null;
      const since = d.since ? String(d.since) : null;
      // What the captain said while at the helm: their prompts typed into the session, and their
      // replies from Joyride that went in (a failed or refused one said nothing).
      const said: CaptainSaid[] = [];
      const from = since ?? e.ts;
      try {
        const rows = db.prepare(`SELECT json FROM events WHERE source = 'live' AND type = 'steer.attributed' AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 500`).all(from, e.ts) as { json: string }[];
        for (const r of rows) {
          const x = JSON.parse(r.json), xd = x.data ?? {};
          if (xd.by === "captain" && xd.via !== "joyride-reply" && (xd.worker === worker || (session && xd.session === session))) said.push({ at: x.ts, text: String(xd.prompt ?? "") });
        }
        const replies = (intents()?.list({ target: worker, kind: "reply", limit: 100 }) ?? []) as { origin?: string; status: string; created: string; payload: any }[];
        for (const it of replies) {
          if ((it.origin ?? "captain") === "captain" && (it.status === "sent" || it.status === "acked") && it.created >= from && it.created <= e.ts) said.push({ at: it.created, text: String(it.payload?.text ?? "") });
        }
        said.sort((a, b) => a.at.localeCompare(b.at));
      } catch (err: any) { ctx.log(`fleet: could not read what the captain said to ${worker}: ${err.message}`); }
      let intention: any = null;
      try { intention = session ? optional<any>("intentions")?.get(session) ?? null : null; } catch {}
      try { await fm.note(`fleet-handback-${d.intent ?? e.id}`, handBackNote({ member: m, since, said: said.filter((s) => s.text.trim()), intention, operatorDoc: operatorDoc() })); }
      catch (err: any) { ctx.log(`fleet: could not relay the hand-back of ${worker} to Firstmate: ${err.message}`); }
    }

    let passTimer: NodeJS.Timeout | null = null;
    const schedule = () => { if (passTimer) return; passTimer = setTimeout(() => { passTimer = null; void ctx.service<import("../../core/diagnostics.ts").Diagnostics>("diagnostics").refresh("fleet", pass).catch((e) => ctx.log(`fleet: refresh failed: ${e}`)); }, 300); passTimer.unref(); };
    const offChange = ctx.bus.onChange((c) => { if (c.entity === "workers" || c.entity === "attention" || (c.entity === "fleet" && (c.data as any)?.policy)) schedule(); });
    // Helm changes are reported on the event that makes them (the live module, registered first, has
    // already applied it), so a helm the captain takes and hands back within seconds is still seen.
    const offEvent = ctx.bus.onEvent((e) => {
      const d = e.data ?? {};
      const captainSteer = (e.source === "live" && e.type === "steer.attributed" && d.by === "captain")
        || (e.source === "intent" && e.type === "intent.sent" && d.kind === "reply" && (d.origin ?? "captain") === "captain");
      if (e.source === "live" && e.type === "helm.released" && d.worker) handedBack.set(String(d.worker), Date.now());
      if (captainSteer || (e.source === "live" && e.type === "helm.released")) pass();
      if (e.source === "live" && e.type === "helm.released" && d.via === "hand_back") relayHandBack(e).catch((err) => ctx.log(`fleet: hand-back relay failed: ${err.message}`));
    });
    let tick: NodeJS.Timeout | null = null;
    lifecycle = {
      start: () => {
        pruning.start();
        try { feed.prune(); } catch (e: any) { ctx.log(`fleet: could not prune old fleet events: ${e.message}`); }
        schedule(); tick = setInterval(schedule, 30_000); tick.unref();
      },
      stop: () => { pruning.stop(); offChange(); offEvent(); if (tick) clearInterval(tick); if (passTimer) clearTimeout(passTimer); if (joinTimer) clearTimeout(joinTimer); feed.release(); },
    };

    // ---------- routes ----------
    const intentReply = (c: any, it: any) => c.json(it, it.status === "failed" ? (it.result?.refused ? 409 : 400) : 200);
    const body = async (c: any): Promise<any> => { try { return await c.req.json(); } catch { return null; } };

    app.get("/api/fleet/prune", async (c) => c.json({ dry_run: true, candidates: await pruning.candidates(), thresholds: currentPolicy().pruning }));
    app.get("/api/fleet/prunes", (c) => c.json(pruning.proposals()));
    app.post("/api/fleet/propose-prune", async (c) => {
      const b = await body(c);
      try { return c.json(pruning.propose(String(b?.worker ?? ""), String(b?.why ?? "Firstmate proposes saving and closing this idle pane."))); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
    });
    app.post("/api/fleet/retire", async (c) => {
      const b = await body(c);
      return intentReply(c, await pruning.retire(String(b?.worker ?? "")));
    });
    app.post("/api/fleet/prunes/:id/decide", async (c) => {
      const b = await body(c);
      if (b?.origin && b.origin !== "captain") return c.json({ error: "Only the captain answers prune asks." }, 403);
      if (typeof b?.approve !== "boolean") return c.json({ error: "Send {approve: true|false}." }, 400);
      try {
        const result = await pruning.decide(c.req.param("id"), b.approve);
        return c.json(result, "status" in result && result.status === "failed" ? 409 : 200);
      } catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
    });
    app.get("/api/fleet", (c) => {
      const members = rosterSnapshot;
      return c.json({ members, counts: counts(members), policy, policy_error: policyError, feed: consumersStatus(), operator_doc: operatorDoc() });
    });
    app.get("/api/fleet/members/:id", async (c) => {
      const m = member(c.req.param("id"));
      if (!m) return c.json({ error: `${c.req.param("id")} is not a live fleet member. Run joyride fleet to see the roster.` }, 404);
      let prompt: { question: string; options: string[] } | null = null;
      const w = workers()?.get(m.worker);
      const h = optional<any>("herdr");
      if (m.status === "blocked" && w?.pane && h) { try { prompt = promptOf(await readScreen(h, w.pane, w.machine)); } catch {} }
      return c.json({ ...m, prompt });
    });
    app.get("/api/fleet/events", (c) => {
      const after = c.req.query("after");
      const limit = Number(c.req.query("limit") ?? 50) || 50;
      return c.json({ events: api.events({ after: after != null && after !== "" ? Number(after) : undefined, limit }), last_seq: feed.lastSeq() });
    });
    // The joyride-fleet-feed extension's long poll: {events, text}; text is empty when nothing came.
    app.get("/api/fleet/feed", async (c) => {
      // A poll moves the consumer's place in the feed, so it needs a header a web page can't send
      // without a CORS preflight (which the daemon never grants), and never comes from another site.
      if (c.req.header("x-joyride-feed") !== "1" || (c.req.header("sec-fetch-site") ?? "none") === "cross-site") return c.json({ error: "The fleet feed is read by Firstmate's joyride-fleet-feed extension only (it sends X-Joyride-Feed: 1)." }, 403);
      const consumer = c.req.query("consumer") ?? "", request = c.req.query("request") ?? "";
      if (!ID_RE.test(consumer) || !ID_RE.test(request)) return c.json({ error: "Pass consumer and request: the feed's source id and the poll's request id ([A-Za-z0-9._:-], at most 160 characters)." }, 400);
      const wait = Math.max(0, Math.min(Number(c.req.query("wait") ?? 0) || 0, 55)) * 1000;
      const events = await feed.poll(consumer, request, wait);
      return c.json({ events, text: feedText(events, { doc: operatorDoc(), bin: joyrideBin() }) });
    });
    app.post("/api/fleet/steer", async (c) => {
      const b = await body(c);
      const worker = String(b?.worker ?? ""), text = String(b?.text ?? "").trim();
      if (!worker || !text) return c.json({ error: 'Send {"worker": "<worker id>", "text": "<what to tell it>"}.' }, 400);
      return intentReply(c, await api.steer(worker, text));
    });
    app.post("/api/fleet/answer", async (c) => {
      const b = await body(c);
      const worker = String(b?.worker ?? "");
      if (!worker) return c.json({ error: 'Send {"worker": "<worker id>", "choice": "allow|allow_always|deny", "why": "<reason>"}.' }, 400);
      return intentReply(c, await api.answer(worker, String(b?.choice ?? ""), String(b?.why ?? "")));
    });
    // The captain's own actions. They are refused for any other origin, whatever the route.
    const captainRoute = (kind: string) => async (c: any) => {
      const b = await body(c);
      const target = String(b?.worker ?? b?.target ?? "");
      if (!target) return c.json({ error: 'Send {"worker": "<worker id>"} (or {"target": "<session key or folder>"}).' }, 400);
      return intentReply(c, await viaIntent(kind, target, {}, "captain"));
    };
    app.post("/api/fleet/hand-back", captainRoute("hand_back"));
    app.post("/api/fleet/exclude", captainRoute("exclude_session"));
    app.post("/api/fleet/include", captainRoute("include_session"));
  },
  start() { lifecycle?.start(); },
  stop() { lifecycle?.stop(); },
});
