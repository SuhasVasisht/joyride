// The New box's planner (shared/new-plan.ts): freeform text to plain-word steps over the same map actions,
// note and list rules and Firstmate requests the UI already has. Each map step must prepare through
// MAP_ACTIONS, so New makes exactly the request the map and the agents make.
import { describe, it, expect } from "vitest";
import { bindArgs, clauses, nameScore, planNew, resolvePlan, type MapIndex, type Plan, type Step } from "../../src/shared/new-plan.ts";
import { mapAction } from "../../src/shared/map-actions.ts";

const ix: MapIndex = {
  ideas: [
    { id: "slack-automation", title: "Slack automation", group: null, repo: { path: "/r/bots", title: "bots" } },
    { id: "build-joyride", title: "Build Joyride", group: "core", repo: { path: "/r/joyride", title: "joyride" } },
    { id: "csv-export", title: "CSV export with totals", group: null, repo: { path: "/r/alpha", title: "alpha" } },
    { id: "slack-digest", title: "Slack digest", group: null, repo: { path: "/r/bots", title: "bots" } },
  ],
  groups: [{ id: "core", title: "Core" }, { id: "q4-bets", title: "Q4 bets" }, { id: "later", title: "Later" }],
  repoGroups: [{ path: "/r/bots", title: "bots" }, { path: "/r/alpha", title: "alpha" }],
  unfiled: [{ project: "beta", title: "beta" }, { project: "", title: "No project" }],
  tasks: [{ id: "jr-12", title: "Add a CSV export button", idea: "csv-export" }],
  sessions: [
    { key: "claude:aaa-111", title: "Fix the flaky login test", idea: null },
    { key: "codex:bbb-222", title: "Docs sweep", idea: "build-joyride" },
    { key: "claude:ccc-333", title: "Old spike", idea: null, hidden: true },
  ],
  history: [
    { commit: null, key: "claude:zzz", summary: "Set aside: claude:zzz", undone: true },
    { commit: "abc1234", summary: "Moved Slack automation to Q4 bets", undone: false },
  ],
};

const only = (p: Plan): Step => { expect(p.steps).toHaveLength(1); expect(p.steps[0].kind).not.toBe("choose"); return p.steps[0] as Step; };
/** The request a map step makes, through the agents' action table. */
const request = (s: Step) => { if (s.kind !== "map") throw new Error(`not a map step: ${s.kind}`); return mapAction(s.action).prepare(s.args); };

