import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { callMap } from "../../src/shared/map-client.ts";
import { sandboxDaemon } from "../sandbox.ts";
import type { MissionsService } from "../../src/modules/missions/index.ts";

let d: Awaited<ReturnType<typeof sandboxDaemon>>;
let http: ReturnType<typeof serve>;
let cli: typeof import("../../src/cli/map.ts");
let base: string;
let commit: string;
const env: NodeJS.ProcessEnv = { FM_TASK_ID: "jr-agent-test" };

beforeAll(async () => {
  d = await sandboxDaemon("map-agent", ["missions", "nudges", "notes"]);
  await d.req("POST", "/api/missions", { id: "exports", title: "Exports" });
  await d.req("POST", "/api/missions", { id: "search", title: "Search" });
  await d.req("POST", "/api/lenses", { id: "reports", title: "Reports", missions: ["exports"] });
  await d.req("POST", "/api/lenses", { id: "product", title: "Product" });
  http = serve({ fetch: d.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!http.listening) await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing sandbox HTTP port");
  base = `http://127.0.0.1:${address.port}`;
  process.env.JOYRIDE_URL = base;
  env.JOYRIDE_URL = base;
  cli = await import("../../src/cli/map.ts");

});
afterAll(async () => { if (http && "closeAllConnections" in http) http.closeAllConnections(); if (http) await new Promise<void>((resolve) => http.close(() => resolve())); await d?.stop(); });

function mission(id: string) { return d.ctx.service<MissionsService>("missions").get(id); }
async function mapRequest(name: string, args: Record<string, unknown>): Promise<any> {
  return callMap(name.replace(/^map_/, "").replaceAll("_", "-"), args, { kind: "agent", id: "jr-api-test", via: "cli" }, base);
}

describe("agents edit the real map endpoints", () => {
  it("shows groups and authored task/session links", async () => {
    const show = JSON.parse(await cli.runMap(["show"], env));
    expect(show.groups).toEqual(expect.arrayContaining([expect.objectContaining({ id: "reports" })]));
    expect(show.ideas.find((m: { id: string }) => m.id === "exports")).toMatchObject({ group: "reports", crews: [], sessions: [] });
  });
  it("moves from the primary group, preserves attribution and emits the UI changes", async () => {
    const changes: string[] = [];
    const off = d.ctx.bus.onChange((c) => changes.push(c.entity));
    try {
      const result = JSON.parse(await cli.runMap(["move-idea", "exports", "--to-group", "product"], env));
      commit = result.commit;
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(mission("exports")?.lenses).toEqual(["product"]);
      expect((await d.req("GET", "/api/lenses")).body.find((g: { id: string }) => g.id === "reports").missions).toEqual([]);
      expect(changes).toEqual(expect.arrayContaining(["missions", "lenses"]));
      const history = JSON.parse(await cli.runMap(["history"], env));
      expect(history[0]).toMatchObject({ commit, actor: { kind: "agent", id: "jr-agent-test", via: "cli" }, undone: false });
      const notices = (await d.req("GET", "/api/nudges/undo-toasts")).body;
      expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({ title: expect.stringContaining("jr-agent-test"), ref: expect.objectContaining({ kind: "map", commit }) })]));
    } finally { off(); }
  });
  it("uses the map's existing notification Undo, and persists that Undo across reads", async () => {
    const response = await d.req("POST", `/api/nudges/undo-toasts/tidied:${commit}/undo`, {});
    expect(response.status).toBe(200);
    expect(mission("exports")?.lenses).toEqual([]);
    expect((await d.req("GET", "/api/lenses")).body.find((g: { id: string }) => g.id === "reports").missions).toEqual(["exports"]);
    expect((await d.req("GET", "/api/missions/move/history")).body[0]).toMatchObject({ commit, undone: true });
    expect((await d.req("GET", "/api/nudges")).body.nudges.some((n: { id: string }) => n.id === `tidied:${commit}`)).toBe(false);
  });
  it("moves tasks and undoes them through the shared map API", async () => {
    const result = await mapRequest("map_move_task", { task: "jr-task", to_idea: "exports" });
    expect(mission("exports")?.crews).toContain("jr-task");
    expect((await mapRequest("map_history", {}))[0].actor).toEqual({ kind: "agent", id: "jr-api-test", via: "cli" });
    await mapRequest("map_undo", { commit: result.commit });
    expect(mission("exports")?.crews).not.toContain("jr-task");
  });
  it("creates a group via API with the same reversible session and group moves", async () => {
    const group = await mapRequest("map_new_group", { title: "Writing", idea: "search" });
    expect(mission("search")?.lenses).toEqual(["writing"]);
    await mapRequest("map_undo", { commit: group.commit });
    expect((await d.req("GET", "/api/lenses")).body.some((g: { id: string }) => g.id === "writing")).toBe(false);
    const session = await mapRequest("map_file_session", { session: "claude:example", to_idea: "exports" });
    expect(mission("exports")?.sessions).toContainEqual({ source: "claude", id: "example" });
    await mapRequest("map_undo", { commit: session.commit });
    expect(mission("exports")?.sessions).toEqual([]);
  });
  it("gives API the note drawer's add, edit, archive and restore operations", async () => {
    const note = await mapRequest("map_add_note", { text: "Keep exports streaming\nPreserve totals", scope: "mission:exports" });
    expect(note).toMatchObject({ bullets: ["Keep exports streaming", "Preserve totals"], provenance: { type: "agent", ref: "cli:jr-api-test" } });
    const edited = await mapRequest("map_edit_note", { note: note.id, text: "Keep exports streaming" });
    expect(edited.bullets).toEqual(["Keep exports streaming"]);
    expect((await mapRequest("map_archive_note", { note: note.id })).status).toBe("archived");
    expect((await mapRequest("map_restore_note", { note: note.id })).status).toBe("active");
    const { git } = await import("../../src/core/util.ts");
    const log = git(d.sb.env.JOYRIDE_HOME, ["log", "-1", "--format=%B"]);
    expect(log).toContain('Map-actor: {"kind":"agent","id":"jr-api-test","via":"cli"}');
  });
  it("creates and edits canvas notes/lists using the UI's checkbox format and delete Undo", async () => {
    const note = await mapRequest("map_note", { text: "Streaming is required", scope: "mission:exports" });
    expect(note).toMatchObject({ scope: "mission:exports", bullets: ["Streaming is required"], provenance: { type: "agent", ref: "cli:jr-api-test" } });
    const list = JSON.parse(await cli.runMap(["list", "Tag build", "[x] Write notes", "--title", "Release", "--scope", "mission:exports"], env));
    expect(list).toMatchObject({ title: "Release", bullets: ["[ ] Tag build", "[x] Write notes"], provenance: { type: "agent", ref: "cli:jr-agent-test" } });
    const edited = await mapRequest("map_edit_list", { note: list.id, items: ["[x] Tag version", "Tell support"], title: "Ship" });
    expect(edited).toMatchObject({ title: "Ship", bullets: ["[x] Tag version", "[ ] Tell support"] });
    expect((await mapRequest("map_archive_note", { note: list.id })).status).toBe("archived");
    expect((await mapRequest("map_restore_note", { note: list.id })).status).toBe("active");
  });
  it("saves link cards and mixed items in a group, moves them, and reads the board, through CLI and API", async () => {
    const link = await mapRequest("map_link", { links: ["https://example.com/files/launch-spec.pdf"], title: "Launch spec", group: "product" });
    expect(link).toMatchObject({ scope: "group:product", title: "Launch spec", bullets: ["[Launch spec](https://example.com/files/launch-spec.pdf)"], provenance: { type: "agent", ref: "cli:jr-api-test" } });
    const mixed = JSON.parse(await cli.runMap(["note", "Release prep\n[ ] tag the build\nartifact:rep-1", "--idea", "exports"], env));
    expect(mixed).toMatchObject({ scope: "mission:exports", title: "Release prep", bullets: ["Release prep", "[ ] tag the build", "artifact:rep-1"] });
    expect((await mapRequest("map_move_note", { note: mixed.id, group: "product" })).scope).toBe("group:product");
    expect((await mapRequest("map_move_note", { note: mixed.id, unfiled: true })).scope).toBe("global");
    expect((await mapRequest("map_board", { group: "product" })).map((n: { id: string }) => n.id)).toEqual([link.id]);
    expect((await mapRequest("map_board", {})).map((n: { id: string }) => n.id)).toEqual(expect.arrayContaining([link.id, mixed.id]));
    await expect(mapRequest("map_link", { links: ["https://example.com/x"], group: "no-such-group" })).rejects.toThrow(/There is no group/);
    for (const n of [link, mixed]) await mapRequest("map_archive_note", { note: n.id });
  });
  it("creates, renames, merges and deletes groups via CLI and API with attributed Undo", async () => {
    const created = JSON.parse(await cli.runMap(["new-group", "Scratch"], env));
    const renamed = await mapRequest("map_rename_group", { group: created.lens, title: "Drafts" });
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === created.lens).title).toBe("Drafts");
    expect((await mapRequest("map_history", {})).find((r: { commit: string }) => r.commit === renamed.commit).actor.id).toBe("jr-api-test");
    await mapRequest("map_undo", { commit: renamed.commit });
    const assigned = await mapRequest("map_move_session", { session: "claude:group-session", to_group: created.lens });
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === created.lens).sessions).toEqual(["claude:group-session"]);
    expect((await mapRequest("map_history", {})).find((r: { commit: string }) => r.commit === assigned.commit).actor.id).toBe("jr-api-test");
    const merged = await mapRequest("map_merge_group", { group: created.lens, into: "product" });
    expect((await mapRequest("map_show", {})).groups.some((g: { id: string }) => g.id === created.lens)).toBe(false);
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === "product").sessions).toContain("claude:group-session");
    await mapRequest("map_undo", { commit: merged.commit });
    const deleted = await mapRequest("map_delete_group", { group: created.lens });
    await mapRequest("map_undo", { commit: deleted.commit });
    await mapRequest("map_undo", { commit: assigned.commit });
    await mapRequest("map_undo", { commit: created.commit });
    const sessionGroup = await mapRequest("map_new_session_group", { title: "Session scratch", session: "codex:group-session" });
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === sessionGroup.lens).sessions).toEqual(["codex:group-session"]);
    await mapRequest("map_undo", { commit: sessionGroup.commit });
  });
  it("renames derived repo and Unfiled groups through their same endpoints", async () => {
    const unfiled = await mapRequest("map_rename_unfiled_group", { project: "alpha", title: "Alpha scratch" });
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === unfiled.lens).projects).toEqual(["alpha"]);
    await mapRequest("map_undo", { commit: unfiled.commit });
    const repo = await mapRequest("map_rename_repo_group", { repo: "", title: "Unattached ideas" });
    expect((await mapRequest("map_show", {})).groups.find((g: { id: string }) => g.id === repo.lens).missions).toEqual(expect.arrayContaining(["search"]));
    await mapRequest("map_undo", { commit: repo.commit });
  });
  it("attributes set-aside history and offers the UI's unhide as notification Undo", async () => {
    const changes: string[] = [];
    const off = d.ctx.bus.onChange((c) => changes.push(c.entity));
    try {
      const hidden = JSON.parse(await cli.runMap(["hide", "claude:aside"], env));
      expect((await mapRequest("map_hidden", {}))["claude:aside"]).toBe(hidden.at);
      const entry = (await mapRequest("map_history", {})).find((r: { key?: string; undone: boolean }) => r.key === "claude:aside" && !r.undone);
      expect(entry).toMatchObject({ commit: null, actor: { id: "jr-agent-test", via: "cli" }, undone: false });
      const nudge = (await d.req("GET", "/api/nudges/undo-toasts")).body.find((n: { ref: { key?: string } }) => n.ref.key === "claude:aside");
      expect(nudge.title).toContain("jr-agent-test");
      expect((await d.req("POST", `/api/nudges/undo-toasts/${nudge.id}/undo`, {})).status).toBe(200);
      expect((await mapRequest("map_hidden", {}))["claude:aside"]).toBeUndefined();
      expect((await mapRequest("map_history", {})).find((r: { id: string }) => r.id === entry.id).undone).toBe(true);
      expect(changes).toContain("missions");
      await mapRequest("map_hide", { key: "worker-1" });
      await mapRequest("map_unhide", { key: "worker-1" });
      expect((await mapRequest("map_hidden", {}))["worker-1"]).toBeUndefined();
    } finally { off(); }
  });
  it("marks set-aside history undone when the worker has new activity, just like the map", async () => {
    let updated = "2000-01-01T00:00:00.000Z";
    d.ctx.services.set("workers", { list: () => [{ id: "worker-new", session: "claude:new", updated }] });
    try {
      const hidden = await mapRequest("map_hide", { key: "claude:new" });
      expect((await mapRequest("map_history", {})).find((r: { key?: string }) => r.key === "claude:new").undone).toBe(false);
      updated = new Date(Date.parse(hidden.at) + 1000).toISOString();
      expect((await mapRequest("map_history", {})).find((r: { key?: string }) => r.key === "claude:new").undone).toBe(true);
      expect((await d.req("GET", "/api/nudges")).body.nudges.some((n: { ref: { key?: string } }) => n.ref.key === "claude:new")).toBe(false);
    } finally {
      d.ctx.services.delete("workers");
      await mapRequest("map_unhide", { key: "claude:new" });
    }
  });
  it("rejects invalid API arguments and HTTP actor data without writing", async () => {
    await expect(mapRequest("map_move_task", { task: "jr-task", to_idea: null })).rejects.toThrow();
    await expect(mapRequest("map_rename_group", { group: "missing", title: "Reporting" })).rejects.toThrow(/No group/);
    const before = (await d.req("GET", "/api/missions/move/history")).body;
    expect((await d.req("POST", "/api/missions/move", { mission: "exports", to: { new_lens: "Forged" }, actor: { kind: "captain" } })).status).toBe(400);
    expect((await d.req("POST", "/api/lenses/create", { title: "Forged", actor: { kind: "captain" } })).status).toBe(400);
    expect((await d.req("POST", "/api/missions/hide", { key: "worker-1", actor: { kind: "captain" } })).status).toBe(400);
    expect((await d.req("GET", "/api/missions/move/history")).body).toEqual(before);
  });
  it("keeps the same conflict protection when a later edit touched the files", async () => {
    const move = JSON.parse(await cli.runMap(["move-task", "jr-task", "--to-idea", "exports"], env));
    await d.req("PUT", "/api/missions/exports", { title: "Changed afterward" });
    await expect(cli.runMap(["undo", move.commit], env)).rejects.toThrow(/changed after/);
    expect(mission("exports")?.crews).toContain("jr-task");
  });
});
