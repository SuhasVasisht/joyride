// Live world (checkpoints C2/C3): Herdr connection per machine, the workers
// projection, and intents. Services: `herdr`, `workers`, `intents`.
// Each human or Firstmate hook prompt.submit is attributed to its author and logged as a
// `steer.attributed` event (source live; see attribution.ts); the captain's steers set each worker's
// helm (helm.ts), and a hand_back intent gives it back early (`helm.released`). Replies and prompt
// answers that are not the captain's go through the steer guard (steer-guard.ts).
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { defineModule, type Ctx } from "../../core/context.ts";
import { HerdrService } from "./herdr.ts";
import { WorkersProjection } from "./workers.ts";
import { INTENTS_SQL, IntentError, IntentsService, registerBuiltins } from "./intents.ts";
import { stagedReplies } from "./staged.ts";
import type { TranscriptState } from "../sessions/types.ts";
import { TerminalHub } from "./terminal.ts";
import { inputOps, validKeyName, type InputOp } from "./terminal-input.ts";
import { SteerAttributor } from "./attribution.ts";
import { HelmTracker } from "./helm.ts";
import { paths } from "../../shared/paths.ts";

let herdr: HerdrService | null = null;
let workers: WorkersProjection | null = null;
let terminals: TerminalHub | null = null;

/**
 * Requests that type into terminals or start processes must come from Joyride's own page:
 * a JSON body (cross-site forms can't send one without a CORS preflight, which the daemon
 * never grants) and, when the browser says where it came from, a loopback origin.
 */
