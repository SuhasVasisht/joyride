import { describe, it, expect, beforeAll } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
beforeAll(async () => { d = await sandboxDaemon("csrf", ["guard"]); });

const post = (headers: Record<string, string>, body = "{}") => d.app.request("/api/guard/requests/x/timeout", { method: "POST", headers, body });

describe("cross-site protection", () => {
  it("refuses a POST from another website", async () => {
    expect((await post({ origin: "https://evil.example", "content-type": "application/json" })).status).toBe(403);
  });
  it("refuses simple (non-JSON) bodies that skip the CORS preflight", async () => {
    expect((await post({ "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ "content-type": "application/x-www-form-urlencoded" }, "a=1")).status).toBe(415);
  });
  it("refuses cross-site fetch metadata", async () => {
    expect((await post({ "sec-fetch-site": "cross-site", "content-type": "application/json" })).status).toBe(403);
  });
  it("allows Joyride's own pages, hooks and the CLI", async () => {
    expect((await post({ origin: "http://127.0.0.1:4317", "content-type": "application/json" })).status).not.toBe(403);
    expect((await post({ "content-type": "application/json" })).status).not.toBe(403);
    expect((await d.app.request("/api/health")).status).toBe(200);
  });
});
