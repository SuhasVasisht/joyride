import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { KnowledgeSearch } from "../../src/shared/knowledge.ts";
import { buildFirstmateHome, FIXTURE_TASKS } from "./crew-fixture";

const port = Number(process.env.E2E_PORT ?? 4399);
if (port === 4317 || port === 3000) throw new Error("Search e2e requires a private port.");
const sandbox = `/tmp/joyride-e2e-${port}`;
const idea = "search-api", term = "heliograph";
test("Search indexes ideas, notes, artifacts, sessions and Firstmate tasks without memory", async ({ request }) => {
  buildFirstmateHome(path.join(sandbox, "runtime/firstmate"), idea);
  expect((await request.post("/api/missions", { data: { id: idea, title: `${term} idea`, crews: [FIXTURE_TASKS.ship] } })).status()).toBe(201);
  const note = await (await request.post("/api/notes", { data: { task: FIXTURE_TASKS.ship, bullets: [`${term} note`] } })).json();
  const file = path.join(sandbox, "home/search-report.md");
  fs.writeFileSync(file, `# Report\n\n${term} heading-only finding\n`);
  const artifact = await (await request.post("/api/artifacts", { data: { title: "A report", local_source: file, mission: idea, kind: "report" } })).json();
  const search = async (query: string): Promise<KnowledgeSearch> => (await request.get(`/api/knowledge/search?${query}`)).json();
  await expect.poll(async () => (await search(`q=${term}`)).items.map(i => i.key)).toEqual(expect.arrayContaining([`idea:${idea}`, `note:${note.id}`, `artifact:${artifact.id}`]));
  await expect.poll(async () => (await search("types=tasks")).items.map(i => i.ref.id)).toContain(FIXTURE_TASKS.ship);
  expect((await search("types=sessions")).total).toBeGreaterThan(0);
  expect((await search(`types=notes&task=${FIXTURE_TASKS.ship}`)).items.map(i => i.ref.id)).toContain(note.id);
  expect((await search(`q=${term}`)).items.every(i => String(i.ref.entity) !== "memory" && i.review.length === 0)).toBe(true);
  expect((await request.get("/api/memory")).status()).toBe(404);
  expect((await request.get("/api/knowledge/search?types=rules")).status()).toBe(400);
});
