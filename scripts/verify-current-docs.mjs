// T11: current documentation checks. Historical records remain verbatim.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const topDocs = fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`);
const decisions = fs.readdirSync(path.join(root, 'docs/decisions')).filter((name) => name.endsWith('.md')).map((name) => `docs/decisions/${name}`);
const ownSkills = ['skills/joyride-evidence/SKILL.md', 'skills/joyride-verify/SKILL.md'];
const superseded = decisions.filter((file) => /^State: superseded/m.test(read(file)));
const current = [...topDocs, ...decisions.filter((file) => !superseded.includes(file)), 'AGENTS.md', ...ownSkills];
const retired = /memory_search|memory[ _-]digests?|MCP memory|memory MCP|deep[ -]dives?|hill[ -]?climb(?:ing)?|workspace evolution|\/api\/(?:memory|dives|hillclimb|learnings|capabilities|query)(?:\b|\/)|start_dive|evolve_spec|evolve_code/i;
for (const file of current) {
  // The decision index retains a labelled historical section with original titles.
  const indexed = file === 'docs/DECISIONS.md' ? read(file).split('## Superseded decisions')[0] : read(file);
  const content = indexed.replace(/^Supersedes:.*$/gm, '');
  assert(!retired.test(content), `Retired feature in current documentation: ${file}`);
}
for (const file of ['docs/DECISIONS.md', ...decisions]) {
  for (const match of read(file).matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
    assert(fs.existsSync(path.resolve(root, path.dirname(file), match[1])), `Broken decision link: ${file} -> ${match[1]}`);
  }
}
for (const match of read('docs/API.md').matchAll(/\| (src\/[^ |]+) \|/g)) {
  assert(fs.existsSync(path.join(root, match[1])), `API refers to absent source: ${match[1]}`);
}
for (const file of ['src/ui/views/agents/contribute.tsx', 'src/modules/sessions/index.ts', 'src/modules/missions/index.ts', 'src/modules/fleet/index.ts', 'src/cli/fleet.ts', 'src/core/eventlog.ts', 'install/firstmate-extension/joyride-fleet-feed']) {
  assert(fs.existsSync(path.join(root, file)), `Preserved fleet/session component missing: ${file}`);
}
console.log(`Current docs: ${current.length} files passed; decision links and API sources resolve; preserved fleet/session components exist.`);
console.log(`Deliberate exclusions: docs/checkpoints/**, docs/audits/**, docs/reviews/**; ${superseded.length} superseded decisions and the historical decision-index section; unrelated third-party skills.`);
