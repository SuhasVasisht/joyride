import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { vendorCheckout } from "../../src/shared/vendor.ts";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.JOYRIDE_RUNTIME!, "vendor-paths-"));
  roots.push(root);
  const codeRoot = path.join(root, "worker"), dataRoot = path.join(root, "data");
  fs.mkdirSync(codeRoot); fs.mkdirSync(dataRoot);
  return { root, codeRoot, dataRoot };
}
const vendor = (root: string) => {
  const dir = path.join(root, "vendor", "firstmate");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("vendor checkout paths", () => {
  it("keeps explicit overrides authoritative, including unavailable checkouts", () => {
    const o = fixture();
    vendor(o.codeRoot);
    const override = path.join(o.root, "missing");
    expect(vendorCheckout({ ...o, name: "firstmate", override })).toBe(override);
  });

  it("prefers data-root and then code-root vendors", () => {
    const o = fixture();
    const code = vendor(o.codeRoot), data = vendor(o.dataRoot);
    expect(vendorCheckout({ ...o, name: "firstmate" })).toBe(data);
    fs.rmSync(data, { recursive: true });
    expect(vendorCheckout({ ...o, name: "firstmate" })).toBe(code);
  });

  it("borrows the main checkout vendor through the worker's git common dir", () => {
    const o = fixture();
    const main = path.join(o.root, "main");
    execFileSync("git", ["init", "-q", main]);
    // A linked-worktree gitfile and commondir, without administering the pool.
    const metadata = path.join(main, ".git", "worktrees", "fixture");
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, "commondir"), "../..\n");
    fs.writeFileSync(path.join(metadata, "HEAD"), "ref: refs/heads/fixture\n");
    fs.writeFileSync(path.join(o.codeRoot, ".git"), `gitdir: ${metadata}\n`);
    const borrowed = vendor(main);
    expect(vendorCheckout({ ...o, name: "firstmate" })).toBe(fs.realpathSync(borrowed));
    const local = vendor(o.codeRoot);
    expect(vendorCheckout({ ...o, name: "firstmate" })).toBe(local);
  });

  it("returns the missing local path for source archives with no vendor or git metadata", () => {
    const o = fixture();
    expect(vendorCheckout({ ...o, name: "firstmate" })).toBe(path.join(o.codeRoot, "vendor", "firstmate"));
  });
});
