import { beforeAll, afterAll, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sandboxDaemon } from "../sandbox.ts";
import type { FirstmateFile } from "../../src/modules/system/firstmate-files.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
const files = ["captain.md", "captain-shared.md", "learnings.md", "memory-archive.md"];
const filePath = (file: string) => path.join(d.sb.env.FM_HOME, "data", file);
const checksum = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath(file))).digest("hex");
const readFiles = async (): Promise<FirstmateFile[]> => (await d.req("GET", "/api/system/firstmate-files")).body;

beforeAll(async () => {
  d = await sandboxDaemon("firstmate-files", ["system"]);
  expect(d.sb.env.FM_HOME.startsWith(d.sb.dir)).toBe(true);
  fs.mkdirSync(path.dirname(filePath(files[0])), { recursive: true });
  for (const file of files) fs.writeFileSync(filePath(file), `# ${file}\n\n- Keep my exact bullet. <!--P-->\n`);
});
afterAll(async () => { await d.stop(); });

it("reads all four canonical files and opens only those files without changing a byte", async () => {
  const before = files.map(checksum);
  const report = await readFiles();
  expect(report.map((f) => f.file)).toEqual(files);
  for (const file of report) {
    expect(file).toEqual({ file: file.file, path: filePath(file.file), state: "ready", text: `# ${file.file}\n\n- Keep my exact bullet. <!--P-->\n` });
    expect(await d.req("POST", `/api/system/firstmate-files/${file.file}/open`)).toEqual({ status: 200, body: { opened: filePath(file.file) } });
  }
  expect((await d.req("POST", "/api/system/firstmate-files/backlog.md/open")).status).toBe(400);
  expect(files.map(checksum)).toEqual(before);
});

it("keeps /stow-style edits across refreshes and daemon restart", async () => {
  const edited = "# Learnings\n\n- A new bullet from Firstmate. <!--a:2026-10-05-->\n";
  fs.writeFileSync(filePath("learnings.md"), edited);
  const before = files.map(checksum);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await d.stop();
  process.env.JOYRIDE_SANDBOX_DIR = d.sb.dir;
  try { d = await sandboxDaemon("firstmate-files", ["system"]); }
  finally { delete process.env.JOYRIDE_SANDBOX_DIR; }
  expect(files.map(checksum)).toEqual(before);
  expect((await readFiles()).find((f) => f.file === "learnings.md")).toMatchObject({ text: edited });
  expect((await d.req("GET", "/api/memory?scope=fleet")).status).toBe(404);
  expect((await d.app.request("/api/memory/firstmate/sync", { method: "POST" })).status).toBe(404);
  expect(fs.existsSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "state", "firstmate-memory.json"))).toBe(false);
  expect(fs.existsSync(path.join(d.sb.env.JOYRIDE_HOME, "firstmate"))).toBe(false);
});


it("reports absent and unreadable files without failing the other reads", async () => {
  fs.unlinkSync(filePath("captain-shared.md"));
  fs.unlinkSync(filePath("memory-archive.md"));
  fs.mkdirSync(filePath("memory-archive.md"));
  const report = await readFiles();
  expect(report.find((f) => f.file === "captain-shared.md")).toMatchObject({ state: "absent" });
  expect(report.find((f) => f.file === "memory-archive.md")).toMatchObject({ state: "unreadable", error: expect.stringContaining("permissions") });
  expect(report.find((f) => f.file === "captain.md")).toMatchObject({ state: "ready" });
  expect((await d.req("POST", "/api/system/firstmate-files/captain-shared.md/open")).status).toBe(404);
  expect((await d.req("POST", "/api/system/firstmate-files/memory-archive.md/open")).status).toBe(500);
});
