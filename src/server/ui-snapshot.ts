import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { stampBuild } from "./build.ts";

export class UiSnapshot {
  build: string | null = null;
  private files = new Map<string, Buffer | string>();
  private busy: Promise<void> | null = null;
  constructor(private dir: string) {}
  refresh(): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = this.read().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async read() {
    let index: Buffer;
    try { index = await fs.readFile(path.join(this.dir, "index.html")); }
    catch { return; } // Keep the last complete build while Vite replaces the directory.
    const build = crypto.createHash("sha256").update(index).digest("hex").slice(0, 12);
    if (build === this.build) return;
    const next = new Map<string, Buffer | string>();
    const walk = async (dir: string): Promise<void> => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(file);
        else if (ent.isFile()) next.set(path.relative(this.dir, file), await fs.readFile(file));
      }
    };
    await walk(this.dir);
    next.set("index.html", stampBuild(index.toString("utf8"), build));
    this.files = next;
    this.build = build;
  }
  response(urlPath: string) {
    const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const file = this.files.has(rel) ? rel : "index.html";
    const body = this.files.get(file);
    if (!body) return new Response("UI not built. Run `npm run build`.", { status: 503 });
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };
    const ext = path.extname(file);
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { "content-type": types[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "max-age=3600" } });
  }
}
