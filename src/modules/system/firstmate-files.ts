import fs from "node:fs";
import path from "node:path";

export const FIRSTMATE_FILES = ["captain.md", "captain-shared.md", "learnings.md", "memory-archive.md"] as const;
export type FirstmateFileName = (typeof FIRSTMATE_FILES)[number];
export type FirstmateFile = { file: FirstmateFileName; path: string } & (
  | { state: "ready"; text: string }
  | { state: "absent" }
  | { state: "unreadable"; error: string }
);

export function readFirstmateFiles(home: string): FirstmateFile[] {
  return FIRSTMATE_FILES.map((file) => {
    const filePath = path.join(home, "data", file);
    try { return { file, path: filePath, state: "ready", text: fs.readFileSync(filePath, "utf8") }; }
    catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return { file, path: filePath, state: "absent" };
      return { file, path: filePath, state: "unreadable", error: `Could not read ${file}. Check the file's permissions in Firstmate's home.` };
    }
  });
}
