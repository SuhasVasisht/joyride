import { afterEach, expect, it, vi } from "vitest";
import { fakeHerdrControl, startFakeHerdr, type FakeHerdr } from "../fixtures/fake-herdr.ts";

let fake: FakeHerdr | undefined;
afterEach(async () => { await fake?.stop(); vi.useRealTimers(); });

it("does not apply an answered pane's delayed status to a replacement pane", async () => {
  const socket = process.env.JOYRIDE_HERDR_SOCKET;
  if (!socket) throw new Error("The test sandbox must provide JOYRIDE_HERDR_SOCKET.");
  fake = await startFakeHerdr(socket);
  vi.useFakeTimers();
  await fakeHerdrControl(socket, "pane.send_keys", { pane_id: "w1:p2", keys: ["1"] });
  fake.closePane("w1:p2");
  const replacement = fake.addPane({ workspace_id: "w1", pane_id: "w1:p2", agent: "claude", agent_status: "working" });
  await vi.advanceTimersByTimeAsync(300);
  expect(replacement.agent_status).toBe("working");
});
