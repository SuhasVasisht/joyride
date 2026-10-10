// The UI build id: a short hash of the built index.html, which names every hashed asset, so any
// rebuild that changes the bundle changes it. /api/health reports it and the served page carries it
// in a meta tag; an open tab compares the two to notice it is running an old bundle.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

let cache: { file: string; mtime: number; size: number; id: string } | null = null;

/** The build id of the UI in `uiDir`, or null when it is not built. */
export function uiBuild(uiDir: string): string | null {
  const file = path.join(uiDir, "index.html");
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  if (cache && cache.file === file && cache.mtime === st.mtimeMs && cache.size === st.size) return cache.id;
  try {
    const id = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
    cache = { file, mtime: st.mtimeMs, size: st.size, id };
    return id;
  } catch { return null; }
}

/** index.html with `<meta name="joyride-build">` so the page knows which build it loaded. */
export function stampBuild(html: string, id: string | null): string {
  if (!id) return html;
  return html.replace(/<head>/i, `<head>\n    <meta name="joyride-build" content="${id}" />`);
}
