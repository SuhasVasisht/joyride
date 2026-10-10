import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import { expect, it } from "vitest";
import { sandboxDaemon } from "../sandbox.ts";

it("reads a supported second Codex account and retains both accounts when one store disappears", async () => {
  const d = await sandboxDaemon("sessions-accounts", ["sessions"]);
  try {
    const secondary = path.join(d.sb.dir, "codex-2");
    fs.mkdirSync(secondary, { recursive: true });
    const primary = d.sb.env.JOYRIDE_CODEX_DIR;
    fs.copyFileSync(path.join(primary, "state_5.sqlite"), path.join(secondary, "state_5.sqlite"));
    const db = new Database(path.join(secondary, "state_5.sqlite"));
    const id = "019a0000-0000-7000-8000-000000009999";
    try {
      const row = db.prepare("SELECT id, rollout_path FROM threads LIMIT 1").get();
      if (!row || !(typeof row === "object") || !("id" in row) || !("rollout_path" in row) || typeof row.rollout_path !== "string") throw new Error("missing thread fixture");
      const rollout = path.join(secondary, "sessions", "second.jsonl");
      fs.mkdirSync(path.dirname(rollout), { recursive: true });
      fs.copyFileSync(row.rollout_path, rollout);
      db.prepare("DELETE FROM threads WHERE id != ?").run(row.id);
      db.prepare("UPDATE threads SET id = ?, rollout_path = ?, title = ?").run(id, rollout, "Second account's handoff");
    } finally { db.close(); }
    const configPath = path.join(d.sb.env.JOYRIDE_HOME, "joyride.config.yaml");
    const config = YAML.parse(fs.readFileSync(configPath, "utf8"));
    config.usage.accounts.push({ provider: "codex", label: "Codex 2", home: secondary });
    fs.writeFileSync(configPath, YAML.stringify(config));
    // Match the Settings route, which updates both authored config and the daemon context.
    d.ctx.config.usage.accounts = config.usage.accounts;
    const svc = d.ctx.service<import("../../src/modules/sessions/types.ts").SessionsService>("sessions");
    await svc.reindex();
    expect(svc.get(`codex:${id}`)?.title).toBe("Second account's handoff");
    expect(svc.list({ limit: 100 }).filter((s) => s.source === "codex").length).toBeGreaterThan(1);
    fs.renameSync(secondary, secondary + "-offline");
    await svc.reindex();
    expect(svc.get(`codex:${id}`)).toBeTruthy();
    expect(svc.list({ limit: 100 }).filter((s) => s.source === "codex").length).toBeGreaterThan(1);
    expect((await svc.transcriptState(`codex:${id}`))?.turns).toEqual([]);
    await expect(svc.transcriptState(`codex:${id}`, { fullText: true })).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await d.stop(); }
});
