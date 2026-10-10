// The fleet feed: ordered events, and delivery keyed by the process-event host's request id (a retry
// before capture repeats the batch; a new request id means the last batch was captured).
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { FEED_SQL, FleetFeed, eventLine, feedText, type FeedInput } from "../../src/modules/fleet/feed";
import { classify, bounded, daemonUrl, consumerOf } from "./fleet-feed-package";

function kvStale(db: any, id: string) {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(`fleet:consumer:${id}`) as { v: string };
  const c = JSON.parse(row.v);
  c.last_poll = new Date(Date.now() - 2 * 24 * 3600e3).toISOString();
  db.prepare("UPDATE kv SET v = ? WHERE k = ?").run(JSON.stringify(c), `fleet:consumer:${id}`);
  // Everything up to now is older than half an hour from the feed's point of view.
  db.prepare("UPDATE fleet_events SET ts = ?").run(new Date(Date.now() - 3600e3).toISOString());
}

function feed() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
  db.exec(FEED_SQL);
  return new FleetFeed(db as any);
}
const ev = (o: Partial<FeedInput> = {}): FeedInput => ({ type: "member.state", worker: "local:w1:p1", session: "claude:s1", tier: "watched", task: null, title: "Export fix", cwd: "/repo/alpha", data: { state: "blocked", why: "Waiting for permission: Bash: npm publish" }, ...o });

describe("fleet feed delivery", () => {
  it("replays a batch for the same request id and moves on with the next one", async () => {
    const f = feed();
    f.append(ev()); f.append(ev({ type: "helm.captain", data: { via: "direct" } }));
    const a = await f.poll("joyride-fleet", "r1", 0);
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect((await f.poll("joyride-fleet", "r1", 0)).map((e) => e.seq)).toEqual([1, 2]); // retry before capture
    f.append(ev({ worker: "local:w2:p1" }));
    expect((await f.poll("joyride-fleet", "r2", 0)).map((e) => e.seq)).toEqual([3]); // r1's batch was captured
    expect(f.consumer("joyride-fleet")).toMatchObject({ cursor: 2, request: "r2", batch: [3] });
    expect(f.consumers()).toEqual([expect.objectContaining({ id: "joyride-fleet", pending: 1 })]);
  });

  it("never replays an empty batch: a poll that found nothing waits again, and an append wakes it", async () => {
    const f = feed();
    expect(await f.poll("c", "r1", 0)).toEqual([]);
    const waiting = f.poll("c", "r1", 5000);
    setTimeout(() => f.append(ev()), 50);
    const t0 = Date.now();
    expect((await waiting).map((e) => e.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Two consumers each get every event.
    expect((await f.poll("other", "x1", 0)).map((e) => e.seq)).toEqual([1]);
  });

  it("starts a new consumer at the last half hour, and keeps 30 days of events", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);");
    db.exec(FEED_SQL);
    const f = new FleetFeed(db as any);
    f.append(ev()); f.append(ev());
    db.prepare("UPDATE fleet_events SET ts = ? WHERE seq = 1").run(new Date(Date.now() - 40 * 24 * 3600e3).toISOString());
    db.prepare("UPDATE fleet_events SET ts = ? WHERE seq = 2").run(new Date(Date.now() - 2 * 3600e3).toISOString());
    f.append(ev({ worker: "local:w9:p1" }));
    expect((await f.poll("late", "r1", 0)).map((e) => e.seq)).toEqual([3]);
    expect(f.prune()).toBe(1);
    expect(f.after(0).map((e) => e.seq)).toEqual([2, 3]);
    // A consumer silent for more than a day (Firstmate away, the feed reinstalled) also starts from now.
    kvStale(db, "late");
    f.append(ev({ worker: "local:w8:p1" }));
    expect((await f.poll("late", "r9", 0)).map((e) => e.seq)).toEqual([4]);
  });

  it("returns empty after the wait when nothing happens", async () => {
    const f = feed();
    const t0 = Date.now();
    expect(await f.poll("c", "r1", 150)).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe("feed text", () => {
  it("starts with a machine line and says what each event means for Firstmate", () => {
    const f = feed();
    const evs = [f.append(ev()), f.append(ev({ type: "helm.captain", tier: "crew", task: "jr-x", data: { via: "direct", since: new Date().toISOString() } })), f.append(ev({ type: "helm.firstmate", data: { via: "hand_back" } }))];
    const text = feedText(evs, { doc: "/j/docs/fleet-operator.md", bin: "/j/bin/joyride" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("joyride-fleet-feed/1 seq=1-3 kinds=member.blocked,helm.captain,helm.firstmate");
    expect(text).toContain('local:w1:p1 "Export fix" (watched, /repo/alpha): blocked: Waiting for permission: Bash: npm publish.');
    expect(text).toContain("joyride steer local:w1:p1 --answer");
    expect(text).toContain("(crew jr-x, /repo/alpha): the captain took the helm (a direct steer in its pane");
    expect(text).toContain("fm-send included");
    expect(text).toContain("the helm is back with you (the captain handed it back)");
    expect(lines.at(-1)).toContain("/j/bin/joyride");
    expect(feedText([], { doc: "d", bin: "b" })).toBe("");
    expect(eventLine({ ...evs[0], data: { state: "done", why: "Tests pass" } })).toContain("done (inferred): Tests pass.");
  });

  it("is classified by the package from its first line", () => {
    expect(classify("joyride-fleet-feed/1 seq=1 kinds=member.blocked\n...")).toBe("fleet-needs-attention");
    expect(classify("joyride-fleet-feed/1 seq=1 kinds=helm.captain,member.done")).toBe("fleet-helm");
    expect(classify("joyride-fleet-feed/1 seq=4 kinds=member.done")).toBe("fleet-update");
    expect(classify("garbage")).toBe("fleet-update");
  });

  it("the package accepts only a loopback http URL and keeps output under the host's bound", () => {
    expect(daemonUrl("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    expect(daemonUrl("http://localhost:4405/x")).toBe("http://localhost:4405");
    expect(daemonUrl("https://127.0.0.1:4317")).toBeNull();
    expect(daemonUrl("http://example.com")).toBeNull();
    expect(daemonUrl("file:/etc/passwd")).toBeNull();
    expect(consumerOf("http://127.0.0.1:4317/?consumer=home-1a2b3c4d5e6f", "joyride-fleet")).toBe("home-1a2b3c4d5e6f");
    expect(consumerOf("http://127.0.0.1:4317", "joyride-fleet")).toBe("joyride-fleet");
    expect(consumerOf("http://127.0.0.1:4317/?consumer=bad id", "joyride-fleet")).toBe("joyride-fleet");
    const long = ["head", ...Array.from({ length: 400 }, (_, i) => `- line ${i} ${"é".repeat(100)}`)].join("\n");
    const out = bounded(long);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(30000);
    expect(out.endsWith("(more events: run joyride fleet events)")).toBe(true);
  });
});
