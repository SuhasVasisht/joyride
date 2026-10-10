// P-Stack adaptation and the C7 installer components, run against the sandbox's
// fake ~/.claude and ~/.codex: patched outputs carry no Cursor paths or model
// slugs, collisions are skipped, and uninstall removes only Joyride's links.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { paths } from "../../src/shared/paths.ts";
import { FIRSTMATE_PIN } from "../../src/modules/firstmate/seed.ts";
import { loadFirstmatePatches } from "../../src/modules/firstmate/vendor.ts";

const pstack = path.join(paths.vendorCheckout("cursor-plugins", process.env.JOYRIDE_CURSOR_PLUGINS_DIR), "pstack");
const hasPstack = fs.existsSync(pstack);
const hasEvals = fs.existsSync(paths.vendorCheckout("evals-skills", process.env.JOYRIDE_EVALS_SKILLS_DIR));
const hasFirstmate = fs.existsSync(paths.firstmateDir);
const vendorTitle = (title: string, available: boolean, name: string) => available ? title : `${title} (skipped: needs vendor/${name})`;

let inst: typeof import("../../src/cli/install.ts");
let out: string;
const claudeSkills = () => path.join(process.env.JOYRIDE_CLAUDE_DIR!, "skills");
const codexSkills = () => path.join(process.env.JOYRIDE_CODEX_DIR!, "skills");
const SLUG = /\b(?:claude-(?:opus|sonnet|haiku|fable)|gpt|grok)-[0-9]/;

function allText(dir: string): { rel: string; text: string }[] {
  const res: { rel: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const b = fs.readFileSync(p); if (!b.subarray(0, 8000).includes(0)) res.push({ rel: path.relative(dir, p), text: b.toString("utf8") }); }
    }
  };
  walk(dir);
  return res;
}

beforeAll(async () => {
  inst = await import("../../src/cli/install.ts");
  out = path.join(process.env.JOYRIDE_RUNTIME!, "pstack");
});

