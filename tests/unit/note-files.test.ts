import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { migrateNoteFiles, parseNoteFile, readNoteFile, writeNoteFile } from "../../src/shared/note-files.ts";

const legacy = (id: string, scope = "global") => `---\nid: ${id}\nkind: note\ntitle: Friday demo\nscope: ${scope}\nstatus: active\nprovenance: {type: human, ref: map}\ncreated: 2026-10-05T22:16:02.107Z\nverified_at: 2026-10-05T22:16:02.107Z\n---\n\n- Demo on Friday\n- [ ] Keep the checklist\n- [Spec](https://example.com/spec)\n`;
let d: Awaited<ReturnType<typeof sandboxDaemon>>;
afterAll(async () => { await d?.stop(); });

describe("authored notes", () => {
  it("copies every legacy note without changing text or source and never overwrites an edited destination", () => {
    const root = fs.mkdtempSync(path.join(process.env.JOYRIDE_SANDBOX_DIR!, "note-copy-"));
    const from = path.join(root, "memory"), to = path.join(root, "notes");
    fs.mkdirSync(from);
    for (const [id, scope] of [["note-global", "global"], ["note-idea", "mission:demo"], ["note-task", "task:demo"]]) fs.writeFileSync(path.join(from, `${id}.md`), legacy(id, scope));
    const sources = fs.readdirSync(from).map(file => [file, fs.readFileSync(path.join(from, file), "utf8")]);
    expect(migrateNoteFiles(from, to)).toMatchObject({ files: expect.any(Array), errors: [] });
    for (const [file, text] of sources) {
      expect(readNoteFile(to, file.slice(0, -3))).toEqual(parseNoteFile(text));
      expect(fs.readFileSync(path.join(from, file), "utf8")).toBe(text);
    }
    const cur = readNoteFile(to, "note-global")!;
    writeNoteFile(to, { ...cur, body: "- Edited after migration", scope: "group:launch", status: "archived" });
    expect(migrateNoteFiles(from, to).files).toEqual([]);
    expect(readNoteFile(to, cur.id)).toMatchObject({ body: "- Edited after migration", scope: "group:launch", status: "archived" });
    fs.writeFileSync(path.join(to, "note-task.md"), "unreadable destination");
    expect(migrateNoteFiles(from, to).files).toEqual([]);
    expect(fs.readFileSync(path.join(to, "note-task.md"), "utf8")).toBe("unreadable destination");
    fs.writeFileSync(path.join(from, "broken.md"), "---\nkind: note\nid: ../escape\n---\n- Bad id\n");
    expect(migrateNoteFiles(from, to).errors).toHaveLength(1);
  });

  it("runs API, task delivery and knowledge search without the memory module, and commits handwritten edits", async () => {
    d = await sandboxDaemon("notes-independent", ["notes", "knowledge"]);
    await d.start();
    expect(d.ctx.services.has("memory")).toBe(false);
    const added = await d.req("POST", "/api/notes", { task: "demo", bullets: ["Distinctive nebula note"] });
    expect(added.status).toBe(201);
    const id = added.body.id;
    const file = path.join(d.sb.env.JOYRIDE_HOME, "notes", `${id}.md`);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/confidence:|supersedes:|verified_at:/);
    expect((await d.req("GET", "/api/notes/task/demo")).body.digest).toContain("Distinctive nebula note");
    const search = () => { d.ctx.service("knowledge").prepare(); return d.req("GET", "/api/knowledge/search?q=nebula&types=notes"); };
    expect((await search()).body.items).toEqual([expect.objectContaining({ ref: { entity: "note", id }, href: `#/board?item=${id}` })]);
    const cur = readNoteFile(path.dirname(file), id)!;
    writeNoteFile(path.dirname(file), { ...cur, body: "- Handwritten nebula revision" });
    await expect.poll(() => fs.readFileSync(path.join(d.sb.env.JOYRIDE_RUNTIME, "task-notes/task-demo.md"), "utf8")).toContain("Handwritten nebula revision");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: d.sb.env.JOYRIDE_HOME, encoding: "utf8" }).trim();
    expect(git("status", "--porcelain", "--", "notes")).toBe("");
    expect(git("log", "-1", "--format=%s")).toBe("joyride: notes: sync authored files");
    fs.writeFileSync(path.join(path.dirname(file), "broken.md"), "broken note");
    expect((await d.req("GET", "/api/notes")).body).toHaveLength(1);
    expect((await d.req("PUT", `/api/notes/${id}`, { bullets: ["API revision"] })).status).toBe(200);
    expect((await d.req("POST", `/api/notes/${id}/archive`)).body.status).toBe("archived");
    expect((await d.req("POST", `/api/notes/${id}/restore`)).body.status).toBe("active");
  });
});
