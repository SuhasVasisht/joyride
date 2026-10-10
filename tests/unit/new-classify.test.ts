import { describe, it, expect, vi } from "vitest";
import { classifyNew } from "../../src/modules/new/classify.ts";
import type { jev, JevResult } from "../../src/core/jev.ts";
import { newWorld, newContext } from "../fixtures/new-world.ts";
import { apiRequest } from "../../src/modules/new/execute.ts";

const judge = (route: string, confidence = 1): typeof jev => vi.fn(async (): Promise<JevResult> => ({ model: "test-jev", ms: 1, usage: {}, answers: { new_route: { type: "choice", choice: route, probabilities: { [route]: confidence } }, new_idea: { type: "choice", choice: "new", probabilities: { new: 1 } } } }));
describe("Jev routing boundary", () => {
  it("executes only a complete candidate and makes one Jev call", async () => {
    const j = judge("deterministic");
    expect((await classifyNew("Note: Friday release", newContext, newWorld, j)).candidate).toMatchObject({ route: "deterministic", actions: [{ args: { text: "Friday release", scope: "global" } }] });
    expect(j).toHaveBeenCalledTimes(1);
    expect((await classifyNew("Move unknown thing somewhere", newContext, newWorld, j)).candidate.route).toBe("agent");
  });
  it("low confidence never executes, even with a parsed candidate", async () => {
    expect((await classifyNew("Note: Friday release", newContext, newWorld, judge("deterministic", .79))).candidate.route).toBe("agent");
    expect((await classifyNew("Task: build the export", newContext, newWorld, judge("firstmate", .79))).candidate.route).toBe("agent");
  });
  it("preserves the full original task and explicit marker over the current idea", async () => {
    const text = "Task: implement exports\njoyride-mission: build-joyride\njoyride-request: captain-original";
    const result = await classifyNew(text, { ...newContext, place: { kind: "idea", id: "csv-export", title: "CSV export" } }, newWorld, judge("firstmate"));
    expect(result.candidate).toMatchObject({ route: "firstmate", brief: text, idea: "build-joyride" });
  });
  it("an invalid marker and Jev unavailability go to a visible agent job", async () => {
    expect((await classifyNew("Task: implement exports\njoyride-mission: gone", newContext, newWorld, judge("firstmate"))).candidate.route).toBe("agent");
    const offline: typeof jev = vi.fn(async () => { throw new Error("offline"); });
    expect(await classifyNew("Note: Friday release", newContext, newWorld, offline)).toMatchObject({ candidate: { route: "agent" }, classifier: "unavailable", confidence: null });
  });
  it("derives multiline titles without a naming model and refuses an empty task", async () => {
    const text = "Task:\nBuild the export renderer\njoyride-request: original";
    expect((await classifyNew(text, newContext, newWorld, judge("firstmate"))).candidate).toMatchObject({ route: "firstmate", brief: text, title: "Build the export renderer" });
    expect((await classifyNew("Task:\njoyride-mission: build-joyride", newContext, newWorld, judge("firstmate"))).candidate.route).toBe("agent");
  });
  it("the agent API cannot control lifecycle, terminal prompts or install/log in", () => {
    for (const path of ["/api/herdr/start", "/api/intents", "/api/new", "/api/guard/requests/x/decide", "/api/workers/local%3Aw1%3Ap1/input", "/api/system/install", "/api/system/setup/gh-login"]) expect(() => apiRequest({ kind: "api", method: "POST", path, body: {} }, true)).toThrow();
    expect(apiRequest({ kind: "api", method: "PUT", path: "/api/artifacts/art-one", body: { mission: "build-joyride", private: true } }, true)).toMatchObject({ path: "/api/artifacts/art-one" });
  });
});
