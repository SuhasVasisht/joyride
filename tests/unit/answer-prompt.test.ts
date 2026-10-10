import { readFileSync } from "node:fs";
import { menuBlock } from "../../src/modules/live/screen.ts";
import { describe, it, expect } from "vitest";
import { pickOption, promptOf } from "../../src/modules/live/intents.ts";

const claudeMenu = `
 Bash command
   git push origin main
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for git push commands in /repo
   3. No, and tell Claude what to do differently (esc)
`;
describe("pickOption", () => {
  it("maps choices onto Claude Code's numbered permission menu", () => {
    expect(pickOption(claudeMenu, "allow")).toEqual({ keys: ["1"], label: "Yes" });
    expect(pickOption(claudeMenu, "allow_always")?.keys).toEqual(["2"]);
    expect(pickOption(claudeMenu, "deny")?.keys).toEqual(["3"]);
  });
  it("handles y/n prompts", () => {
    expect(pickOption("Overwrite file? (y/n)", "allow")?.keys).toEqual(["y", "enter"]);
    expect(pickOption("Overwrite file? (y/n)", "deny")?.keys).toEqual(["n", "enter"]);
  });
  it("navigates arrow-cursor menus like Claude Code's folder trust dialog", () => {
    const trust = ` Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`;
    expect(pickOption(trust, "allow")).toEqual({ keys: ["down", "enter"], label: "Yes, I trust this folder" });
    expect(pickOption(trust, "deny")).toEqual({ keys: ["enter"], label: "No, exit" });
  });
  it("returns null when there is no recognizable prompt", () => {
    expect(pickOption("Compiling…\nDone in 3s", "allow")).toBeNull();
  });
});

describe("strict options and the prompt record", () => {
  it("strict never falls back to the first or last option", () => {
    const odd = " Pick a branch\n ❯ 1. main\n   2. release\n";
    expect(pickOption(odd, "allow")?.keys).toEqual(["1"]);
    expect(pickOption(odd, "allow", { strict: true })).toBeNull();
    expect(pickOption(odd, "deny", { strict: true })).toBeNull();
    expect(pickOption(claudeMenu, "allow", { strict: true })).toEqual({ keys: ["1"], label: "Yes" });
    expect(pickOption(claudeMenu, "deny", { strict: true })?.keys).toEqual(["3"]);
  });
  it("records the question above the options and every option offered", () => {
    expect(promptOf(claudeMenu)).toEqual({
      question: "Bash command git push origin main Do you want to proceed?",
      options: ["1. Yes", "2. Yes, and don't ask again for git push commands in /repo", "3. No, and tell Claude what to do differently (esc)"],
    });
    const boxed = ["╭──────────╮", "│ Bash command │", "│   rm -rf build   │", "│ Do you want to proceed? │", "│ ❯ 1. Yes │", "│   2. No │", "╰──────────╯"].join("\n");
    expect(promptOf(boxed)).toEqual({ question: "Bash command rm -rf build Do you want to proceed?", options: ["1. Yes", "2. No"] });
    expect(promptOf("Overwrite file? (y/n)")).toEqual({ question: "Overwrite file? (y/n)", options: ["y", "n"] });
    // Claude Code 2.1.289's menu, as the Herdr lab showed it: a tip line and dashed rules around the command.
    const real = [" Bash command", "", ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below', "   Lab command", ` ${"╌".repeat(60)}`, "   touch alpha-approved.txt", ` ${"╌".repeat(60)}`, " Do you want to proceed?",
      " ❯ 1. Yes", "   2. Yes, and always allow access to", "   3. Yes, and switch to auto mode · auto mode handles these prompts for you", "   4. No", "", " Esc to cancel · Tab to amend"].join("\n");
    expect(promptOf(real)).toEqual({ question: "Lab command touch alpha-approved.txt Do you want to proceed?", options: ["1. Yes", "2. Yes, and always allow access to", "3. Yes, and switch to auto mode · auto mode handles these prompts for you", "4. No"] });
    expect(pickOption(real, "allow", { strict: true })).toEqual({ keys: ["1"], label: "Yes" });
    expect(pickOption(real, "deny", { strict: true })).toEqual({ keys: ["4"], label: "No" });
    expect(promptOf("Compiling…\nDone")).toBeNull();
  });
});

