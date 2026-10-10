import { expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor } from "../fixtures/fake-herdr.ts";
import { allLiveStdout } from "../fixtures/quota.ts";
import type { HerdrApi } from "../../src/modules/live/herdr.ts";

it("removes its failed target when the native process disappears before the first prompt", async () => {
  const d = await sandboxDaemon("primary-disappeared-target", ["usage", "live", "firstmate"]);
  const fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
  try {
    await d.start();
    const h = d.ctx.service<HerdrApi>("herdr");
    await waitFor(() => h.connected(), 5000);
    await d.req("POST", "/api/usage/test-fake", { result: { kind: "ok", stdout: allLiveStdout(Date.now()) } });
    await d.req("POST", "/api/firstmate/start");
    const get = async () => (await d.req("GET", "/api/firstmate/status")).body;
    await waitFor(async () => (await get()).running && (await get()).primary.choices.find((p: { account: string }) => p.account === "codex")?.available, 5000);
    const before = await get();
    const peer = fake.addPane({ cwd: d.sb.dir, agent: "codex", agent_status: "working", label: "preserved peer" });
    const launch = h.launch;
    let disappear = true;
    h.launch = async options => {
      const result = await launch(options);
      if (disappear && options.env?.FM_PRIMARY_ACCOUNT === "codex") {
        disappear = false;
        fake.panes.get(result.pane_id)!.agent = null;
        await h.refresh();
        return { ...result, prompt_sent: false, warning: "Target process exited before its first prompt." };
      }
      return result;
    };
    const switched = await d.req("POST", "/api/firstmate/switch", { account: "codex" });
    expect(switched.body.error).toContain("source was restored");
    const after = await get();
    expect(after.running).toBe(true);
    expect(after.primary.current.account).toBe(before.primary.current.account);
    expect(fake.panes.has(peer.pane_id)).toBe(true);
    expect([...fake.panes.values()].filter(p => p.cwd === before.vendor.path)).toHaveLength(1);
  } finally { await d.stop(); await fake.stop(); }
});
