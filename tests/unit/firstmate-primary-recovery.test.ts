import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrimaryPane } from "../../src/modules/firstmate/failover.ts";
import { sandboxDaemon } from "../sandbox.ts";
import { claudeLive, codexLive, report } from "../fixtures/quota.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function setup() {
  const d = await sandboxDaemon("primary-recovery", []);
  const { createPrimaryManager } = await import("../../src/modules/firstmate/primary.ts");
  const { resolveAccounts } = await import("../../src/core/accounts.ts");
  const { parseQuota } = await import("../../src/modules/usage/quota.ts");
  const { readHome } = await import("../../src/modules/firstmate/state.ts");
  const { paths } = await import("../../src/shared/paths.ts");
  expect(paths.runtime.startsWith(d.sb.dir)).toBe(true);
  const home = path.join(paths.runtime, "lab-primary-home");
  const journal = path.join(paths.runtime, "state/firstmate-primary.json");
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.rmSync(journal, { force: true });
  const accounts = resolveAccounts([{ provider: "claude" }, { provider: "codex" }]);
  d.ctx.services.set("usage", { accounts: () => accounts, report: () => {
    const now = Date.now();
    return { fetchedAt: new Date(now).toISOString(), generatedAt: new Date(now).toISOString(), maxAgeSeconds: 60,
      providers: parseQuota(report(now, [claudeLive(now), codexLive(now)]), accounts)!.providers };
  } });
  let pane: (PrimaryPane & { agent: string }) | null = { machine: "lab", pane_id: "old", status: "blocked", agent: "claude" };
  let failLaunch = false;
  let launches = 0;
  let transcriptText = "original context\n".repeat(5000);
  const filed: { id: string; body: string }[] = [];
  d.ctx.services.set("workers", { list: () => [{ id: "lab:old", session: "lab-transcript", owner: { task: null } }] });
  d.ctx.services.set("sessions", { get: () => ({ transcript: "/lab/original.jsonl" }),
    transcriptState: async () => ({ turns: [{ role: "user", ts: null, text: transcriptText, tools: [] }], queue: [], pulled: [] }) });
  d.ctx.services.set("herdr", { defaultMachine: () => "lab", refresh: async () => {}, sendKeys: async () => {}, snapshot: () => ({ machines: [], panes: pane ? [pane] : [] }),
    call: async (method: string) => { if (method === "pane.close") { pane = null; return {}; } return { read: { text: "You've hit your limit" } }; },
    launch: async () => { launches++; if (failLaunch) throw new Error("successor failed"); return { pane_id: "new", prompt_sent: true }; } });
  const deps = { home, dir: d.sb.dir, pane: () => pane, homeState: () => readHome(home, {}), launched: () => {},
    note: async (id: string, body: string) => { filed.push({ id, body }); if (filed.length === 1) throw new Error("inbox timed out"); return { note: "durable-note" }; } };
  return { d, journal, filed, manager: () => createPrimaryManager(d.ctx, deps), launches: () => launches,
    cursorSource: (id: string) => {
      pane = { machine: "lab", pane_id: "old", status: "working", agent: "cursor" };
      d.ctx.service("usage").accounts = () => resolveAccounts([{ provider: "claude" }, { provider: "codex" }, { provider: "cursor" }]);
      d.ctx.service("workers").list = () => [{ id: "lab:old", session: `other:${id}`, owner: { task: null } }];
      d.ctx.service("sessions").get = () => null;
      d.ctx.service("sessions").transcriptState = async () => null;
    },
    wrongSecondary: () => {
      pane = { machine: "lab", pane_id: "old", status: "working", agent: "codex" };
      d.ctx.service("usage").accounts = () => resolveAccounts([{ provider: "claude" }, { provider: "codex" }, { provider: "codex", home: path.join(d.sb.dir, "codex-2") }]);
      d.ctx.service("sessions").get = () => ({ transcript: path.join(paths.codexDir, "sessions/original.jsonl") });
    },
    changeTranscript: () => { transcriptText = "different transcript"; }, absent: () => { pane = null; }, failLaunch: () => { failLaunch = true; } };
}