describe("the prompt's own menu, not the transcript above it", () => {
  // A plan the agent wrote, then Claude Code's permission menu: "2" in the plan is not "2" in the menu.
  const planThenMenu = [
    "⏺ Here's the plan:", "  1. Remove the deprecated flag", "  2. No-op the legacy handler", "",
    " Bash command", "   rm -rf build", " Do you want to proceed?",
    " ❯ 1. Yes", "   2. Yes, and don't ask again for rm commands in /repo", "   3. No, and tell Claude what to do differently (esc)", "", " Esc to cancel",
  ].join("\n");
  it("picks only from the last menu that counts up from 1", () => {
    expect(pickOption(planThenMenu, "deny", { strict: true })).toEqual({ keys: ["3"], label: "No, and tell Claude what to do differently (esc)" });
    expect(pickOption(planThenMenu, "allow", { strict: true })).toEqual({ keys: ["1"], label: "Yes" });
    expect(promptOf(planThenMenu)).toEqual({ question: "Bash command rm -rf build Do you want to proceed?", options: ["1. Yes", "2. Yes, and don't ask again for rm commands in /repo", "3. No, and tell Claude what to do differently (esc)"] });
  });
  it("finds no prompt in a numbered list the agent wrote, or a menu far from the bottom", () => {
    const listOnly = "⏺ Next steps:\n  1. Yes, ship it\n  2. No, wait for review\n\n✻ Done";
    expect(pickOption(listOnly + "\n" + "x\n".repeat(6), "allow", { strict: true })).toBeNull();
    expect(pickOption("⏺ Steps:\n  2. Second\n  3. Third\n", "allow", { strict: true })).toBeNull(); // does not count up from 1
  });
  it("answers a y/n question only on the last lines, and never as always", () => {
    expect(pickOption("Overwrite file? (y/n)", "allow", { strict: true })).toEqual({ keys: ["y", "enter"], label: "y" });
    expect(pickOption("Overwrite file? (y/n)", "allow_always", { strict: true })).toBeNull();
    expect(pickOption("Earlier: Overwrite? (y/n)\nline\nline\nline\nnow working", "allow", { strict: true })).toBeNull();
  });
});

const fixture = (name: string) => readFileSync(new URL(`../fixtures/permission-prompts/${name}.txt`, import.meta.url), "utf8");

describe("permission menu fixtures", () => {
  const wrapped = fixture("claude-2.1.285");
  it.each([
    { name: "claude-2.1.285", allow: ["1"], always: ["2"], deny: ["4"] },
    { name: "claude-older", allow: ["1"], always: ["2"], deny: ["3"] },
    { name: "codex-approval", allow: ["1"], always: ["2"], deny: ["3"] },
  ])("maps all strict answers in $name", ({ name, allow, always, deny }) => {
    const screen = fixture(name);
    expect(pickOption(screen, "allow", { strict: true })?.keys).toEqual(allow);
    expect(pickOption(screen, "allow_always", { strict: true })?.keys).toEqual(always);
    expect(pickOption(screen, "deny", { strict: true })?.keys).toEqual(deny);
  });
  it("records every continuation line and excludes the footer", () => {
    const block = menuBlock(wrapped.split("\n"));
    expect(block?.opts.map((o) => o.key)).toEqual(["1", "2", "3", "4"]);
    expect(block?.tail).toBe(1);
    expect(block?.opts[1].label).toBe("Yes, and don’t ask again for: D=/private/tmp/claude-502/bundled-skills/2.1.285/849fd68e35becc009460545de9246683/artifact-capabilities/0.2.66; ls $D 2>&1; wc -l $D/claude.d.ts $D/db.d.ts 2>&1; ls \"/Applications/Google Chrome.app/Contents/MacOS/\" 2>&1 | head; ls /Users/alice/Documents/Code/joyride/bin/ 2>&1 | head");
    expect(promptOf(wrapped)?.options).toEqual(block?.opts.map((o) => `${o.key}. ${o.label}`));
    expect(promptOf(wrapped)?.question).toContain("Do you want to proceed?");
  });
  it("keeps strict trust-dialog navigation", () => {
    const screen = fixture("claude-trust");
    expect(pickOption(screen, "allow", { strict: true })?.keys).toEqual(["down", "enter"]);
    expect(pickOption(screen, "deny", { strict: true })?.keys).toEqual(["enter"]);
    expect(pickOption(screen, "allow_always", { strict: true })).toBeNull();
    expect(pickOption(screen.replace("❯ No, exit\n   Yes", "   No, exit\n ❯ Yes"), "deny", { strict: true })?.keys).toEqual(["up", "enter"]);
  });
  it.each(["allow", "allow_always"] as const)("never selects auto mode for %s", (choice) => {
    const autoOnly = "Do you want to proceed?\n ❯ 1. Yes, and switch to auto mode, remember this choice\n   2. No\n\n Esc to cancel · Tab to amend";
    expect(pickOption(autoOnly, choice, { strict: true })).toBeNull();
    expect(pickOption(autoOnly, choice)).toBeNull();
  });
  it.each([
    wrapped.replace("   3. Yes", "   5. Yes"),
    wrapped.replace("   2. Yes", "   1. Yes"),
    wrapped.replace("      $D", " $D"),
    wrapped.replace("   2. Yes", "\n   2. Yes"),
    wrapped + "Working again\n",
    wrapped.slice(wrapped.indexOf("   2. Yes")),
    " ❯ 1. Yes\n   2. Yes\n   3. No\n Esc to cancel",
    " ❯ 1. Yes\n   3. No\n Enter to select\nOverwrite? (y/n)",
  ])("refuses malformed, truncated, stale or ambiguous menus", (screen) => {
    expect(pickOption(screen, "allow", { strict: true })).toBeNull();
  });
  it("recognizes wrapped labels even on the final option", () => {
    const screen = " ❯ 1. Yes\n   2. No, and tell Claude\n      what to do differently\n\n Esc to cancel · Tab to amend";
    expect(pickOption(screen, "deny", { strict: true })).toEqual({ keys: ["2"], label: "No, and tell Claude what to do differently" });
  });
});
