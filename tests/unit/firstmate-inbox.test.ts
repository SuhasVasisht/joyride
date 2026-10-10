import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileInboxNote, HANDOFF_FILING_TIMEOUT_MS } from "../../src/modules/firstmate/inbox.ts";

const body = JSON.stringify({ handoff: "large context\n".repeat(5000) });
function stub(name: string, source: string) {
  const dir = path.join(process.env.JOYRIDE_RUNTIME!, name);
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "fm-inbox.sh");
  fs.writeFileSync(script, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  return { script, cwd: dir, env: process.env, requestId: "primary-handoff-same-id", body };
}
const receipt = { saved: true, id: "note-large", outcome: "created", announced: false, path: "inbox/note-large.md" };

describe("Handoff inbox filing", () => {
  it("files a >=50 KB body when the helper takes longer than the ordinary 30-second timeout", async () => {
    expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(50 * 1024);
    const opts = stub("slow-inbox", `const fs = require('node:fs');
let body = ''; process.stdin.on('data', b => body += b);
process.stdin.on('end', () => {
 fs.writeFileSync('received.json', body);
 setTimeout(() => console.log(JSON.stringify(${JSON.stringify(receipt)})), 31000);
});`);
    const result = await fileInboxNote({ ...opts, timeoutMs: HANDOFF_FILING_TIMEOUT_MS });
    expect(result).toEqual({ note: "note-large", outcome: "created", announced: false, path: "inbox/note-large.md" });
    expect(fs.readFileSync(path.join(opts.cwd, "received.json"), "utf8")).toBe(body);
  }, 45_000);

  it("kills a hanging helper and replays a note saved before timeout with the same request id", async () => {
    const opts = stub("hung-inbox", `const fs = require('node:fs');
const id = process.argv[process.argv.indexOf('--request-id') + 1];
let body = ''; process.stdin.on('data', b => body += b);
process.stdin.on('end', () => {
 fs.appendFileSync('requests.jsonl', JSON.stringify({id, body}) + '\\n');
 if (fs.existsSync('saved')) { console.log(JSON.stringify(${JSON.stringify({ ...receipt, outcome: "replayed" })})); process.exitCode = 3; }
 else { fs.writeFileSync('saved', id); setInterval(() => {}, 1000); }
});`);
    await expect(fileInboxNote({ ...opts, timeoutMs: 750 })).rejects.toThrow("timed out after 0.75 seconds");
    const result = await fileInboxNote({ ...opts, timeoutMs: 2000 });
    expect(result).toMatchObject({ note: "note-large", outcome: "replayed" });
    const requests = fs.readFileSync(path.join(opts.cwd, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(requests).toEqual([{ id: opts.requestId, body }, { id: opts.requestId, body }]);
  });
});
