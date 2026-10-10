import { expect, type Page } from "@playwright/test";
import { Mission, WorkerView } from "../../src/shared/schema";
import type { CrewTask, FirstmateStatus } from "../../src/ui/views/crew/crew";
import type { Note } from "../../src/ui/components/notes/notes";

const now = "2026-10-05T12:00:00.000Z";
const missions = Array.from({ length: 13 }, (_, i) => ({ ...Mission.parse({
  id: `render-${i}`, title: `Project ${i + 1}: Validate the launch workflows and record visual evidence`,
  repos: [`/fixture/project-${Math.floor(i / 3)}`], created: now, updated: now,
  sessions: Array.from({ length: 3 }, (_, j) => ({ source: "claude", id: `render-${i}-${j}` })),
}), health: "active", health_why: "Implementation and validation are underway" }));
const workers = missions.flatMap((m, i) => m.sessions.map((s, j) => WorkerView.parse({
  id: `local:render-${i}-${j}`, agent: "claude", status: "working", pane: `render-${i}-${j}`, pid: null,
  cwd: m.repos[0], repo: m.repos[0], session: `claude:${s.id}`, mission: m.id, updated: now,
  title: `Review project ${i + 1} workflow ${j + 1} and its recorded evidence`, controllable: true,
  current_action: "Read the implementation and compare rendered bounds with the design",
  last_message: "Recorded screenshots and checked every session detail before continuing.",
  owner: { tier: j === 0 ? "crew" : "watched", task: j === 0 ? `render-task-${i}-0` : null, via: j === 0 ? "pane" : null },
  helm: { by: "firstmate" },
})));
const tasks: CrewTask[] = missions.flatMap((m, i) => Array.from({ length: 2 }, (_, j) => ({
  id: `render-task-${i}-${j}`, title: `Review project ${i + 1} ${j ? "release evidence and accessibility" : "rendering and camera interactions"}`,
  status: "working", kind: "ship", harness: "claude", model: "claude-opus", effort: "high", account: "claude-1",
  worktree: `/fixture/task-${i}-${j}`, branch: null, last_event: "working: checking the recorded evidence against the acceptance criteria",
  updated: now, report: null, depends_on: [], mission: m.id, section: "in_flight", repo: m.repos[0], mode: null,
  window: null, hold: null, inbox_pending: 0, workers: [],
})));
const artifacts = missions.flatMap((m, i) => Array.from({ length: 15 }, (_, j) => ({
  id: `render-artifact-${i}-${j}`, title: `Project ${i + 1} workflow ${j + 1} evidence and validation report`,
  kind: "report", mission: m.id, session: j < 12 ? `claude:render-${i}-${j % 3}` : null, url: null, created: now,
})));
const notes: Note[] = missions.flatMap((m, i) => Array.from({ length: 3 }, (_, j) => ({
  id: `render-note-${i}-${j}`, kind: "note", title: "Review notes", body: "", status: "active", created: now, updated: now,
  anchor: { kind: "mission", id: m.id }, scope: `mission:${m.id}`,
  bullets: ["Keep every interaction readable and responsive", "Compare against the fresh render before shipping", "Attach the evidence to the launch review"],
})));
const firstmate: FirstmateStatus = {
  home: "/fixture/firstmate", home_exists: true, configured: true, backend: "claude", running: true,
  pane: { machine: "local", pane_id: "control", worker: "local:control", status: "idle" }, herdr_connected: true,
  vendor: { path: "/fixture/firstmate", present: true, head: null, pin: "fixture", pinned: true },
  tasks: { total: 26, in_flight: 26, queued: 0, done: 0, for_missions: 26 }, summary: { state: "idle", decisions_open: 0 },
  setup: { missing_tools: [], notes: [] }, errors: [],
};

/** Larger than the reported live map: 13 ideas, 39 workers, 26 tasks, 39 notes, 195 artifacts. */
export async function seedRealisticMap(page: Page) {
  const responses = new Map<string, unknown>([
    ["/api/missions", missions], ["/api/workers", workers], ["/api/lenses", []], ["/api/artifacts", artifacts],
    ["/api/sessions", []], ["/api/attention", []], ["/api/evidence/verdicts", []], ["/api/missions/proposals", []],
    ["/api/firstmate/status", firstmate], ["/api/firstmate/tasks", tasks], ["/api/firstmate/replies", []],
    ["/api/workspace/spec", { home: { group_by: "repo" } }], ["/api/intentions", { items: [], pending: [] }],
    ["/api/asks", { asks: [], counts: { needs_you: 0 } }],
  ]);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/notes") await route.fulfill({ json: url.searchParams.has("limit") ? notes : notes.filter((n) => n.scope === `mission:${url.searchParams.get("idea")}`) });
    else if (responses.has(url.pathname)) await route.fulfill({ json: responses.get(url.pathname) });
    else await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("[data-mission]")).toHaveCount(13);
  await page.evaluate(() => document.fonts.ready);
}
