import { afterAll, beforeAll, expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;

beforeAll(async () => {
  d = await sandboxDaemon("events", ["sessions", "missions"]);
  const { paths } = await import("../../src/shared/paths.ts");
  expect(paths.runtime.startsWith(d.sb.dir)).toBe(true);
  await d.req("POST", "/api/missions", { id: "empty-events", title: "An empty idea" });
  await d.req("POST", "/api/missions", { id: "linked-events", title: "A linked idea", sessions: ["claude:linked-session"] });
  for (const session of ["linked-session", "unrelated-session"]) {
    d.ctx.emit({ source: "hook.claude", type: "prompt.submit", session, agent: "claude", data: { prompt: session } });
  }
  d.tailer.drain();
});

afterAll(async () => { await d?.stop(); });

it("returns no other sessions' events for an empty or missing idea", async () => {
  expect((await d.req("GET", "/api/events?type=prompt.submit")).body).toHaveLength(2);
  expect((await d.req("GET", "/api/events?mission=empty-events&type=prompt.submit")).body).toEqual([]);
  expect((await d.req("GET", "/api/events?mission=missing-events&type=prompt.submit")).body).toEqual([]);
});

it("returns only a linked idea's sessions, including when the caller supplies a session key", async () => {
  const linked = (await d.req("GET", "/api/events?mission=linked-events&type=prompt.submit")).body;
  expect(linked).toHaveLength(1);
  expect(linked[0]).toMatchObject({ session: "linked-session", data: { prompt: "linked-session" } });
  expect((await d.req("GET", "/api/events?session=claude:linked-session&type=prompt.submit")).body).toEqual(linked);
});
