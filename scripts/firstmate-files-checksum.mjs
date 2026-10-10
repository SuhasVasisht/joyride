// Read only the four canonical files. Absence is part of the snapshot.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const home = process.argv[2];
if (!home) throw new Error("Pass the Firstmate home to snapshot.");
for (const file of ["captain.md", "captain-shared.md", "learnings.md", "memory-archive.md"]) {
  const p = path.join(home, "data", file);
  try { console.log(`${crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}  ${file}`); }
  catch (e) { if (e.code === "ENOENT") console.log(`absent  ${file}`); else throw e; }
}
