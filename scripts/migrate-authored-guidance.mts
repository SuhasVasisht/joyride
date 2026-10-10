// T2/T4 copy migration. Run with --check to prove every source body survives.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { loadEntries, parseFrontmatter } from "../src/modules/memory/store.ts";
import { migrateNoteFiles, readNoteFile } from "../src/shared/note-files.ts";
import { paths } from "../src/shared/paths.ts";
import { commitPaths } from "../src/core/gitstore.ts";

const check = process.argv.includes("--check");
const entries = loadEntries(paths.memory);
assert.equal(entries.errors.length, 0, JSON.stringify(entries.errors));
const decisions = entries.entries.filter(e => /^(dec|con)-/.test(e.id) && e.status === "active" && e.scope === "repo:joyride");
const notes = entries.entries.filter(e => e.kind === "note");
const dir = path.join(paths.root, "docs/decisions");
const indexFile = path.join(paths.root, "docs/DECISIONS.md");
const proposed = [
  ["dec-knowledge-as-sources", "Knowledge is sources, not distillates"],
  ["dec-six-nouns-three-places", "Six nouns and three places for guidance"],
];
if (!check) {
  fs.mkdirSync(dir, { recursive: true });
  for (const e of decisions) {
    const file = path.join(dir, `${e.id}.md`);
    const text = `# ${e.title}\n\nDate: ${e.created}\nSupersedes: ${e.supersedes.join(", ") || "None"}\n\n## Decision\n\n${e.body}\n`;
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
  }
  const index = `# Decisions\n\nActive captain decisions copied from memory entries. Each document retains the original decision and why. The source entries remain in place pending confirmation of T5. Proposed decisions from the first-principles review are labelled below.\n\n| id | kind | decision |\n|---|---|---|\n${decisions.map(e => `| [${e.id}](decisions/${e.id}.md) | ${e.kind} | ${e.title} |`).join("\n")}\n\n## Proposed decisions\n\nThese proposals come from the 2026-10-05 first-principles review and await the captain's confirmation.\n\n| id | state | decision |\n|---|---|---|\n${proposed.map(([id,title]) => `| [${id}](decisions/${id}.md) | proposed | ${title} |`).join("\n")}\n`;
  fs.writeFileSync(indexFile, index);
  fs.writeFileSync(path.join(dir, "dec-knowledge-as-sources.md"), `# Knowledge is sources, not distillates\n\nDate: 2026-10-05\nState: proposed\nSupersedes: None until confirmed\n\n## Decision\n\nKeep sources findable through artifact cards, notes and search. Keep procedures in skills and repo facts in repo instructions and docs. Stop distilling artifacts into a separate knowledge store.\n\n## Why\n\nThe first-principles review found that distillation produces lossy copies that agents rarely read and that can drift from the original source. Authored intent and direct source links retain what people and agents need.\n`);
  fs.writeFileSync(path.join(dir, "dec-six-nouns-three-places.md"), `# Six nouns and three places for guidance\n\nDate: 2026-10-05\nState: proposed\nSupersedes: None until confirmed\n\n## Decision\n\nOrganize work as Idea, Group, Note, Session, Task and Artifact. Keep guidance in repo AGENTS.md/CLAUDE.md and docs/, the skills/ tree, and the captain's preference file. Keep evidence records as proof.\n\n## Why\n\nPeople and agents can read the same authored files and follow the same links. These concepts describe work and its outputs without adding a second knowledge lifecycle or a separate agent mode.\n`);
  const migration = migrateNoteFiles(paths.memory, paths.notes);
  assert.deepEqual(migration.errors, []);
  commitPaths([indexFile, dir, ...migration.files], "guidance: copy active decisions and notes into authored files");
}
const index = fs.readFileSync(indexFile, "utf8");
for (const e of decisions) {
  const text = fs.readFileSync(path.join(dir, `${e.id}.md`), "utf8");
  assert.equal(text.split("\n## Decision\n\n")[1]?.trim(), e.body, e.id);
  assert.ok(text.includes(e.title) && text.includes(e.created) && e.supersedes.every(id => text.includes(id)), e.id);
  assert.ok(index.includes(`decisions/${e.id}.md`), e.id);
}
for (const match of index.matchAll(/\]\(([^)]+)\)/g)) assert.ok(fs.existsSync(path.resolve(path.dirname(indexFile), match[1])), match[1]);
for (const e of notes) {
  const copied = readNoteFile(paths.notes, e.id);
  assert.ok(copied, e.id);
  assert.equal(copied.body, e.body, e.id);
  for (const key of ["id", "title", "scope", "status", "created", "provenance"] as const) assert.deepEqual(copied[key], e[key], `${e.id} ${key}`);
  // Reading the retained source also checks that migration did not delete it.
  assert.equal(parseFrontmatter(fs.readFileSync(path.join(paths.memory, `${e.id}.md`), "utf8")).content.trim(), e.body);
}
console.log(`Lossless copy verified: ${decisions.length} active decisions, ${notes.length} notes; all index links resolve.`);
