import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeNeedsYou } from "../../src/ui/lib/native";
import type { Ask } from "../../src/shared/asks";

const ask = (patch: Partial<Ask>): Ask => ({
  id: "attention:ask", title: "Choose an approach", level: "L3", kind: "prompt", source: "attention",
  question: "Choose an approach", preamble: "", calls: [], options_source: "none", recommended_answer: null,
  needs_you: true, owner: "captain", state: "Waiting", task: null, worker: null, session: null, mission: null,
  place: { on: "hub", id: null }, answer: { via: "none", target: null }, opened: null, read_only: null, ref: {}, ...patch,
});
afterEach(() => vi.unstubAllGlobals());
describe("native shell bridge", () => {
  it("works without a native host in the browser", () => {
    vi.stubGlobal("window", {});
    expect(() => nativeNeedsYou([ask({})])).not.toThrow();
  });
  it("sends actionable ids, levels and encoded routes to the host", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("window", { joyrideNative: { postMessage } });
    nativeNeedsYou([ask({ worker: "local:w2:p1" }), ask({ id: "hold:task", task: "task/a", worker: "ignored" }), ask({ id: "hub" })]);
    expect(postMessage).toHaveBeenCalledWith({ kind: "needs-you", items: [
      { id: "attention:ask", title: "Choose an approach", route: "/worker/local%3Aw2%3Ap1", level: "L3" },
      { id: "hold:task", title: "Choose an approach", route: "/task/task%2Fa", level: "L3" },
      { id: "hub", title: "Choose an approach", route: "/agents?show=needs-you", level: "L3" },
    ] });
    nativeNeedsYou([]);
    expect(postMessage).toHaveBeenLastCalledWith({ kind: "needs-you", items: [] });
  });
});
