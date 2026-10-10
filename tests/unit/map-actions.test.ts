import { describe, expect, it } from "vitest";
import { MAP_ACTIONS, MAP_TOOLS, mapAction } from "../../src/shared/map-actions.ts";
import { parseMapArgs } from "../../src/cli/map.ts";
import { mapActor } from "../../src/shared/map-client.ts";

describe("the UI-importable map action table", () => {
  it("has one MCP schema and CLI command per action", () => {
    expect(new Set(MAP_ACTIONS.map((a) => a.name)).size).toBe(MAP_ACTIONS.length);
    expect(MAP_TOOLS.map((t) => t.name)).toEqual([
      "map_show", "map_history", "map_move_idea", "map_move_task", "map_file_session",
      "map_move_session", "map_new_group", "map_new_empty_group", "map_new_session_group", "map_rename_group", "map_rename_repo_group", "map_rename_unfiled_group", "map_delete_group", "map_merge_group", "map_move_group", "map_hidden", "map_hide", "map_unhide", "map_add_note", "map_edit_note", "map_archive_note", "map_restore_note", "map_note", "map_list", "map_link", "map_edit_list", "map_move_note", "map_board", "map_undo",
    ]);
    for (const a of MAP_ACTIONS) {
      expect(a.description.length).toBeGreaterThan(10);
      expect(MAP_TOOLS.find((t) => t.name === `map_${a.name.replaceAll("-", "_")}`)?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });
  it.each([
    ["move-idea", ["exports", "--to-group", "reporting"], { mission: "exports", to: { lens: "reporting" } }],
    ["move-idea", ["exports", "--to-group", "none", "--from-group", "reporting"], { mission: "exports", from: "reporting", to: { lens: null } }],
    ["move-task", ["jr-export", "--to-idea", "exports"], { task: "jr-export", to: { mission: "exports" } }],
    ["file-session", ["claude:session-1", "--to-idea", "exports"], { session: "claude:session-1", to: { mission: "exports" } }],
    ["file-session", ["codex:session-1", "--to-idea", "none"], { session: "codex:session-1", to: { mission: null } }],
    ["new-group", ["Reports", "--idea", "exports"], { mission: "exports", to: { new_lens: "Reports" } }],
  ])("%s calls the UI move endpoint", (name, argv, body) => {
    const parsed = parseMapArgs([name, ...argv]);
    expect(mapAction(name).prepare(parsed.args)).toEqual({ method: "POST", path: "/api/missions/move", body });
  });
  it("uses each owner's Undo endpoint", () => {
    expect(mapAction("undo").prepare({ commit: "abcdef1" })).toEqual({ method: "POST", path: "/api/missions/move/undo", body: { commit: "abcdef1" } });
    expect(mapAction("undo").prepare({ commit: "abcdef1", housekeeping: true }).path).toBe("/api/ideas/undo");
  });
  it.each([
    ["move-task", "jr-task"], ["move-task", "jr-task", "--to-idea", "none", "--unknown", "a"],
    ["move-task", "../bad", "--to-idea", "exports"], ["move-task", "jr-task", "--to-idea", "exports", "extra"],
    ["move-idea", "exports", "--to-group"], ["move-idea", "exports", "--to-group", "--agent", "a"],
    ["move-idea", "exports", "--to-group", "one", "--to-group", "two"],
    ["file-session", "s1", "--to-idea", "exports"], ["new-group", "   ", "--idea", "exports"],
    ["undo", "--housekeeping"], ["undo", "not-a-sha"], ["show", "extra"],
    ["move-idea", "exports", "--to-group", "reporting", "--agent", "a\nforged"],
  ])("rejects invalid arguments before any HTTP call: %j", (...argv) => expect(() => parseMapArgs(argv)).toThrow());
  it("marshals CLI note and checklist arguments to the UI's notes API", () => {
    const note = parseMapArgs(["note", "Keep exports streaming", "--scope", "mission:exports"]);
    expect(mapAction(note.name).prepare(note.args)).toEqual({ method: "POST", path: "/api/notes", body: { text: "Keep exports streaming", scope: "mission:exports" } });
    const list = parseMapArgs(["list", "Tag the build", "[x] Write notes", "--title", "Release", "--scope", "mission:exports"]);
    expect(mapAction(list.name).prepare(list.args)).toEqual({ method: "POST", path: "/api/notes", body: { bullets: ["[ ] Tag the build", "[x] Write notes"], title: "Release", scope: "mission:exports" } });
    const edit = parseMapArgs(["edit-list", "note-release", "[x] Tag the build", "Tell support"]);
    expect(mapAction(edit.name).prepare(edit.args)).toEqual({ method: "PUT", path: "/api/notes/note-release", body: { bullets: ["[x] Tag the build", "[ ] Tell support"] } });
    expect(() => parseMapArgs(["list"])).toThrow();
    expect(() => parseMapArgs(["edit-list", "note-release"])).toThrow();
    expect(() => mapAction("list").prepare({ items: ["[ ] "] })).toThrow();
    expect(() => mapAction("list").prepare({ items: [] })).toThrow();
  });
  it("places board items in a group, an idea or Unfiled, saves links, moves and reads them", () => {
    const req = (argv: string[]) => { const a = parseMapArgs(argv); return mapAction(a.name).prepare(a.args); };
    expect(req(["note", "Keep exports streaming", "--group", "launch"])).toEqual({ method: "POST", path: "/api/notes", body: { text: "Keep exports streaming", scope: "group:launch" } });
    expect(req(["note", "Keep exports streaming", "--idea", "exports"]).body).toMatchObject({ scope: "mission:exports" });
    expect(req(["note", "Keep exports streaming"]).body).toMatchObject({ scope: "global" });
    expect(req(["list", "a", "b", "--group", "launch"]).body).toMatchObject({ bullets: ["[ ] a", "[ ] b"], scope: "group:launch" });
    expect(() => req(["note", "x", "--group", "launch", "--idea", "exports"])).toThrow(/one place/);
    // A link card: one link with a readable title, or several; PDFs, artifacts and pages alike.
    expect(req(["link", "https://example.com/spec.pdf", "--title", "Launch spec", "--group", "launch"])).toEqual({ method: "POST", path: "/api/notes", body: { bullets: ["[Launch spec](https://example.com/spec.pdf)"], scope: "group:launch" } });
    expect(req(["link", "artifact:rep-1", "https://claude.ai/artifact/abc", "--title", "Reading"]).body).toEqual({ bullets: ["artifact:rep-1", "https://claude.ai/artifact/abc"], title: "Reading", scope: "global" });
    expect(() => req(["link", "not a link"])).toThrow();
    // Move to a group, an idea, Unfiled; nothing named says where.
    expect(req(["move-note", "note-a", "--group", "launch"])).toEqual({ method: "PUT", path: "/api/notes/note-a", body: { scope: "group:launch" } });
    expect(req(["move-note", "note-a", "--idea", "exports"]).body).toEqual({ scope: "mission:exports" });
    expect(req(["move-note", "note-a", "--unfiled"]).body).toEqual({ scope: "global" });
    expect(() => req(["move-note", "note-a"])).toThrow(/Say where it goes/);
    expect(req(["board"])).toEqual({ method: "GET", path: "/api/notes" });
    expect(req(["board", "--group", "launch"]).path).toBe("/api/notes?group=launch");
    expect(req(["board", "--idea", "exports"]).path).toBe("/api/notes?idea=exports");
    expect(req(["board", "--scope", "global"]).path).toBe("/api/notes?global=1");
  });
  it("rejects extra MCP fields and missing required arguments", () => {
    expect(() => mapAction("move-task").prepare({ task: "jr-task", to_idea: null })).toThrow();
    expect(() => mapAction("show").prepare({ typo: true })).toThrow();
  });
  it.each([
    ["new-group", ["Empty"], "/api/lenses/create", { title: "Empty" }],
    ["new-empty-group", ["Empty"], "/api/lenses/create", { title: "Empty" }],
    ["rename-group", ["reports", "Reporting"], "/api/lenses/rename", { lens: "reports", title: "Reporting" }],
    ["rename-repo-group", ["/tmp/repo", "Repo work"], "/api/lenses/rename", { repo: "/tmp/repo", title: "Repo work" }],
    ["rename-unfiled-group", ["alpha", "Scratch"], "/api/lenses/rename", { unfiled: "alpha", title: "Scratch" }],
    ["delete-group", ["reports"], "/api/lenses/delete", { lens: "reports" }],
    ["merge-group", ["reports", "--into", "product"], "/api/lenses/merge", { lens: "reports", into: "product" }],
    ["move-session", ["claude:one", "--to-group", "reports"], "/api/missions/move", { session: "claude:one", to: { lens: "reports" } }],
    ["new-session-group", ["Scratch", "--session", "codex:one"], "/api/missions/move", { session: "codex:one", to: { new_lens: "Scratch" } }],
    ["hide", ["claude:one"], "/api/missions/hide", { key: "claude:one" }],
    ["unhide", ["worker-1"], "/api/missions/unhide", { key: "worker-1" }],
  ])("%s marshals the landed UI endpoint", (name, argv, path, body) => {
    expect(mapAction(name).prepare(parseMapArgs([name, ...argv]).args)).toEqual({ method: "POST", path, body });
  });
  it("rejects invalid group and set-aside arguments", () => {
    expect(MAP_ACTIONS.every((a) => a.availability === "ready")).toBe(true);
    for (const argv of [["new-group", "x".repeat(81)], ["rename-group", "reports"], ["merge-group", "reports"], ["hide", "../bad"], ["move-session", "claude:one", "--to-group", "../bad"]]) {
      expect(() => parseMapArgs(argv)).toThrow();
    }
    expect(mapAction("rename-repo-group").prepare({ repo: "", title: "No repo work" }).body).toEqual({ repo: "", title: "No repo work" });
  });
  it("attributes CLI and MCP callers to their task or session", () => {
    expect(mapActor("cli", undefined, { FM_TASK_ID: "jr-export", CODEX_THREAD_ID: "session" })).toEqual({ kind: "agent", id: "jr-export", via: "cli" });
    expect(mapActor("mcp", undefined, { CODEX_THREAD_ID: "session" }).id).toBe("session");
    expect(mapActor("cli", undefined, { FM_TASK_ID: "", CLAUDE_SESSION_ID: "", CODEX_THREAD_ID: "native-codex" }).id).toBe("native-codex");
    expect(mapActor("mcp", "explicit", {}).id).toBe("explicit");
  });
});