describe("New planner: map edits", () => {
  it("moves an idea to a group, by the names on the map, through move-idea", () => {
    const p = planNew("Move Slack automation to Q4 bets", ix);
    const s = only(p);
    expect(p.sure).toBe(true);
    expect(s.say).toBe("Move “Slack automation” to group “Q4 bets”");
    expect(request(s)).toEqual({ method: "POST", path: "/api/missions/move", body: { mission: "slack-automation", to: { lens: "q4-bets" } } });
    expect(s.kind === "map" && s.lands).toEqual({ kind: "idea", id: "slack-automation" });
  });

  it("takes quotes, kind words and a lower-case name", () => {
    const s = only(planNew("put the idea 'csv export' into group “q4 bets”", ix));
    expect(request(s).body).toEqual({ mission: "csv-export", to: { lens: "q4-bets" } });
  });

  it("returns an idea to its repo group", () => {
    const s = only(planNew("move Build Joyride back to its repo group", ix));
    expect(s.say).toBe("Move “Build Joyride” back to its repo group “joyride”");
    expect(request(s).body).toEqual({ mission: "build-joyride", to: { lens: null } });
    expect(request(only(planNew("take Build Joyride out of Core", ix))).body).toEqual({ mission: "build-joyride", to: { lens: null } });
  });

  it("moves a task to another idea through move-task", () => {
    const s = only(planNew("move task jr-12 to Build Joyride", ix));
    expect(s.say).toBe("Move task “Add a CSV export button” to idea “Build Joyride”");
    expect(request(s).body).toEqual({ task: "jr-12", to: { mission: "build-joyride" } });
  });

  it("files a session in an idea, moves it to a group, and back to Unfiled", () => {
    expect(request(only(planNew("file the flaky login test session in Build Joyride", ix))).body).toEqual({ session: "claude:aaa-111", to: { mission: "build-joyride" } });
    expect(request(only(planNew("move the session docs sweep to Q4 bets", ix))).body).toEqual({ session: "codex:bbb-222", to: { lens: "q4-bets" } });
    const s = only(planNew("move Docs sweep to Unfiled", ix));
    expect(s.say).toBe("Move session “Docs sweep” to Unfiled");
    expect(request(s).body).toEqual({ session: "codex:bbb-222", to: { mission: null } });
  });

  it("makes groups: empty, with an idea, with a session, and with several ideas through a forward reference", () => {
    const empty = only(planNew("create a group called Experiments", ix));
    expect(empty.say).toBe("Make an empty group “Experiments”");
    expect(request(empty)).toEqual({ method: "POST", path: "/api/lenses/create", body: { title: "Experiments" } });
    expect(request(only(planNew("new group: Bets with Slack digest", ix))).body).toEqual({ mission: "slack-digest", to: { new_lens: "Bets" } });
    expect(request(only(planNew("make a group Flaky with the flaky login test", ix))).body).toEqual({ session: "claude:aaa-111", to: { new_lens: "Flaky" } });
    // "to group X" that doesn't exist makes it.
    expect(request(only(planNew("move CSV export to group Reporting", ix))).body).toEqual({ mission: "csv-export", to: { new_lens: "Reporting" } });

    const p = planNew("make a group Bots with Slack automation and Slack digest", ix);
    expect(p.sure).toBe(false);
    const steps = resolvePlan(p, {})!;
    expect(steps.map((s) => s.say)).toEqual(["Make a group “Bots” with “Slack automation”", "Move “Slack digest” to group “Bots”"]);
    const second = steps[1];
    if (second.kind !== "map") throw new Error("map step expected");
    expect(second.args.to_group).toEqual({ $lens: 0 });
    expect(mapAction(second.action).prepare(bindArgs(second.args, [{ lens: "bots" }])).body).toEqual({ mission: "slack-digest", to: { lens: "bots" } });
    expect(() => bindArgs(second.args, [null])).toThrow(/wasn't made/);
  });

  it("chains clauses: a group made on one line is the target of the next", () => {
    const p = planNew("new group Bets\nmove Slack digest to Bets", ix);
    const steps = resolvePlan(p, {})!;
    expect(steps.map((s) => s.kind === "map" && s.action)).toEqual(["new-empty-group", "move-idea"]);
    expect(steps[1].kind === "map" && steps[1].args.to_group).toEqual({ $lens: 0 });
  });

  it("renames authored, repo and Unfiled groups", () => {
    const g = only(planNew("rename Later to Someday", ix));
    expect(g.say).toBe("Rename group “Later” to “Someday”");
    expect(request(g)).toEqual({ method: "POST", path: "/api/lenses/rename", body: { lens: "later", title: "Someday" } });
    expect(request(only(planNew("rename the alpha group to Reports", ix))).body).toEqual({ repo: "/r/alpha", title: "Reports" });
    expect(request(only(planNew("rename No project to Scratch", ix))).body).toEqual({ unfiled: "", title: "Scratch" });
  });

  it("merges and deletes groups", () => {
    const m = only(planNew("merge Later into Q4 bets", ix));
    expect(m.say).toBe("Merge group “Later” into “Q4 bets”");
    expect(request(m)).toEqual({ method: "POST", path: "/api/lenses/merge", body: { lens: "later", into: "q4-bets" } });
    expect(request(only(planNew("delete the group Later", ix)))).toEqual({ method: "POST", path: "/api/lenses/delete", body: { lens: "later" } });
    expect(request(only(planNew("delete Q4 bets", ix))).body).toEqual({ lens: "q4-bets" });
  });

  it("sets a session aside and brings one back", () => {
    const h = only(planNew("set the flaky login test aside", ix));
    expect(h.say).toBe("Set session “Fix the flaky login test” aside until it does something new");
    expect(request(h)).toEqual({ method: "POST", path: "/api/missions/hide", body: { key: "claude:aaa-111" } });
    expect(request(only(planNew("bring back old spike", ix)))).toEqual({ method: "POST", path: "/api/missions/unhide", body: { key: "claude:ccc-333" } });
  });

  it("undoes the newest map change that is not undone", () => {
    const u = only(planNew("undo", ix));
    expect(u.say).toBe("Undo “Moved Slack automation to Q4 bets”");
    expect(request(u)).toEqual({ method: "POST", path: "/api/missions/move/undo", body: { commit: "abc1234" } });
    expect(planNew("undo that", { ...ix, history: [] })).toMatchObject({ steps: [], notes: ["There's no map change to undo."], sure: false });
  });
});

describe("New planner: ambiguity and misses", () => {
  it("asks which one when a name fits several things, and Enter does not apply", () => {
    const p = planNew("move slack to Q4 bets", ix);
    expect(p.sure).toBe(false);
    const c = p.steps[0];
    if (c.kind !== "choose") throw new Error("choice expected");
    expect(c.say).toBe("Which “slack”?");
    expect(c.options.map((o) => o.say)).toEqual(["Move “Slack automation” to group “Q4 bets”", "Move “Slack digest” to group “Q4 bets”"]);
    expect(resolvePlan(p, {})).toBeNull();
    expect(resolvePlan(p, { 0: 1 })!.map((s) => request(s).body)).toEqual([{ mission: "slack-digest", to: { lens: "q4-bets" } }]);
  });

  it("an exact name wins over a partial one", () => {
    expect(nameScore("Slack automation", "Slack automation")).toBe(1);
    expect(nameScore("slack", "Slack automation")).toBeLessThan(1);
    expect(request(only(planNew("move Slack digest to Later", ix))).body).toEqual({ mission: "slack-digest", to: { lens: "later" } });
  });

  it("says what didn't match instead of guessing, and still offers to send the words to Firstmate", () => {
    const p = planNew("rename Nope to Yes", ix);
    expect(p).toMatchObject({ notes: ["There's no group called “Nope” on the map."], sure: false });
    expect(p.steps.map((s) => s.kind)).toEqual(["task"]);
    expect(planNew("rename Slack digest to Bots", ix).notes[0]).toMatch(/New renames groups/);
    expect(planNew("move jr-12 to Later", ix).notes[0]).toMatch(/A task moves only to another idea/);
    expect(planNew("move Build Joyride to Core", ix).notes[0]).toBe("“Build Joyride” is already in “Core”.");
    expect(planNew("move Slack digest to Atlantis", ix).notes[0]).toBe("There's no idea or group called “Atlantis” on the map.");
  });

  it("text that only looks like a move goes to Firstmate as it is", () => {
    const p = planNew("Move the login button to the header", ix);
    expect(p.steps.every((s) => s.kind !== "map")).toBe(true);
    expect(only(p).kind).toBe("task");
    // "a …" is something new, even when its words fit a card on the map.
    const add = planNew("Add a CSV export button to Slack digest", ix);
    expect(add).toMatchObject({ notes: [], sure: true });
    expect(only(add)).toMatchObject({ kind: "task", text: "Add a CSV export button to Slack digest" });
  });
});

describe("New planner: notes, lists and requests", () => {
  it("makes a list in a named idea, and a note in Unfiled", () => {
    const l = only(planNew("Make a list in Build Joyride: milk, eggs and bread", ix));
    expect(l).toMatchObject({ kind: "list", idea: "build-joyride", ideaTitle: "Build Joyride", lines: ["milk", "eggs", "bread"], say: "Make a list in Build Joyride: milk, eggs, bread" });
    const n = only(planNew("note: the staging key rotates on Fridays", ix));
    expect(n).toMatchObject({ kind: "note", idea: null, lines: ["the staging key rotates on Fridays"], place: { kind: "unfiled" }, say: "Save a note in Unfiled: the staging key rotates on Fridays" });
    expect(only(planNew("add a note on csv export: totals row uses tax-inclusive sums", ix))).toMatchObject({ kind: "note", idea: "csv-export" });
    expect(only(planNew("list: a, b", ix, { idea: { id: "slack-digest", title: "Slack digest" } }))).toMatchObject({ kind: "list", idea: "slack-digest", say: "Make a list in Slack digest: a, b" });
    // A list keeps its lines; they are not read as instructions.
    expect(only(planNew("checklist:\n- move Slack digest to Later\n- undo", ix)).kind).toBe("list");
  });

  it("puts a board item in the current group, a named group or idea, or Unfiled", () => {
    const current = { current: { id: "q4-bets", title: "Q4 bets" } };
    expect(only(planNew("note: rotate the keys", ix, current))).toMatchObject({ kind: "note", place: { kind: "group", id: "q4-bets" }, idea: null, say: "Save a note in Q4 bets: rotate the keys" });
    // A name in the words wins over the current group; groups and ideas both count.
    expect(only(planNew("add a note in Later: rotate the keys", ix, current))).toMatchObject({ place: { kind: "group", id: "later", title: "Later" }, lines: ["rotate the keys"] });
    expect(only(planNew("make a list in Build Joyride: a, b", ix, current))).toMatchObject({ kind: "list", place: { kind: "idea", id: "build-joyride" }, idea: "build-joyride" });
    expect(only(planNew("add a note in unfiled: rotate the keys", ix, current))).toMatchObject({ place: { kind: "unfiled" }, say: "Save a note in Unfiled: rotate the keys" });
    // New opened on an idea keeps notes there; opened on a group, in the group.
    expect(only(planNew("note: x", ix, { ...current, idea: { id: "csv-export", title: "CSV export with totals" } }))).toMatchObject({ place: { kind: "idea", id: "csv-export" } });
    expect(only(planNew("note: x", ix, { group: { id: "core", title: "Core" } }))).toMatchObject({ place: { kind: "group", id: "core" } });
    // A name that fits a group and an idea asks which.
    const both = planNew("add a note in Core: x", { ...ix, ideas: [...ix.ideas, { id: "core-idea", title: "Core", group: null, repo: null }] });
    expect(both.steps[0]).toMatchObject({ kind: "choose", say: "Where does it go?" });
    expect(both.sure).toBe(false);
  });

  it("saves links, PDFs and artifacts as link cards, and keeps a note's checkboxes and links", () => {
    const l = only(planNew("https://example.com/files/Q4-plan_v2.pdf", ix, { current: { id: "core", title: "Core" } }));
    expect(l).toMatchObject({ kind: "note", place: { kind: "group", id: "core" }, lines: ["https://example.com/files/Q4-plan_v2.pdf"], say: "Save a link in Core: Q4 plan v2" });
    expect(only(planNew("link: [Design review](https://claude.ai/artifact/abc123)", ix))).toMatchObject({ kind: "note", lines: ["[Design review](https://claude.ai/artifact/abc123)"], say: "Save a link in Unfiled: Design review" });
    expect(only(planNew("save this link https://github.com/acme/joyride/pull/12", ix)).say).toBe("Save a link in Unfiled: acme/joyride PR #12");
    expect(only(planNew("https://a.dev/pricing https://b.dev/road-map", ix)).say).toBe("Save 2 links in Unfiled: Pricing · Road map");
    const mixed = only(planNew("note: launch prep\n- [ ] book the room\nhttps://example.com/brief.pdf", ix));
    expect(mixed).toMatchObject({ kind: "note", lines: ["launch prep", "[ ] book the room", "https://example.com/brief.pdf"], say: "Save a note in Unfiled: launch prep · book the room · Brief" });
  });

  it("reads plain words on a group's + as a note for that group, but still sends work and messages", () => {
    const g = { group: { id: "core", title: "Core" } };
    const p = planNew("buy milk\ncall Sam", ix, g);
    expect(p.sure).toBe(true);
    expect(only(p)).toMatchObject({ kind: "note", place: { kind: "group", id: "core" }, lines: ["buy milk", "call Sam"] });
    expect(only(planNew("task: tidy the release notes", ix, g)).kind).toBe("task");
    expect(only(planNew("firstmate, how is the nightly?", ix, g)).kind).toBe("firstmate");
    expect(only(planNew("Move Slack automation to Q4 bets", ix, g)).kind).toBe("map");
  });

  it("sends work to Firstmate through the request flow, in the idea New was opened on", () => {
    const t = only(planNew("Fix the flaky login test on CI", ix));
    expect(t).toMatchObject({ kind: "task", idea: null, text: "Fix the flaky login test on CI", unsure: false });
    expect(only(planNew("task: tidy the release notes", ix))).toMatchObject({ kind: "task", text: "tidy the release notes" });
    expect(only(planNew("ask firstmate to rerun the nightly", ix))).toMatchObject({ kind: "task", text: "rerun the nightly" });
    expect(only(planNew("Can you add a totals row?", ix))).toMatchObject({ kind: "task" });
    expect(only(planNew("add a footer row", ix, { idea: { id: "csv-export", title: "CSV export with totals" } }))).toMatchObject({ kind: "task", idea: "csv-export", say: "New task in CSV export with totals: “add a footer row”" });
  });

  it("starts a new idea through the request flow", () => {
    const s = only(planNew("new idea: Nightly backups. Snapshot the data root every night", ix));
    expect(s).toMatchObject({ kind: "idea", title: "Nightly backups", text: "Nightly backups. Snapshot the data root every night", say: "Start a new idea “Nightly backups” and send it to Firstmate" });
  });

  it("sends updates and questions to Firstmate", () => {
    expect(only(planNew("How is the CSV export going?", ix))).toMatchObject({ kind: "firstmate", text: "How is the CSV export going?" });
    expect(only(planNew("fyi: the staging deploy is frozen until Monday", ix))).toMatchObject({ kind: "firstmate", text: "the staging deploy is frozen until Monday" });
    expect(only(planNew("tell firstmate the API key rotated", ix))).toMatchObject({ kind: "firstmate", text: "the API key rotated" });
    expect(only(planNew("tell firstmate to pause the nightly", ix))).toMatchObject({ kind: "task", text: "pause the nightly" });
    expect(planNew("How is it going?", ix).sure).toBe(true);
  });

  it("falls back to a Firstmate request when the words don't say, message first", () => {
    const p = planNew("the login page looks broken on Safari", ix);
    expect(p.sure).toBe(false);
    const c = p.steps[0];
    if (c.kind !== "choose") throw new Error("choice expected");
    expect(c.options.map((o) => o.kind)).toEqual(["firstmate", "task"]);
    expect(resolvePlan(p, { 0: 0 })).toEqual([{ kind: "firstmate", text: "the login page looks broken on Safari", say: "Send to Firstmate: “the login page looks broken on Safari”" }]);
  });

  it("does map edits and passes the rest of the words to Firstmate", () => {
    const p = planNew("Move Slack digest to Later. Also, how are the bots doing?", ix);
    expect(p.sure).toBe(false);
    const steps = resolvePlan(p, {})!;
    expect(steps.map((s) => s.kind)).toEqual(["map", "firstmate"]);
    expect(steps[1]).toMatchObject({ text: "Also, how are the bots doing?" });
  });

  it("splits clauses on lines, semicolons, sentences and then", () => {
    expect(clauses("move a to b; move c to d\nundo. Merge X into Y, then delete group Z")).toEqual(["move a to b", "move c to d", "undo", "Merge X into Y", "delete group Z"]);
    expect(planNew("", ix)).toEqual({ steps: [], notes: [], sure: false });
  });
});

describe("New planner: the map index", () => {
  it("names ideas by the group the chart puts them in, Unfiled by project, and leaves Firstmate, crew and archived work out", async () => {
    const { buildMapIndex } = await import("../../src/ui/views/new/mapIndex.ts");
    const idea = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Idea ${id}`, state: "open", archive: false, repos: [], lenses: [], sessions: [], ...extra }) as any;
    const worker = (id: string, extra: Record<string, unknown> = {}) => ({ id, session: `claude:${id}`, title: `Session ${id}`, status: "working", updated: "2026-10-05T11:00:00Z", repo: null, cwd: "/w", mission: null, crew: null, owner: { tier: "watched", task: null, via: null }, ...extra }) as any;
    const ix = buildMapIndex({
      map: {
        groups: [{ id: "core", title: "Core", missions: ["a"], sessions: ["claude:held"] }] as any,
        ideas: [idea("a"), idea("b", { repos: ["/r/bots"], sessions: [{ source: "claude", id: "in-b" }] }), idea("gone", { archive: true }), idea("done", { state: "done" })],
      },
      tasks: [{ id: "t1", title: "Task one", mission: "a" }, { id: "t2", title: "Old", mission: "a", status: "done" }],
      workers: [worker("fm"), worker("crew1", { crew: "t1" }), worker("in-b"), worker("loose", { repo: "/r/beta" }), worker("held"), worker("aside", { updated: "2026-10-05T10:00:00Z" })],
      hidden: { "claude:aside": "2026-10-05T10:30:00Z" },
      history: [],
      control: "fm",
    });
    expect(ix.ideas.map((i) => [i.id, i.group, i.repo?.title])).toEqual([["a", "core", "No repo"], ["b", null, "bots"]]);
    expect(ix.repoGroups).toEqual([{ path: "/r/bots", title: "bots" }]);
    expect(ix.tasks).toEqual([{ id: "t1", title: "Task one", idea: "a" }]);
    expect(ix.sessions.map((s) => [s.key, s.idea, s.group ?? null, !!s.hidden])).toEqual([
      ["claude:in-b", "b", null, false], ["claude:loose", null, null, false], ["claude:held", null, "core", false], ["claude:aside", null, null, true],
    ]);
    expect(ix.unfiled.map((u) => u.title).sort()).toEqual(["beta", "w"]);
    // The planner reads it: a session in the group moves by its name.
    expect(request(only(planNew("move Session loose to Core", ix))).body).toEqual({ session: "claude:loose", to: { lens: "core" } });
  });
});
