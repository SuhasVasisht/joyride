import { expect, type Page } from "@playwright/test";
import { Mission, SessionView, WorkerView } from "../../src/shared/schema";
import type { MissionH, MapArtifact } from "../../src/ui/views/map/world";
import type { FirstmateStatus } from "../../src/ui/views/crew/crew";

const now = "2026-10-05T12:00:00.000Z";
const titles = [
  "Hi there, organize the Documents workspace and its active sessions",
  "We need to validate every workflow before the product launch",
  "Understand the document ingestion pipeline and its failure states",
  "Build evidence for the new session management experience",
  "Evolve: Add a keyboard shortcut to move between active missions",
  "Review the joyride map and keep every cluster title readable",
  "Validate nightly model evaluation results against human labels",
  "Slack automation for the product launch coordination workflow",
  "Define the digital twin simulation contract across all services",
  "Firstmate agent dossier and reports for the development fleet",
];
const repos = ["Documents", "Documents", "Documents", "Documents", "add-a-keyboard-shortcut", "joyride", "telemetry-store", "product-docs", "digital_twin", "feature-reports"];
const missions: MissionH[] = titles.map((title, i) => ({
  ...Mission.parse({ id: `zoom-${i}`, title, repos: [`/fixture/${repos[i]}`], created: now, updated: now,
    sessions: Array.from({ length: 3 }, (_, j) => ({ source: "claude", id: `zoom-${i}-${j}` })),
    done_when: [{ id: "visual", text: "The map stays readable", kind: "screenshot" }],
  }), health: i % 3 === 0 ? "needs-review" : "active", health_why: "Waiting for the recorded evidence review",
}));
const workers = missions.flatMap((m, i) => m.sessions.map((s, j) => WorkerView.parse({
  id: `local:zoom-${i}-${j}`, agent: "claude", status: "working", pane: `zoom-${i}-${j}`, pid: null,
  cwd: m.repos[0], repo: m.repos[0], session: `${s.source}:${s.id}`, mission: m.id,
  title: `Validate ${repos[i]} session ${j + 1} and collect visual evidence`, updated: now, controllable: true,
  current_action: "Read the implementation and compare rendered bounds", last_message: "Recorded screenshots and checked the session details.",
  owner: { tier: j === 0 ? "crew" : "watched", task: j === 0 ? `task-${i}` : null, via: j === 0 ? "pane" : null },
  helm: { by: j === 1 ? "captain" : "firstmate" },
})));
workers.push(WorkerView.parse({ id: "local:control", agent: "claude", status: "idle", pane: "control", pid: null,
  cwd: "/fixture/firstmate", repo: null, session: null, title: "Firstmate", updated: now, controllable: true,
  owner: { tier: "control", via: "control" },
}));
for (const repo of ["Documents"]) workers.push(WorkerView.parse({
  id: `local:unfiled-${repo}`, agent: "codex", status: "working", pane: `unfiled-${repo}`, pid: null,
  cwd: `/fixture/${repo}`, repo: `/fixture/${repo}`, session: `codex:unfiled-${repo}`,
  title: `Review ${repo} session navigation and map layout`, updated: now, controllable: true, helm: { by: "captain" },
}));
const sessions = ["joyride"].flatMap((repo) => Array.from({ length: 3 }, (_, i) => SessionView.parse({
  key: `claude:recent-${repo}-${i}`, source: "claude", id: `recent-${repo}-${i}`, title: `Review ${repo} historical session ${i + 1} and its linked artifacts`,
  cwd: `/fixture/${repo}`, repo: `/fixture/${repo}`, branch: "main", started: now, updated: now, transcript: "/fixture/session.jsonl",
})));
const artifacts: MapArtifact[] = [...workers.filter((w) => w.session).map((w) => ({ session: w.session, mission: w.mission })),
  ...missions.map((m) => ({ mission: m.id, session: null })), ...sessions.map((s) => ({ session: s.key, mission: null }))]
  .flatMap((link, i) => Array.from({ length: 5 }, (_, j) => ({ ...link, id: `zoom-art-${i}-${j}`, title: `Evidence report ${j + 1} for the map layout review`,
    kind: j % 2 ? "claude-artifact" : "report", url: null, created: now })));
const firstmate: FirstmateStatus = {
  home: "/fixture/firstmate", home_exists: true, configured: true, backend: "claude", running: true,
  pane: { machine: "local", pane_id: "control", worker: "local:control", status: "idle" }, herdr_connected: true,
  vendor: { path: "/fixture/firstmate", present: true, head: null, pin: "fixture", pinned: true },
  tasks: { total: 10, in_flight: 2, queued: 8, done: 0, for_missions: 10 }, summary: { state: "idle", decisions_open: 0 },
  setup: { missing_tools: [], notes: [] }, errors: [],
};

/** Many projects with unfiled work: a chart taller than any window at the old zoom floor. */
const tallWorkers = Array.from({ length: 36 }, (_, i) => WorkerView.parse({
  id: `local:tall-${i}`, agent: i % 2 ? "codex" : "claude", status: "working", pane: `tall-${i}`, pid: null,
  cwd: `/fixture/project-${i}`, repo: `/fixture/project-${i}`, session: `claude:tall-${i}`,
  title: `Keep project ${i} moving and report what changed`, updated: now, controllable: true, helm: { by: "firstmate" },
}));

export async function seedDenseMap(page: Page, tall = false) {
  // Deterministic read projections on the isolated sandbox's real map renderer.
  const responses = new Map<string, unknown>([
    ["/api/missions", missions], ["/api/workers", tall ? [...workers, ...tallWorkers] : workers], ["/api/lenses", []], ["/api/artifacts", artifacts],
    ["/api/sessions", sessions], ["/api/attention", []], ["/api/evidence/verdicts", []],
    ["/api/firstmate/status", firstmate], ["/api/firstmate/tasks", []], ["/api/missions/proposals", []],
    ["/api/workspace/spec", { home: { group_by: "repo" } }], ["/api/intentions", { items: [], pending: [] }],
    ["/api/asks", { asks: [], counts: { needs_you: 0 } }], ["/api/firstmate/replies", []],
  ]);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (responses.has(pathname)) await route.fulfill({ json: responses.get(pathname) });
    else await route.continue();
  });
  await page.goto("/");
  await expect(page.locator("[data-mission]")).toHaveCount(10);
  await expect(page.getByTestId("firstmate-node")).toHaveAttribute("data-firstmate", "running");
  // Unfiled boxes hold live work only: the fixture's finished joyride sessions leave the chart.
  await expect(page.locator(".region-label.k-unfiled")).toHaveCount(tall ? 37 : 1);
}