describe("Persisted Firstmate handoff recovery", () => {
  it("preserves a failed-launch pane claimed by a worker and does not launch another primary over it", async () => {
    const s = await setup();
    const first = s.manager();
    try {
      await expect(first.switch("codex")).rejects.toThrow("inbox timed out");
      const h = s.d.ctx.service("herdr");
      const read = h.call;
      const closed: string[] = [];
      h.call = async (method: string, args: { pane_id?: string }) => { if (method === "pane.close") closed.push(args.pane_id!); return read(method, args); };
      let claimed = false, launches = 0;
      h.snapshot = () => ({ machines: [], panes: [{ machine: "lab", pane_id: "new" }] });
      h.launch = async () => { claimed = true; launches++; return { pane_id: "new", prompt_sent: false }; };
      s.d.ctx.service("workers").list = () => [{ id: "lab:old", session: "lab-transcript", owner: { task: null } }, ...(claimed ? [{ id: "lab:new", session: null, owner: { task: "preserved-worker" } }] : [])];
      await expect(first.switch("codex")).rejects.toThrow("now owned by a worker");
      expect(closed).not.toContain("new");
      expect(launches).toBe(1);
    } finally { first.stop(); await s.d.stop(); }
  });
  it("captures the native Cursor source conversation instead of relying only on its pane tail", async () => {
    const s = await setup();
    const id = "c9291951-00d2-45fc-b72f-a02c0d120673";
    s.cursorSource(id);
    const cursorHome = path.join(s.d.sb.dir, "cursor");
    vi.stubEnv("CURSOR_CONFIG_DIR", cursorHome);
    vi.stubEnv("JOYRIDE_FIRSTMATE_REAL", "1");
    const slug = s.d.sb.dir.replace(/[/\\]/g, "-").replace(/^-/, "");
    const transcript = path.join(cursorHome, "projects", slug, "agent-transcripts", id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    const ask = "CURSOR_PENDING_PROMISE_" + "Preserve this full source request.\n".repeat(5000);
    fs.writeFileSync(transcript, JSON.stringify({ role: "user", message: { content: [{ type: "text", text: ask }] } }) + "\n"
      + JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "I will preserve the pending decision." }] } }) + "\n");
    const first = s.manager();
    try {
      await expect(first.switch("codex")).rejects.toThrow("inbox timed out");
      const context = JSON.parse(fs.readFileSync(path.join(path.dirname(s.journal), `primary-handoff-${first.status().lastSwitch?.id}.json`), "utf8"));
      expect(context.transcript?.turns[0].text === ask.trim()).toBe(true);
      expect(context.transcriptPath).toBe(transcript);
    } finally { first.stop(); await s.d.stop(); }
  });
  it("preserves the source when its bound transcript capture is interrupted", async () => {
    const s = await setup();
    s.d.ctx.service("sessions").transcriptState = async () => { throw new Error("read interrupted"); };
    const first = s.manager();
    try {
      await expect(first.switch("codex")).rejects.toThrow("source conversation could not be read");
      expect(s.filed).toHaveLength(0);
      expect(first.status()).toMatchObject({ phase: "failed", current: { account: "claude-code" } });
      expect(s.launches()).toBe(0);
    } finally { first.stop(); await s.d.stop(); }
  });
  it("keeps full context on disk and replays the identical bounded body after restart", async () => {
    const s = await setup();
    const first = s.manager();
    try {
      await expect(first.switch("codex")).rejects.toThrow("timed out");
      const id = first.status().lastSwitch?.id;
      expect(id).toBeTruthy();
      const contextFile = path.join(path.dirname(s.journal), `primary-handoff-${id}.json`);
      expect(fs.statSync(contextFile).size).toBeGreaterThan(50 * 1024);
      expect(s.filed[0].body).toContain(contextFile);
      expect(s.filed[0].body).toContain("/lab/original.jsonl");
      expect(Buffer.byteLength(s.filed[0].body)).toBeLessThanOrEqual(12 * 1024);
      s.changeTranscript();
      first.stop();
      const next = s.manager();
      await next.switch("codex");
      expect(s.filed).toEqual([s.filed[0], s.filed[0]]);
      expect(next.status()).toMatchObject({ phase: "ready", lastSwitch: { id, note: "durable-note", attempts: 2 } });
      expect(s.launches()).toBe(1);
      next.stop();
    } finally { first.stop(); await s.d.stop(); }
  });

  it("backs off failed successor launches across restarts and pauses after three attempts", async () => {
    const s = await setup();
    s.absent(); s.failLaunch();
    fs.writeFileSync(s.journal, JSON.stringify({ current: null, phase: "failed", error: "launch failed",
      lastSwitch: { id: "launch-recovery", from: "claude-code", to: "codex", reason: "limit", at: new Date().toISOString(), note: "saved-note", attempts: 1, retryAt: 0 } }));
    const first = s.manager();
    try {
      await expect(first.check()).rejects.toThrow("successor failed");
      const retryAt = first.status().lastSwitch?.retryAt ?? 0;
      expect(first.status().lastSwitch?.attempts).toBe(2);
      first.stop();
      const next = s.manager();
      await next.check();
      expect(s.launches()).toBe(1);
      vi.spyOn(Date, "now").mockReturnValue(retryAt + 1);
      await expect(next.check()).rejects.toThrow("successor failed");
      expect(next.status().error).toContain("Automatic handoff paused after 3 attempts");
      next.stop();
      const paused = s.manager();
      await paused.check();
      expect(s.launches()).toBe(2);
      expect(paused.status().lastSwitch?.id).toBe("launch-recovery");
      paused.stop();
    } finally { first.stop(); await s.d.stop(); }
  });
  it("does not promote a failed target from a stale completion marker belonging to the source", async () => {
    const s = await setup();
    const home = path.join(path.dirname(path.dirname(s.journal)), "lab-primary-home");
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    fs.writeFileSync(path.join(home, "state/.lock"), String(process.pid));
    fs.writeFileSync(path.join(home, "state/.session-start-complete"), String(process.pid));
    fs.writeFileSync(s.journal, JSON.stringify({ current: { account: "codex", label: "Codex", harness: "codex", model: "gpt-6.1-sol" }, phase: "failed", error: "target did not start",
      lastSwitch: { id: "wrong-marker", from: "claude-code", to: "codex", reason: "manual", at: new Date().toISOString(), note: "saved-note", attempts: 3, retryAt: null } }));
    const manager = s.manager();
    try {
      await manager.check();
      expect(manager.status().phase).toBe("failed");
      expect(manager.status().error).toContain("target did not start");
      expect(s.launches()).toBe(0);
    } finally { manager.stop(); await s.d.stop(); }
  });
  it("does not call a default Codex conversation the saved Codex 2 successor", async () => {
    const s = await setup(); s.wrongSecondary();
    const home = path.join(path.dirname(path.dirname(s.journal)), "lab-primary-home");
    fs.mkdirSync(path.join(home, "state"), { recursive: true });
    const at = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(home + "/state/.lock", String(process.pid));
    fs.writeFileSync(home + "/state/.session-start-complete", String(process.pid));
    fs.writeFileSync(s.journal, JSON.stringify({ current: { account: "codex-2", label: "Codex 2", harness: "codex", model: "gpt-6.1-sol" }, phase: "failed", error: "wrong saved account",
      lastSwitch: { id: "wrong-account", from: "codex", to: "codex-2", reason: "manual", at, note: "saved-note", attempts: 3, retryAt: null } }));
    const manager = s.manager();
    try {
      await manager.check();
      expect(manager.status().phase).toBe("failed");
      expect(manager.status().current?.account).toBe("codex");
      expect(s.launches()).toBe(0);
    } finally { manager.stop(); await s.d.stop(); }
  });

});
