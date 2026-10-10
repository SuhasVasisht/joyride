import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor } from "../fixtures/fake-herdr.ts";
import { allLiveStdout } from "../fixtures/quota.ts";

it("returns a truthful failure and restores the source without leaving a duplicate target", async () => {
  const d = await sandboxDaemon("primary-startup-failure", ["usage", "live", "firstmate"]);
  const fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  try {
    await d.start();
    await waitFor(() => d.ctx.service("herdr").connected(), 5000);
    await d.req("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: allLiveStdout(Date.now()) } });
    const get = async () => (await d.req("GET", "/api/firstmate/status")).body;
    await d.req("POST", "/api/firstmate/start");
    await waitFor(async () => (await get()).running && (await get()).primary.choices.find((p: { account: string }) => p.account === "codex")?.available, 5000);
    const before = await get();
    const peer = fake.addPane({ cwd: d.sb.dir, agent: "codex", agent_status: "working", label: "preserved peer" });
    const work = path.join(d.sb.dir, "unlanded.txt");
    fs.writeFileSync(work, "unlanded source promise\n");
    fake.failNext("agent.start", "agent_spawn_failed", "missing target credentials");
    const switched = await d.req("POST", "/api/firstmate/switch", { account: "codex" });
    expect(switched.body.status).toBe("failed");
    expect(switched.body.error).toContain("missing target credentials");
    expect(switched.body.error).toContain("source was restored");
    const after = await get();
    expect(after.running).toBe(true);
    expect(after.primary.current.account).toBe(before.primary.current.account);
    expect(after.primary.lastSwitch.note).toBeTruthy();
    expect(after.pane.pane_id).not.toBe(before.pane.pane_id);
    expect(fake.panes.has(peer.pane_id)).toBe(true);
    expect(fs.readFileSync(work, "utf8")).toBe("unlanded source promise\n");
    const control = [...fake.panes.values()].filter((p) => p.cwd === before.vendor.path);
    expect(control).toHaveLength(1);
    expect(control[0].agent).toBe(before.primary.current.harness);
  } finally { await d.stop(); await fake.stop(); }
});