describe.skipIf(!hasPstack)(vendorTitle("pstack adaptation", hasPstack, "cursor-plugins"), () => {
  it("adapts every skill except swarm, recall, correct, reflect (and the Cursor-only make-bot-ui)", () => {
    const r = inst.adaptPstack();
    expect(r.out).toBe(path.join(out, "skills"));
    expect(Object.keys(r.skipped).sort()).toEqual(["correct", "make-bot-ui", "recall", "reflect", "swarm"]);
    for (const s of ["arena", "interrogate", "tdd", "blast-radius", "create-verification-skill", "show-me-your-work", "poteto-mode", "unslop", "setup-pstack", "how", "why"]) expect(r.skills).toContain(s);
    expect(r.skills.length).toBe(45);
    expect(r.unused).toEqual([]);
    // Whole skill dirs are copied, including playbooks, references and scripts (with their modes).
    expect(fs.existsSync(path.join(r.out, "poteto-mode", "playbooks", "orchestrate.md"))).toBe(true);
    expect(fs.existsSync(path.join(r.out, "interrogate", "references", "rubric.md"))).toBe(true);
    expect(fs.statSync(path.join(r.out, "poteto-mode", "scripts", "worktree-audit.sh")).mode & 0o111).toBeTruthy();
  });

  it("leaves no Cursor paths, model slugs, Task tool, deslop or control skills behind", () => {
    const dir = path.join(out, "skills");
    expect(inst.verifyPstack(dir)).toEqual([]);
    const files = allText(dir);
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      expect(f.text, f.rel).not.toMatch(SLUG);
      expect(f.text, f.rel).not.toMatch(/~\/\.cursor|\.cursor\/|pstack-models\.mdc|cursor-team-kit|generalPurpose/);
      expect(f.text, f.rel).not.toMatch(/\bCursor\b/);
    }
  });

  it("points model choices at the Joyride models note and maps every role to opus", () => {
    const note = inst.pstackVars().MODELS_NOTE;
    const interrogate = fs.readFileSync(path.join(out, "skills", "interrogate", "SKILL.md"), "utf8");
    expect(interrogate).toContain(`Use the \`interrogate reviewers\` line in \`${note}\``);
    expect(interrogate).toMatch(/\| Reviewer A \| `opus` \|/);
    expect(interrogate).toContain("Claude Code: the Agent tool; Codex has none, so run each one sequentially yourself");
    expect(interrogate).toContain("`subagent_type`: `general-purpose`");
    const arena = fs.readFileSync(path.join(out, "skills", "arena", "SKILL.md"), "utf8");
    expect(arena).toContain("default to one each on `opus`, `opus`, `opus`");
    const setup = fs.readFileSync(path.join(out, "skills", "setup-pstack", "SKILL.md"), "utf8");
    expect(setup).toContain(`Edit \`${note}\``);
    const template = fs.readFileSync(path.join(process.cwd(), "install", "pstack-patches", "pstack-models.md"), "utf8");
    const roles = template.split("\n").filter((l) => /^[a-z].*: /.test(l));
    expect(roles.length).toBe(15);
    for (const l of roles) expect(l.split(": ")[1].split(/,\s*/).every((v) => v === "opus"), l).toBe(true);
  });

  it("strips Cursor-only frontmatter, keeps poteto-agent, routes deslop to unslop and control skills to real-surface evidence", () => {
    const poteto = fs.readFileSync(path.join(out, "skills", "poteto-mode", "SKILL.md"), "utf8");
    const fm = poteto.split("---")[1];
    expect(fm).toMatch(/^\s*name: poteto-mode$/m);
    expect(fm).not.toMatch(/^(mode|icon|color|reminder):/m);
    expect(poteto).toContain('subagent_type: "poteto-agent"');
    expect(poteto).toContain("the **unslop** skill (`/unslop`)");
    expect(poteto).toContain("verification on the real surface (Playwright for web UIs, run the CLI), recorded with the **joyride-evidence** skill");
    const noComments = fs.readFileSync(path.join(out, "skills", "no-comments", "SKILL.md"), "utf8");
    expect(noComments).toContain('subagent_type: "comment-sicko"');
    const audit = fs.readFileSync(path.join(out, "skills", "poteto-mode", "scripts", "worktree-audit.sh"), "utf8");
    expect(audit).toContain('transcripts="$HOME/.claude/projects/$slug"');
  });

  it("adapts pstack agents to Claude Code's agent format with a removal marker", () => {
    const patches = inst.loadPstackPatches();
    const src = fs.readFileSync(path.join(pstack, "agents", "comment-sicko.md"), "utf8");
    const a = inst.adaptAgent(src, patches.agents["comment-sicko.md"], inst.pstackVars());
    expect(a).toMatch(/^---\nname: comment-sicko\ndescription: ".+"\nmodel: opus\ntools: Read, Grep, Glob, Bash, Edit, MultiEdit, Skill\n---\n/);
    expect(a).toContain("I hate comments.");
    expect(a).toContain("joyride-managed: pstack agent");
    const p = inst.adaptAgent(fs.readFileSync(path.join(pstack, "agents", "poteto-agent.md"), "utf8"), patches.agents["poteto-agent.md"], inst.pstackVars());
    expect(p).not.toMatch(/is_background|generalPurpose|^tools:/m);
    expect(p).toContain(path.join(inst.pstackVars().CLAUDE_SKILLS, "poteto-mode", "SKILL.md"));
  });
});