function fromLocalPage(c: Context): string | null {
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return "Send this as JSON (content-type: application/json).";
  const origin = c.req.header("origin");
  if (origin && origin !== "null") {
    try { if (["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) return null; } catch {}
    return `Requests from ${origin} can't control Joyride. Use the Joyride page on 127.0.0.1.`;
  }
  return null;
}

export default defineModule({
  name: "live",
  order: 30,
  migrations: { "001": INTENTS_SQL },
  register(ctx: Ctx) {
    const { app } = ctx;
    herdr = new HerdrService(ctx);
    const h = herdr;
    const helm = new HelmTracker();
    const w = (workers = new WorkersProjection(ctx, h, helm));
    const intents = new IntentsService(ctx);
    const term = (terminals = new TerminalHub(() => h.api()));
    registerBuiltins(intents, ctx, { herdr: () => h.api(), workers: () => w.api() });
    // The captain hands the helm back to Firstmate before the quiet time runs out. Logged as
    // `helm.released` and applied at once, so a steer right after it finds Firstmate at the helm.
    intents.handlers.set("hand_back", async (it) => {
      if ((it.origin ?? "captain") !== "captain") throw new IntentError("Only the captain hands back the helm. Firstmate waits until the captain does, or until 15 quiet minutes after the captain's turn ends.", { refused: "captain_only" });
      const wk = w.api().get(it.target);
      if (!wk) throw new IntentError(`Worker ${it.target} is not running anymore.`);
      if (wk.helm?.by !== "captain") return { worker: wk.id, session: wk.session, released: null, already: true };
      const ev = ctx.emit({
        source: "live", type: "helm.released", session: wk.session?.split(":").slice(1).join(":") || undefined, agent: wk.agent, cwd: wk.cwd || undefined, pane: wk.pane ?? undefined,
        data: { worker: wk.id, session: wk.session, since: wk.helm.since, via: "hand_back", intent: it.id, at: new Date().toISOString() },
      });
      if (helm.observe(ev)) w.changed();
      return { worker: wk.id, session: wk.session, since: wk.helm.since, released: ev.ts };
    });

    ctx.services.set("herdr", h.api());
    ctx.services.set("workers", w.api());
    ctx.services.set("intents", intents.api());

    w.seed();
    const steer = new SteerAttributor(() => paths.firstmateDir);
    // Subscribed at register time so the tailer's first drain is seen; it lives as long as the bus.
    ctx.bus.onEvent(async (e) => {
      const hooked = w.applyHook(e);
      if (helm.observe(e) || hooked) w.changed();
      intents.onEvent(e);
      steer.observe(e);
      if (e.source.startsWith("hook.") && e.type === "prompt.submit" && e.session) {
        try {
          const wk = w.api().forSession(`${e.agent ?? e.source.slice(5)}:${e.session}`);
          if (wk?.owner.tier === "control") return;
          const a = await steer.attributeSubmitted(e, wk ? { id: wk.id, pane: wk.pane, crew: wk.crew } : null);
          if (a) ctx.emit({ source: "live", type: "steer.attributed", session: e.session, agent: e.agent, cwd: e.cwd, pane: e.pane, data: a });
        } catch (err: any) { ctx.log(`live: could not attribute a prompt in ${e.session}: ${err.message}`); }
      }
    });

    app.get("/api/herdr/status", (c) => c.json(h.api().status()));
    app.get("/api/herdr/snapshot", (c) => c.json(h.api().snapshot()));
    app.post("/api/herdr/start", async (c) => {
      const bad = fromLocalPage(c);
      if (bad) return c.json({ ok: false, error: bad }, 403);
      const r = await h.api().startServer();
      return c.json(r, r.ok ? 200 : 409);
    });

    app.get("/api/workers", (c) => c.json(w.api().snapshot()));
    app.get("/api/workers/:id/screen", async (c) => {
      const wk = w.api().get(c.req.param("id"));
      if (!wk) return c.json({ error: "No such worker." }, 404);
      if (!wk.pane) return c.json({ screen: "", controllable: false, error: "This worker is not running in Herdr, so its screen can't be read. Open its terminal." });
      const { readScreen, pickOption } = await import("./intents.ts");
      const screen = await readScreen(h.api(), wk.pane, wk.machine);
      return c.json({ screen, controllable: wk.controllable, options: { allow: pickOption(screen, "allow")?.label ?? null, allow_always: pickOption(screen, "allow_always")?.label ?? null, deny: pickOption(screen, "deny")?.label ?? null } });
    });
    // Browser terminal: the pane's visible screen with ANSI styling, as SSE frames (or one JSON frame).
    const paneOf = (id: string): { machine: string; pane: string; controllable: boolean } | { error: string; status: 404 | 409 } => {
      const wk = w.api().get(id);
      if (!wk) return { error: `Worker ${id} is not running.`, status: 404 };
      if (!wk.pane) return { error: "This agent runs outside Herdr, so there is no terminal to show here. Use Move to Herdr, or its own terminal.", status: 409 };
      return { machine: wk.machine, pane: wk.pane, controllable: wk.controllable };
    };
    app.get("/api/workers/:id/terminal/frame", async (c) => {
      const p = paneOf(c.req.param("id"));
      if ("error" in p) return c.json({ error: p.error }, p.status);
      try { return c.json(await term.read(p.machine, p.pane)); }
      catch (e: any) { return c.json({ error: `Can't read pane ${p.pane}: ${e?.message ?? e}` }, 502); }
    });
    app.get("/api/workers/:id/terminal", (c) => {
      const p = paneOf(c.req.param("id"));
      if ("error" in p) return c.json({ error: p.error }, p.status);
      return streamSSE(c, async (stream) => {
        const off = term.subscribe(p.machine, p.pane, (ev) => {
          // "pane-error", not "error": EventSource reserves "error" for its own connection failures.
          stream.writeSSE({ event: ev.type === "frame" ? "frame" : "pane-error", data: JSON.stringify(ev.type === "frame" ? ev.frame : { message: ev.message }) }).catch(() => {});
        });
        const ping = setInterval(() => stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {}), 15000);
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
        clearInterval(ping);
        off();
      });
    });
    // Typing from the browser terminal: {data} is xterm's onData output; {keys:[…]} sends Herdr key names.
    app.post("/api/workers/:id/input", async (c) => {
      const bad = fromLocalPage(c);
      if (bad) return c.json({ error: bad }, 403);
      let b: any;
      try { b = await c.req.json(); } catch { return c.json({ error: 'Send a JSON body like {"data": "ls\\r"} or {"keys": ["esc"]}.' }, 400); }
      const p = paneOf(c.req.param("id"));
      if ("error" in p) return c.json({ error: p.error }, p.status);
      if (!p.controllable) return c.json({ error: `Herdr is not connected, so Joyride can't type into pane ${p.pane}. It reconnects on its own; try again in a moment.` }, 409);
      let ops: InputOp[];
      if (Array.isArray(b?.keys)) {
        if (!b.keys.length || !b.keys.every(validKeyName)) return c.json({ error: "keys must be Herdr key names, for example esc, enter, ctrl+c or shift+tab." }, 400);
        ops = [{ keys: b.keys, raw: b.keys.map(() => "") }];
      } else if (typeof b?.data === "string" && b.data.length) {
        if (b.data.length > 20000) return c.json({ error: "That is more than 20,000 characters at once. Paste it in smaller parts." }, 413);
        ops = inputOps(b.data);
      } else return c.json({ error: 'Nothing to type: send {"data": "…"} or {"keys": ["…"]}.' }, 400);
      if (!ops.length) return c.json({ ok: true, sent: [] });
      steer.noteTerminalInput(c.req.param("id"));
      try { return c.json({ ok: true, sent: await term.send(p.machine, p.pane, ops) }); }
      catch (e: any) {
        const code = e?.code ? ` (${e.code})` : "";
        return c.json({ error: `Herdr didn't take the input${code}: ${e?.message ?? e}` }, 502);
      }
    });
    // Replies sent from the chat view that the agent hasn't taken yet (staged.ts).
    const staged = async (id: string) => {
      const worker = w.api().get(id);
      const replies = intents.list({ target: id, kind: "reply", limit: 200 });
      let transcript: TranscriptState | null = null;
      if (worker?.session) {
        try { transcript = (await ctx.services.get("sessions")?.transcriptState?.(worker.session, { limit: 400 })) ?? null; }
        catch (e: any) { ctx.log(`live: staged replies could not read ${worker.session}: ${e.message}`); }
      }
      const out = stagedReplies({ replies, worker, transcript });
      for (const cid of out.consumed) intents.consumed(cid);
      return { worker: id, session: worker?.session ?? null, agent: worker?.agent ?? null, staged: out.staged };
    };
    app.get("/api/workers/:id/staged", async (c) => c.json(await staged(c.req.param("id"))));
    // Acks queued replies when their transcript shows them taken, whether or not a chat view is open.
    let sweep: NodeJS.Timeout | null = null;
    ctx.bus.onChange((ch) => {
      if (ch.entity !== "sessions" || sweep) return;
      sweep = setTimeout(() => {
        sweep = null;
        const open = new Set(intents.list({ kind: "reply", status: "sent", limit: 200 }).filter((it) => (it.result as any)?.queued).map((it) => it.target));
        for (const id of open) staged(id).catch((e) => ctx.log(`live: staged sweep for ${id} failed: ${e.message}`));
      }, 500);
    });

    app.get("/api/workers/:id", (c) => {
      const found = w.api().snapshot().find((worker) => worker.id === c.req.param("id"));
      return found ? c.json(found) : c.json({ error: `Worker ${c.req.param("id")} is not running.` }, 404);
    });

    app.get("/api/intents", (c) => c.json(intents.list({
      target: c.req.query("target") || undefined, kind: c.req.query("kind") || undefined, status: c.req.query("status") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    })));
    app.get("/api/intents/:id", (c) => {
      const it = intents.get(c.req.param("id"));
      return it ? c.json(it) : c.json({ error: `No intent ${c.req.param("id")}.` }, 404);
    });
    app.post("/api/intents/:id/dismiss", (c) => {
      const it = intents.dismiss(c.req.param("id"));
      return it ? c.json(it) : c.json({ error: `No intent ${c.req.param("id")}.` }, 404);
    });
    app.post("/api/intents", async (c) => {
      let b: any;
      try { b = await c.req.json(); } catch { return c.json({ error: "Send a JSON body like {kind, target, payload}." }, 400); }
      if (!b?.kind) return c.json({ error: "An intent needs a kind, for example reply, approve or launch_session." }, 400);
      try { return c.json(await intents.create(String(b.kind), String(b.target ?? ""), b.payload ?? {}, b.origin ? { origin: String(b.origin) as any } : {})); }
      catch (e: any) {
        if (e instanceof IntentError) return c.json({ error: e.message }, 400);
        throw e;
      }
    });
  },
  start() {
    herdr?.start();
    workers?.start();
  },
  stop() {
    terminals?.stop();
    workers?.stop();
    herdr?.stop();
  },
});
