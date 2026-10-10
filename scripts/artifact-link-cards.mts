// Remove obsolete frontmatter only. Verify every retained byte against a git revision.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { z } from "zod";
import { commitPaths } from "../src/core/gitstore.ts";

const dead = new Set(["distilled", "distilled_at", "distilled_by", "distilled_blob", "distilled_blobs", "candidates", "reviewed_at"]);
const baseArg = process.argv.indexOf("--base");
const base = baseArg >= 0 ? process.argv[baseArg + 1] : "HEAD";
assert(base, "Give a git revision after --base.");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const root = git("rev-parse", "--show-toplevel").trim();
const files = git("ls-tree", "-r", "--name-only", base, "--", "artifacts").trim().split("\n").filter(f => f.endsWith(".md"));
assert(files.length, "No artifact files in the baseline.");
const current = git("ls-files", "--", "artifacts").trim().split("\n").filter(f => f.endsWith(".md"));
assert.deepEqual(current, files, "Artifact file inventory changed.");

function parts(text: string) {
  const m = text.match(/^---\r?\n([\s\S]*?)^---\r?\n/m);
  assert(m, "Missing artifact frontmatter.");
  const data = z.record(z.string(), z.unknown()).parse(YAML.parse(m[1]));
  return { front: m[1], data, body: text.slice(m[0].length), header: m[0] };
}
function strip(text: string) {
  const { front, header } = parts(text);
  let skip = false;
  const clean = front.split(/(?<=\n)/).filter(line => {
    const key = line.match(/^([A-Za-z_][\w-]*):/);
    if (key) skip = dead.has(key[1]);
    return !skip;
  }).join("");
  return text.replace(header, header.replace(front, clean));
}
const retained = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([k]) => !dead.has(k)));
const changes: { file: string; text: string }[] = [];
let privateCards = 0;
for (const file of files) {
  const before = git("show", `${base}:${file}`);
  const after = process.argv.includes("--write") ? strip(before) : fs.readFileSync(path.join(root, file), "utf8");
  const old = parts(before), fresh = parts(after);
  assert.deepEqual(fresh.data, retained(old.data), `${file}: retained metadata changed`);
  assert.equal(fresh.body, old.body, `${file}: markdown body changed`);
  assert.equal(after, strip(before), `${file}: bytes other than dead fields changed`);
  if (old.data.private === true) { privateCards++; assert.equal(fresh.data.private, true); }
  if (after !== before) changes.push({ file, text: after });
}
if (process.argv.includes("--write")) {
  for (const change of changes) fs.writeFileSync(path.join(root, change.file), change.text);
  if (changes.length) commitPaths(changes.map(c => path.join(root, c.file)), "artifacts: strip obsolete distillation and review fields");
}
process.stdout.write(`Artifact card proof: ${files.length} files compared with ${base}; every retained field and body byte identical; ${privateCards} private cards still private.\n`);