describe("installer components (sandboxed ~/.claude and ~/.codex)", () => {
  it.skipIf(!hasPstack)(vendorTitle("pstack links adapted skills, skips collisions, and uninstall removes only its links", hasPstack, "cursor-plugins"), () => {
    // A user's own skill with a pstack name must survive.
    fs.mkdirSync(path.join(claudeSkills(), "tdd"), { recursive: true });
    fs.writeFileSync(path.join(claudeSkills(), "tdd", "SKILL.md"), "mine");
    const lines = inst.components.pstack.install();
    expect(lines.join("\n")).toContain(`collisions skipped: ${path.join(claudeSkills(), "tdd")}`);
    expect(fs.readFileSync(path.join(claudeSkills(), "tdd", "SKILL.md"), "utf8")).toBe("mine");
    expect(fs.readlinkSync(path.join(claudeSkills(), "arena"))).toBe(path.join(out, "skills", "arena"));
    expect(fs.readlinkSync(path.join(codexSkills(), "tdd"))).toBe(path.join(out, "skills", "tdd"));
    expect(fs.existsSync(path.join(claudeSkills(), "swarm"))).toBe(false);
    expect(fs.existsSync(inst.pstackVars().MODELS_NOTE)).toBe(true);
    expect(inst.components.pstack.status()).toBe("44 skills linked");
    inst.components.pstack.uninstall();
    expect(fs.existsSync(path.join(claudeSkills(), "arena"))).toBe(false);
    expect(fs.readFileSync(path.join(claudeSkills(), "tdd", "SKILL.md"), "utf8")).toBe("mine");
    fs.rmSync(path.join(claudeSkills(), "tdd"), { recursive: true });
  });

  it.skipIf(!hasPstack)(vendorTitle("agents writes marked Claude Code agents and removes only those", hasPstack, "cursor-plugins"), () => {
    inst.components.agents.install();
    const f = path.join(process.env.JOYRIDE_CLAUDE_DIR!, "agents", "poteto-agent.md");
    expect(fs.readFileSync(f, "utf8")).toMatch(/^---\nname: poteto-agent\n/);
    const mine = path.join(process.env.JOYRIDE_CLAUDE_DIR!, "agents", "mine.md");
    fs.writeFileSync(mine, "---\nname: mine\n---\n");
    inst.components.agents.uninstall();
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(mine)).toBe(true);
  });

  it.skipIf(!hasEvals)(vendorTitle("evals adds missing skills to Claude Code and mirrors all nine into Codex with relative links", hasEvals, "evals-skills"), () => {
    fs.mkdirSync(path.join(claudeSkills(), "evals-start"), { recursive: true });
    fs.writeFileSync(path.join(claudeSkills(), "evals-start", "SKILL.md"), "older copy");
    const lines = inst.components.evals.install().join("\n");
    expect(lines).toContain("differ from the pin (not replaced): evals-start");
    expect(fs.readlinkSync(path.join(claudeSkills(), "write-code-eval"))).toMatch(/vendor\/evals-skills\/skills\/write-code-eval$/);
    expect(fs.readlinkSync(path.join(codexSkills(), "write-code-eval"))).toBe("../../claude/skills/write-code-eval");
    expect(fs.readFileSync(path.join(codexSkills(), "evals-start", "SKILL.md"), "utf8")).toBe("older copy");
    expect(inst.components.evals.status()).toBe("claude 9/9, codex 9/9");
    inst.components.evals.uninstall();
    expect(fs.existsSync(path.join(codexSkills(), "evals-start"))).toBe(false);
    expect(fs.existsSync(path.join(claudeSkills(), "write-code-eval"))).toBe(false);
    expect(fs.readFileSync(path.join(claudeSkills(), "evals-start", "SKILL.md"), "utf8")).toBe("older copy");
  });

  it.skipIf(!hasFirstmate)(vendorTitle("firstmate checks the pin and seeds FM_HOME for herdr and local-only", hasFirstmate, "firstmate"), () => {
    const lines = inst.components.firstmate.install().join("\n");
    expect(lines).toContain(`vendor/firstmate at pin ${FIRSTMATE_PIN.slice(0, 7)} with Joyride's patches (${loadFirstmatePatches().patches.map((p) => p.id).join(", ")})`);
    expect(lines).not.toContain("WARNING");
    const home = path.join(process.env.JOYRIDE_RUNTIME!, "firstmate");
    expect(fs.readFileSync(path.join(home, "config", "backend"), "utf8").trim()).toBe("herdr");
    expect(fs.readFileSync(path.join(home, "config", "crew-harness"), "utf8").trim()).toBe("claude");
    expect(fs.readFileSync(path.join(home, "data", "captain.md"), "utf8")).toMatch(/local-only.*Never push/s);
    expect(fs.readFileSync(path.join(home, "config", "brief-include.md"), "utf8")).toContain("joyride-evidence");
    expect(fs.readFileSync(path.join(home, "config", "brief-include.md"), "utf8")).not.toMatch(/Delivery contract: mode=/);
    // Idempotent and never overwrites edits.
    fs.writeFileSync(path.join(home, "data", "captain.md"), "edited");
    expect(inst.components.firstmate.install().join("\n")).toContain("kept");
    expect(fs.readFileSync(path.join(home, "data", "captain.md"), "utf8")).toBe("edited");
  });
});
