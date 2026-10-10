// Browser terminal: xterm input -> Herdr key names, the screen stream (ANSI
// frames via SSE and JSON), typing that reaches the pane in order, and the
// guards on who may type.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inputOps, validKeyName } from "../../src/modules/live/terminal-input.ts";
import { sandboxDaemon } from "../sandbox.ts";
import { startFakeHerdr, waitFor, assertSandboxed, type FakeHerdr } from "../fixtures/fake-herdr.ts";

describe("terminal input mapping", () => {
  it("maps typing and Enter to text plus Herdr's enter key", () => {
    expect(inputOps("hello")).toEqual([{ text: "hello" }]);
    expect(inputOps("ls -la\r")).toEqual([{ text: "ls -la" }, { keys: ["enter"], raw: ["\r"] }]);
    expect(inputOps("é ✓ 日本")).toEqual([{ text: "é ✓ 日本" }]);
  });

  it("maps control keys to their names", () => {
    const keys = (d: string) => inputOps(d).flatMap((o) => ("keys" in o ? o.keys : [`text:${o.text}`]));
    expect(keys("\x7f")).toEqual(["backspace"]);
    expect(keys("\b")).toEqual(["backspace"]);
    expect(keys("\x1b")).toEqual(["esc"]);
    expect(keys("\t")).toEqual(["tab"]);
    expect(keys("\x1b[Z")).toEqual(["shift+tab"]);
    expect(keys("\x03")).toEqual(["ctrl+c"]);
    expect(keys("\x04\x12\x0c")).toEqual(["ctrl+d", "ctrl+r", "ctrl+l"]);
    expect(keys("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual(["up", "down", "right", "left"]);
    expect(keys("\x1bOA\x1bOD")).toEqual(["up", "left"]); // application cursor mode
    expect(keys("\x1b[1;5D\x1b[1;2A\x1b[1;3C")).toEqual(["ctrl+left", "shift+up", "alt+right"]);
    expect(keys("\x1bb\x1b\x7f\x1b\r")).toEqual(["alt+b", "alt+backspace", "alt+enter"]);
    expect(keys("\x1bOP\x1b[15~")).toEqual(["f1", "f5"]);
    expect(keys("\x00\x1c\x1f")).toEqual(["ctrl+space", "ctrl+backslash", "ctrl+_"]);
  });

  it("keeps order and merges runs: type, fix a typo, submit", () => {
    expect(inputOps("helo\x7f\x7flo\r")).toEqual([
      { text: "helo" }, { keys: ["backspace", "backspace"], raw: ["\x7f", "\x7f"] }, { text: "lo" }, { keys: ["enter"], raw: ["\r"] },
    ]);
  });

  it("sends keys Herdr has no name for as the terminal's own bytes", () => {
    expect(inputOps("\x1b[3~")).toEqual([{ text: "\x1b[3~" }]); // Delete
    expect(inputOps("\x1b[H\x1b[F")).toEqual([{ text: "\x1b[H\x1b[F" }]); // Home, End
    expect(inputOps("\x1b[5~")).toEqual([{ text: "\x1b[5~" }]); // PageUp
  });

  it("passes a bracketed paste through whole, newlines and all, and drops focus reports", () => {
    const paste = "\x1b[200~line one\rline two\x1b[201~";
    expect(inputOps(paste)).toEqual([{ text: paste }]);
    expect(inputOps("\x1b[Ia\x1b[O")).toEqual([{ text: "a" }]);
  });

  it("validates explicit key names loosely", () => {
    for (const k of ["esc", "enter", "ctrl+c", "shift+tab", "up", "f5", "1", "y"]) expect(validKeyName(k)).toBe(true);
    for (const k of ["", "rm -rf /", "a".repeat(40), 3, null]) expect(validKeyName(k)).toBe(false);
  });
});

process.env.JOYRIDE_HERDR_POLL_MS = "400";
process.env.JOYRIDE_HERDR_RETRY_MAX_MS = "300";
process.env.JOYRIDE_TERMINAL_POLL_MS = "100";

describe("terminal stream and input against Herdr", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  let fake: FakeHerdr;
  const W = "local:w1:p1";
  const enc = encodeURIComponent;

  beforeAll(async () => {
    d = await sandboxDaemon("terminal", ["live"]);
    await assertSandboxed(d.sb.env);
    fake = await startFakeHerdr(d.sb.env.JOYRIDE_HERDR_SOCKET, { scenario: "default" });
    await d.start();
    await waitFor(async () => (await d.req("GET", "/api/workers")).body.some((w: any) => w.id === W && w.controllable), 5000);
  });
  afterAll(async () => { await d?.stop(); await fake?.stop(); });

  it("reads one frame with ANSI styling and the pane's own size", async () => {
    fake.panes.get("w1:p1")!.cols = 96;
    const r = await d.req("GET", `/api/workers/${enc(W)}/terminal/frame`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cols: 96, rows: 30 });
    expect(r.body.text).toContain("\x1b[38;2;215;119;87m●\x1b[0m Running tests…");
    expect(r.body.text).toContain("\r\n");
    expect(fake.calls.some((c) => c.method === "pane.read" && c.params.format === "ansi" && c.params.strip_ansi === false && c.params.source === "visible")).toBe(true);
  });

  it("streams frames over SSE and pushes a new one when the screen changes", async () => {
    const res = await d.app.request(`/api/workers/${enc(W)}/terminal`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames: any[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/^event: frame/m.test(block)) frames.push(JSON.parse(block.match(/^data: (.*)$/m)![1]));
        }
      }
    })();
    await waitFor(() => frames.length >= 1, 3000);
    fake.panes.get("w1:p1")!.screen.push("● All 14 tests pass.");
    const f = await waitFor(() => frames.find((x) => x.text.includes("All 14 tests pass")), 3000);
    expect(f.cols).toBe(96);
    const n = frames.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(frames.length).toBe(n); // unchanged screens are not resent
    await reader.cancel();
    await pump.catch(() => {});
  });

  it("typing reaches the pane in order: text, Backspace, Enter, then named keys", async () => {
    const before = fake.inputs.length;
    let r = await d.req("POST", `/api/workers/${enc(W)}/input`, { data: "run the exprt" });
    expect(r.body).toEqual({ ok: true, sent: ["text(13)"] });
    r = await d.req("POST", `/api/workers/${enc(W)}/input`, { data: "\x7f\x7f\x7fport tests\r" });
    expect(r.body.sent).toEqual(["backspace backspace backspace", "text(10)", "enter"]);
    const got = fake.inputs.slice(before).filter((x) => x.target === "w1:p1");
    expect(got.map((x) => x.text ?? x.keys!.join(" "))).toEqual(["run the exprt", "backspace backspace backspace", "port tests", "enter"]);
    expect(fake.typed.at(-1)).toMatchObject({ target: "w1:p1", text: "run the export tests" });
    expect(fake.calls.some((c) => c.method === "pane.send_input" && c.params.text === "port tests" && c.params.keys[0] === "enter")).toBe(true);

    r = await d.req("POST", `/api/workers/${enc(W)}/input`, { keys: ["shift+tab"] });
    expect(r.body.sent).toEqual(["shift+tab"]);
    r = await d.req("POST", `/api/workers/${enc(W)}/input`, { data: "\x1b\x03" });
    expect(r.body.sent).toEqual(["esc ctrl+c"]);
    expect(fake.inputs.at(-1)).toMatchObject({ target: "w1:p1", keys: ["esc", "ctrl+c"] });
  });

  it("falls back to raw bytes when Herdr rejects a key name", async () => {
    const r = await d.req("POST", `/api/workers/${enc(W)}/input`, { data: "\x1b[3~" });
    expect(r.status).toBe(200);
    expect(fake.inputs.at(-1)).toMatchObject({ target: "w1:p1", text: "\x1b[3~" });
  });

  it("refuses input from other sites, non-JSON bodies and agents outside Herdr", async () => {
    const post = (headers: Record<string, string>) => d.app.request(`/api/workers/${enc(W)}/input`, { method: "POST", headers, body: JSON.stringify({ data: "echo hi\r" }) });
    const before = fake.inputs.length;
    expect((await post({ "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect([403, 415]).toContain((await post({ "content-type": "text/plain" })).status); // refused by the global CSRF guard (415) or the route (403)
    expect((await post({ "content-type": "application/json", origin: "http://127.0.0.1:4317" })).status).toBe(200);
    expect(fake.inputs.length).toBe(before + 2); // only the local request typed (text + enter)
    expect((await d.req("POST", `/api/workers/${enc("local:pid:99999")}/input`, { data: "x" })).status).toBe(404);
    expect((await d.req("POST", `/api/workers/${enc(W)}/input`, { keys: ["rm -rf /"] })).status).toBe(400);
    expect((await d.req("POST", `/api/workers/${enc(W)}/input`, {})).status).toBe(400);
  });
});
