// READ-ONLY smoke against the user's real Herdr server and real ~/.claude/sessions.
// Opt-in: JOYRIDE_REAL_SMOKE=1 npx vitest run tests/unit/herdr-real.test.ts
// Uses only read methods (ping, session.snapshot, agent.list, pane.list,
// pane.process_info, events.subscribe), an in-memory index and a no-op event
// sink, so nothing is written anywhere. Prints counts only.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOCKET = path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const CLAUDE_SESSIONS = path.join(os.homedir(), ".claude", "sessions");
const enabled = process.env.JOYRIDE_REAL_SMOKE === "1";
const herdrUp = fs.existsSync(SOCKET);

describe.skipIf(!enabled)("real environment smoke (read-only)", () => {
  it.skipIf(!herdrUp)("reads the real Herdr server", async () => {
    const { herdrRequest, HerdrClient } = await import("../../src/modules/live/herdr-client.ts");
    const pong = await herdrRequest(SOCKET, "ping", {});
    const snap = (await herdrRequest(SOCKET, "session.snapshot", {})).snapshot;
    const agents = (await herdrRequest(SOCKET, "agent.list", {})).agents;
    const panes = (await herdrRequest(SOCKET, "pane.list", {})).panes;
    console.log(`[smoke] herdr ${pong.version} protocol ${pong.protocol}: workspaces=${snap.workspaces.length} tabs=${snap.tabs.length} panes=${panes.length} agents=${agents.length}`);
    expect(pong.type).toBe("pong");

    const c = new HerdrClient({ machine: "local", socket: SOCKET, pollMs: 60000 });
    const hydrated = new Promise<number>((r) => c.once("hydrated", (p: unknown[]) => r(p.length)));
    c.start();
    const n = await hydrated;
    await new Promise((r) => setTimeout(r, 800));
    console.log(`[smoke] client: connected=${c.connected()} cached panes=${n} agent panes=${[...c.panes.values()].filter((p) => p.agent).length} status subscription=${c.statusSubscribed()}`);
    expect(c.connected()).toBe(true);
    c.stop();
  });

  it("reads the real Claude Code process registry", async () => {
    const { readClaudeRegistry } = await import("../../src/modules/live/workers.ts");
    const files = fs.existsSync(CLAUDE_SESSIONS) ? fs.readdirSync(CLAUDE_SESSIONS) : [];
    const list = readClaudeRegistry(CLAUDE_SESSIONS);
    const statuses: Record<string, number> = {};
    for (const r of list.filter((x) => x.alive)) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    console.log(`[smoke] ~/.claude/sessions: json=${files.filter((f) => f.endsWith(".json")).length} key files ignored=${files.filter((f) => f.endsWith(".key")).length} parsed=${list.length} alive=${list.filter((r) => r.alive).length} by status=${JSON.stringify(statuses)}`);
    expect(list.length).toBeLessThanOrEqual(files.length);
  });

  it("projects real workers without writing anything", async () => {
    const { openDb } = await import("../../src/core/db.ts");
    const { Bus } = await import("../../src/core/bus.ts");
    const { HerdrService } = await import("../../src/modules/live/herdr.ts");
    const { WorkersProjection } = await import("../../src/modules/live/workers.ts");
    let emitted = 0;
    const ctx: any = {
      db: openDb(":memory:"), bus: new Bus(), config: { machines: [{ label: "local" }] }, app: null, services: new Map(),
      log: () => {}, emit: () => { emitted++; return {}; }, service: () => { throw new Error("none"); },
    };
    const herdr = new HerdrService(ctx);
    const workers = new WorkersProjection(ctx, herdr);
    herdr.start();
    if (herdrUp) await new Promise((r) => setTimeout(r, 1500));
    const list = workers.compute();
    const by = (k: (w: any) => string) => list.reduce((m: Record<string, number>, w) => ((m[k(w)] = (m[k(w)] ?? 0) + 1), m), {});
    console.log(`[smoke] workers=${list.length} by source=${JSON.stringify(by((w) => (w.pane ? "herdr" : w.pid ? "claude-registry" : "codex-hooks")))} by status=${JSON.stringify(by((w) => w.status))} controllable=${list.filter((w) => w.controllable).length} herdr events (not written)=${emitted}`);
    herdr.stop();
    expect(Array.isArray(list)).toBe(true);
  });
});
