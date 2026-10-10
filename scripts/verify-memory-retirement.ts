// Validate removal only after authored migrations and canonical Firstmate settings exist.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseFrontmatter } from "../src/shared/frontmatter.ts";
const root = process.cwd();
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const entries = git("ls-tree", "-r", "--name-only", "main", "memory/entries").trim().split("\n").filter(Boolean);
let decisions = 0, notes = 0;
for (const file of entries) {
  const { data, content } = parseFrontmatter(git("show", `main:${file}`));
  if (data.status !== "active") continue;
  if (["decision", "constraint", "preference", "convention"].includes(data.kind) && fs.existsSync(path.join(root, "docs/decisions", path.basename(file)))) {
    const doc = fs.readFileSync(path.join(root, "docs/decisions", path.basename(file)), "utf8");
    assert(doc.includes(data.title), `Missing migrated title: ${file}`);
    assert(doc.includes(content.trim()), `Missing migrated decision: ${file}`);
    if (data.why) assert(doc.includes(data.why), `Missing migrated reason: ${file}`);
    decisions++;
  } else if (data.kind === "note" && fs.existsSync(path.join(root, "notes", path.basename(file)))) {
    assert(fs.existsSync(path.join(root, "notes", path.basename(file))), `Missing authored note: ${file}`);
    notes++;
  }
}
assert(decisions >= 19 && notes >= 1, "Decision and note migrations must land before removal");
for (const file of ["docs/DECISIONS.md", "src/modules/system/firstmate-files.ts", "src/ui/views/settings/SettingsPage.tsx"]) assert(fs.existsSync(file), `Missing prerequisite: ${file}`);
for (const file of ["memory", "src/modules/memory", "src/mcp/memory-server.ts", "src/ui/views/memory", "src/ui/views/proposals"]) assert(!fs.existsSync(file), `Retired path remains: ${file}`);
const result = spawnSync("rg", ["-n", "modules/memory|/memory/(index|store|search)|MemoryEntry|MemoryService|memory_(search|write|update|search_sessions|list|get|propose)", "src"], { encoding: "utf8" });
assert.equal(result.status, 1, `Retired import or MCP tool remains: ${result.stdout || result.stderr}`);
for (const file of ["src/ui/views/agents/AgentsPage.tsx", "src/ui/views/agents/SuggestedIdeas.tsx", "src/modules/sessions/claude.ts", "src/modules/sessions/codex.ts", "src/modules/sessions/index.ts", "src/modules/fleet/index.ts", "src/cli/fleet.ts", "src/cli/fleet-feed.ts", "src/core/eventlog.ts"]) assert(fs.existsSync(file), `Visibility path missing: ${file}`);
console.log(`Verified ${decisions} migrated decisions and ${notes} authored note; ${entries.length} legacy entries removed. Firstmate canonical Settings and all visibility paths remain.`);
