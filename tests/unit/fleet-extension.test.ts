// The joyride-fleet-feed extension against Firstmate's real extension host (vendor/firstmate, read-only):
// Joyride's installer binds it into a throwaway Firstmate home the documented way (fm-extension.sh bind
// runs the handshake), registers the source, and Firstmate's own runner polls the sandbox daemon over
// HTTP. A fleet event then lands in the home's process-event inbox with a `check` wake, classified by
// the package; the next poll gets only what is new; uninstall retires the source and the binding.
// Skipped explicitly when neither this worktree nor the main checkout has Firstmate.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { serve } from "@hono/node-server";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";

import { paths } from "../../src/shared/paths.ts";

const FM_DIR = paths.firstmateDir;
const hasFirstmate = fs.existsSync(path.join(FM_DIR, "bin", "fm-extension.sh")) && fs.existsSync(path.join(FM_DIR, "bin", "fm-procevent.sh"));

process.env.JOYRIDE_HERDR_POLL_MS = "300";
process.env.JOYRIDE_FLEET_JOIN_BATCH_MS = "60000";

describe.skipIf(!hasFirstmate)(`joyride-fleet-feed with Firstmate's extension host${hasFirstmate ? "" : " (skipped: needs vendor/firstmate)"}`, () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let fake: FakeHerdr;
  let server: ReturnType<typeof serve>;
  let url = "";
  // Firstmate refuses a package inside a Git project or behind a symlinked path: a canonical temp root.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jr-fleet-ext-")));
  const home = path.join(root, "home"), claims = path.join(root, "claims"), packages = path.join(root, "packages");
  const env = { ...process.env, FM_HOME: home, FM_PROCEVENT_CLAIM_ROOT: claims, FM_PROCEVENT_OWNER_CHECK_SECONDS: "1", FM_PROCEVENT_LAUNCH_CONFIRM_SECONDS: "1", JOYRIDE_GUARD: "off" };
  const fm = (script: string, args: string[], timeout = 90_000) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile(path.join(FM_DIR, "bin", script), args, { env, timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ code: err ? Number((err as any).code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });

  beforeAll(async () => {
    fs.mkdirSync(home);
    d = await sandboxDaemon("fleet-ext", ["live", "fleet"]);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "empty", promptFlipMs: 60_000 });
    await assertSandboxed(d.sb.env);
    await d.start();
    await new Promise<void>((resolve) => { server = serve({ fetch: d.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { url = `http://127.0.0.1:${info.port}`; resolve(); }); });
  });
  afterAll(async () => {
    await fm("fm-procevent.sh", ["sweep-home"], 30_000);
    await new Promise<void>((r) => server?.close(() => r()));
    await d?.stop(); await fake?.stop();
    // Firstmate's store copy is read-only; make it writable to remove it.
    try { execFileSync("chmod", ["-R", "u+w", root]); fs.rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it("binds through the installer, polls the daemon, and lands each fleet event in Firstmate's inbox", async () => {
    const { installFleetFeed, uninstallFleetFeed } = await import("../../src/cli/fleet-feed.ts");
    const r = installFleetFeed({ home, firstmateDir: FM_DIR, daemonUrl: url, packagesDir: packages, env: { FM_PROCEVENT_CLAIM_ROOT: claims } });
    expect(r.lines.join("\n")).toMatch(/handshake process-event-adapter\/1 \(joyride-fleet-feed\)/);
    expect(r.lines.join("\n")).toMatch(/registered source joyride-fleet polling http:\/\/127\.0\.0\.1:\d+\/api\/fleet\/feed as consumer home-[0-9a-f]{12}/);
    expect(r.record.config_ref).toMatch(/\/\?consumer=home-[0-9a-f]{12}$/);
    expect(r.record).toMatchObject({ home, source_id: "joyride-fleet", binding_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), owner_token: expect.stringMatching(/^sha256:/) });
    expect(fs.statSync(path.join(home, "config", "extensions.d")).mode & 0o777).toBe(0o700);
    expect((await fm("fm-extension.sh", ["verify", "dev.joyride.fleet-feed"])).code).toBe(0);
    // A second install keeps what is there.
    expect(installFleetFeed({ home, firstmateDir: FM_DIR, daemonUrl: url, packagesDir: packages, env: { FM_PROCEVENT_CLAIM_ROOT: claims } }).lines.join("\n")).toMatch(/kept binding[\s\S]*kept source/);

    // A watched session waits at a prompt: the fleet reports it.
    const pane = fake.addPane({ workspace_id: "wx1", cwd: "/tmp", agent: "claude", agent_status: "blocked", title: "Publish the docs" });
    const worker = `local:${pane.pane_id}`;
    await waitFor(async () => ((await d.req("GET", "/api/fleet/events?after=0")).body.events as any[]).some((e) => e.worker === worker && e.data.state === "blocked"), 8000);

    const first = await fm("fm-procevent.sh", ["start", "joyride-fleet"]);
    expect(first.out).not.toMatch(/no-result/);
    const inbox = path.join(home, "state", "procevent-inbox");
    const result1 = path.join(inbox, "joyride-fleet.1.result");
    await waitFor(() => fs.existsSync(result1), 10_000);
    const text1 = fs.readFileSync(result1, "utf8");
    expect(text1.split("\n")[0]).toMatch(/^joyride-fleet-feed\/1 seq=\d+ kinds=member\.blocked$/);
    expect(text1).toContain(`${worker} "Publish the docs" (watched, /tmp): blocked:`);
    const wakes = fs.readFileSync(path.join(home, "state", ".wake-queue"), "utf8");
    expect(wakes).toContain("procevent joyride-fleet-feed joyride-fleet 1");
    expect((await fm("fm-procevent.sh", ["classify", result1])).out).toContain("fleet-needs-attention");

    // The captain steers it: the next poll carries only the helm change, never the blocked event again.
    d.ctx.emit({ source: "hook.claude", type: "prompt.submit", session: "dddddddd-0000-4000-8000-000000000001", agent: "claude", cwd: "/tmp", pane: pane.pane_id, data: { prompt: "I'll take this one" } } as any);
    await waitFor(async () => ((await d.req("GET", "/api/fleet/events?after=0")).body.events as any[]).some((e) => e.worker === worker && e.type === "helm.captain"), 8000);
    await fm("fm-procevent.sh", ["start", "joyride-fleet"]);
    const result2 = path.join(inbox, "joyride-fleet.2.result");
    await waitFor(() => fs.existsSync(result2), 10_000);
    const text2 = fs.readFileSync(result2, "utf8");
    expect(text2.split("\n")[0]).toMatch(/kinds=helm\.captain$/);
    expect(text2).not.toContain("blocked:");
    expect((await fm("fm-procevent.sh", ["classify", result2])).out).toContain("fleet-helm");

    // Uninstall refuses, changing nothing, while Firstmate has results to handle; handled results free the binding.
    expect(() => uninstallFleetFeed({ firstmateDir: FM_DIR, env: { FM_PROCEVENT_CLAIM_ROOT: claims } })).toThrow(/has not handled 2 fleet feed results/);
    expect(fs.existsSync(path.join(home, "state", "procevent", "joyride-fleet.source"))).toBe(true);
    for (const seq of ["1", "2"]) expect((await fm("fm-procevent.sh", ["handled", "joyride-fleet", seq])).code).toBe(0);
    const lines = uninstallFleetFeed({ firstmateDir: FM_DIR, env: { FM_PROCEVENT_CLAIM_ROOT: claims } });
    expect(lines.join("\n")).toMatch(/retired source joyride-fleet[\s\S]*retired binding dev\.joyride\.fleet-feed/);
    expect(fs.existsSync(path.join(home, "config", "extensions.d", "dev.joyride.fleet-feed.json"))).toBe(false);
  }, 180_000);
});
