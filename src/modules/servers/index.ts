import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { defineModule } from "../../core/context.ts";
import { ServerAction } from "../../shared/servers.ts";
import { TerminalHub } from "../live/terminal.ts";
import type { HerdrApi } from "../live/herdr.ts";
import { ServersService } from "./service.ts";

let terminals: TerminalHub | null = null;
const safe = (fn: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
  try { return await fn(c); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
};
export default defineModule({
  name: "servers", order: 35,
  register(ctx) {
    const svc = new ServersService(ctx);
    const term = terminals = new TerminalHub(() => ctx.service<HerdrApi>("herdr"));
    ctx.services.set("servers", svc);
    ctx.app.use("/api/servers/*", async (c, next) => {
      if (c.req.method !== "GET") {
        if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "Send server controls as JSON." }, 403);
        const origin = c.req.header("origin");
        if (origin && origin !== "null") {
          try { if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) return c.json({ error: "Use the local Joyride page to control servers." }, 403); }
          catch { return c.json({ error: "Invalid request origin." }, 403); }
        }
      }
      try { await next(); }
      catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 409); }
    });
    ctx.app.get("/api/servers", async (c) => {
      try { return c.json(await svc.list(c.req.query("purpose"))); }
      catch (e) { return c.json({ error: `Cannot read server definitions: ${e instanceof Error ? e.message : String(e)}. Restore their YAML from git.` }, 409); }
    });
    ctx.app.post("/api/servers", safe(async (c) => c.json(await svc.save(await c.req.json(), true))));
    ctx.app.put("/api/servers/:id", safe(async (c) => {
      const raw = await c.req.json<unknown>();
      if (!raw || typeof raw !== "object" || !("id" in raw) || raw.id !== c.req.param("id")) return c.json({ error: "The definition id must match the route." }, 400);
      return c.json(await svc.save(raw, false));
    }));
    ctx.app.get("/api/servers/:id", safe(async (c) => {
      const g = (await svc.list()).find((g) => g.id === c.req.param("id"));
      return g ? c.json(g) : c.json({ error: "Server group does not exist." }, 404);
    }));
    ctx.app.post("/api/servers/:id/action", safe(async (c) => c.json(await svc.act(c.req.param("id") ?? "", ServerAction.parse(await c.req.json())))));
    ctx.app.get("/api/servers/:id/members/:member/logs", safe((c) => c.json(svc.logs(c.req.param("id") ?? "", c.req.param("member") ?? ""))));
    ctx.app.get("/api/servers/:id/members/:member/terminal/frame", safe(async (c) => {
      const p = await svc.terminal(c.req.param("id") ?? "", c.req.param("member") ?? "");
      return c.json(await term.read(p.machine, p.pane));
    }));
    ctx.app.get("/api/servers/:id/members/:member/terminal", safe(async (c) => {
      const p = await svc.terminal(c.req.param("id") ?? "", c.req.param("member") ?? "");
      return streamSSE(c, async (stream) => {
        const off = term.subscribe(p.machine, p.pane, (ev) => {
          void stream.writeSSE({ event: ev.type === "frame" ? "frame" : "pane-error", data: JSON.stringify(ev.type === "frame" ? ev.frame : { message: ev.message }) }).catch(() => {});
        });
        await new Promise<void>((resolve) => stream.onAbort(resolve));
        off();
      });
    }));
  },
  stop() { terminals?.stop(); terminals = null; },
});
