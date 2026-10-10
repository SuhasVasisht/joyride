// Images the captain attaches to a message (a reply, a Firstmate task or steer). Stored under the
// gitignored runtime folder; the relay hands agents their absolute paths.
//   service `uploads`: root(), resolve(paths) -> checked absolute paths of stored images
//   routes: POST /api/uploads {name, data: base64} -> {id, path, url, name, type, bytes}
//           GET /api/uploads/:day/:file -> the image
import fs from "node:fs";
import { defineModule, type Ctx } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { MAX_IMAGES_PER_MESSAGE, uploadUrl } from "../../shared/images.ts";
import { UploadError, checkUpload, resolveUploads, saveUpload, storedFile } from "./store.ts";

export type UploadsApi = {
  root(): string;
  /** Checked real paths of stored images; throws UploadError for anything Joyride didn't store. */
  resolve(wanted: unknown): string[];
};

export default defineModule({
  name: "uploads",
  order: 25,
  register(ctx: Ctx) {
    const { app } = ctx;
    const api: UploadsApi = {
      root: () => paths.uploads,
      resolve: (wanted) => resolveUploads(paths.uploads, wanted, MAX_IMAGES_PER_MESSAGE),
    };
    ctx.services.set("uploads", api);

    app.post("/api/uploads", async (c) => {
      let b: any;
      try { b = await c.req.json(); } catch { return c.json({ error: 'Send a JSON body like {"name": "screenshot.png", "data": "<base64>"}.' }, 400); }
      const name = String(b?.name ?? "image").slice(0, 200);
      try {
        const { buf, ext } = checkUpload(b?.data, name);
        const saved = saveUpload(paths.uploads, buf, ext, name);
        ctx.log(`uploads: stored ${saved.path} (${saved.bytes} bytes)`);
        return c.json({ ...saved, url: uploadUrl(saved.path) });
      } catch (e: any) {
        if (e instanceof UploadError) return c.json({ error: e.message }, e.status);
        return c.json({ error: `Joyride could not store the image: ${e?.message ?? e}. Check that ${paths.uploads} is writable, then attach it again.` }, 500);
      }
    });

    app.get("/api/uploads/:day/:file", (c) => {
      const f = storedFile(paths.uploads, c.req.param("day"), c.req.param("file"));
      if (!f) return c.json({ error: "No such image in Joyride's uploads." }, 404);
      return new Response(fs.readFileSync(f.path), {
        headers: { "content-type": f.type, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
      });
    });
  },
});
