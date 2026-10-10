// Image uploads: the type comes from the file's bytes, the size cap has a clear error, files land
// at <runtime>/uploads/<day>/<id>.<ext> (gitignored), and only stored images can be sent on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sandboxDaemon } from "../sandbox.ts";
import { UploadError, checkUpload, resolveUploads, saveUpload, sniffImage, storedFile } from "../../src/modules/uploads/store.ts";
import { MAX_IMAGE_BYTES, uploadUrl } from "../../src/shared/images.ts";
import { paths, CODE_ROOT } from "../../src/shared/paths.ts";
import { PNG_1PX } from "../fixtures/images.ts";

// The headers of the other accepted types.
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(32)]);
const b64 = (b: Buffer) => b.toString("base64");

describe("checking an upload", () => {
  it("knows png, jpg, gif and webp by their bytes, and nothing else", () => {
    expect(sniffImage(PNG_1PX)).toBe("png");
    expect(sniffImage(JPG)).toBe("jpg");
    expect(sniffImage(GIF)).toBe("gif");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(Buffer.from("%PDF-1.7 not an image"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it("takes plain base64 or a data: URL and trusts the bytes, not the name", () => {
    expect(checkUpload(b64(PNG_1PX), "a.png").ext).toBe("png");
    expect(checkUpload(`data:image/png;base64,${b64(PNG_1PX)}`, "a.png").ext).toBe("png");
    expect(checkUpload(`data:image/png;base64,${b64(JPG)}`, "named-png.png").ext).toBe("jpg");
  });

  it("refuses other files, empty data and anything over the cap, saying what to do", () => {
    expect(() => checkUpload(b64(Buffer.from("%PDF-1.7")), "report.pdf")).toThrow(/report\.pdf is not a PNG, JPEG, GIF or WebP image/);
    try { checkUpload(b64(Buffer.from("%PDF")), "x.pdf"); } catch (e: any) { expect(e).toBeInstanceOf(UploadError); expect(e.status).toBe(415); }
    expect(() => checkUpload("", "x")).toThrow(/Send the image as base64/);
    expect(() => checkUpload(undefined, "x")).toThrow(/Send the image as base64/);
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(2048)]);
    let err: any;
    try { checkUpload(b64(big), "huge.png", 1024); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 413 });
    expect(err.message).toMatch(/huge\.png is 2 KB; the limit is 1 KB\. Shrink it or crop a screenshot/);
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("storing an upload", () => {
  const root = () => path.join(process.env.JOYRIDE_RUNTIME!, "store-test", "uploads");

  it("writes <root>/<day>/<id>.<ext> at a stable absolute path the daemon can serve", () => {
    const s = saveUpload(root(), PNG_1PX, "png", "../../etc/screen shot.png", new Date("2026-10-04T12:00:00Z"));
    expect(path.isAbsolute(s.path)).toBe(true);
    expect(s.path).toBe(path.join(fs.realpathSync(root()), "2026-10-04", `${s.id}.png`));
    expect(fs.readFileSync(s.path).equals(PNG_1PX)).toBe(true);
    expect(s).toMatchObject({ name: "screen shot.png", type: "image/png", bytes: PNG_1PX.length });
    expect(uploadUrl(s.path)).toBe(`/api/uploads/2026-10-04/${s.id}.png`);
    expect(storedFile(root(), "2026-10-04", `${s.id}.png`)).toEqual({ path: path.join(root(), "2026-10-04", `${s.id}.png`), type: "image/png" });
    expect(storedFile(root(), "2026-10-04", "../../etc/passwd")).toBeNull();
    expect(storedFile(root(), "..", `${s.id}.png`)).toBeNull();
  });

  it("only lets stored images go out: not other files, not traversal, not too many", () => {
    const a = saveUpload(root(), PNG_1PX, "png", "a.png");
    const b = saveUpload(root(), GIF, "gif", "b.gif");
    expect(resolveUploads(root(), [a.path, b.path], 8)).toEqual([a.path, b.path]);
    expect(resolveUploads(root(), undefined, 8)).toEqual([]);
    const outside = path.join(process.env.JOYRIDE_RUNTIME!, "elsewhere.png");
    fs.writeFileSync(outside, PNG_1PX);
    expect(() => resolveUploads(root(), [outside], 8)).toThrow(/is not an image uploaded to Joyride/);
    expect(() => resolveUploads(root(), [path.join(root(), "..", "..", "elsewhere.png")], 8)).toThrow(/is not an image uploaded to Joyride/);
    expect(() => resolveUploads(root(), [path.join(path.dirname(a.path), "nothere123.png")], 8)).toThrow(/is gone from Joyride's uploads\. Attach it again/);
    expect(() => resolveUploads(root(), Array(9).fill(a.path), 8)).toThrow(/one message takes at most 8/);
    expect(() => resolveUploads(root(), a.path, 8)).toThrow(/must be a list/);
    // A stored name that no longer holds an image is refused too.
    fs.writeFileSync(b.path, "not a gif any more");
    expect(() => resolveUploads(root(), [b.path], 8)).toThrow(/no longer a PNG, JPEG, GIF or WebP/);
  });

  it("the same screenshot pasted three times, all named image.png, stays three files with their exact bytes", () => {
    const at = new Date("2026-10-05T09:00:00Z");
    const pasted = [PNG_1PX, PNG_1PX, Buffer.from(PNG_1PX)].map((b) => saveUpload(root(), b, "png", "image.png", at));
    expect(new Set(pasted.map((s) => s.id)).size).toBe(3);
    expect(new Set(pasted.map((s) => s.path)).size).toBe(3);
    for (const s of pasted) {
      expect(s.name).toBe("image.png");
      expect(fs.readFileSync(s.path).equals(PNG_1PX)).toBe(true);
    }
    // A paste with no name at all gets the default one, and its own file too.
    const unnamed = [saveUpload(root(), PNG_1PX, "png", "", at), saveUpload(root(), PNG_1PX, "png", "", at)];
    expect(unnamed.map((s) => s.name)).toEqual(["image.png", "image.png"]);
    expect(unnamed[0].path).not.toBe(unnamed[1].path);
    // Sending them keeps every one, in order: identical bytes are never folded into one.
    const all = [...pasted, ...unnamed].map((s) => s.path);
    expect(resolveUploads(root(), all, 8)).toEqual(all);
    expect(resolveUploads(root(), [all[2], all[0], all[1]], 8)).toEqual([all[2], all[0], all[1]]);
  });

  it("never overwrites a stored image: an id already on disk is drawn again", () => {
    const at = new Date("2026-10-05T09:00:00Z");
    const first = saveUpload(root(), GIF, "gif", "image.gif", at);
    // The first draw is an id already on disk; the store must draw again, not reuse it.
    const draws = [first.id, "fresh123abc"];
    const other = Buffer.concat([GIF, Buffer.from("another frame")]);
    const second = saveUpload(root(), other, "gif", "image.gif", at, () => draws.shift()!);
    expect(second.id).toBe("fresh123abc");
    expect(second.path).not.toBe(first.path);
    expect(fs.readFileSync(first.path).equals(GIF)).toBe(true);
    expect(fs.readFileSync(second.path).equals(other)).toBe(true);
  });

  it("keeps uploads in the gitignored runtime folder, never in git", () => {
    expect(path.relative(paths.runtime, paths.uploads)).toBe("uploads");
    // The default runtime folder (.joyride/) is ignored by the repo.
    expect(() => execFileSync("git", ["check-ignore", "-q", ".joyride/uploads/2026-10-04/abc123.png"], { cwd: CODE_ROOT })).not.toThrow();
  });
});

describe("the uploads routes", () => {
  let d: Awaited<ReturnType<typeof sandboxDaemon>>;
  beforeAll(async () => { d = await sandboxDaemon("uploads", ["uploads"]); await d.start(); });
  afterAll(async () => { await d?.stop(); });

  it("stores a posted image and serves it back with its type", async () => {
    const r = await d.req("POST", "/api/uploads", { name: "screenshot.png", data: `data:image/png;base64,${b64(PNG_1PX)}` });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "screenshot.png", type: "image/png", bytes: PNG_1PX.length, url: expect.stringMatching(/^\/api\/uploads\/\d{4}-\d{2}-\d{2}\/[a-z0-9]+\.png$/) });
    expect(r.body.path.startsWith(fs.realpathSync(paths.runtime))).toBe(true);
    expect(fs.existsSync(r.body.path)).toBe(true);
    const got = await d.app.request(r.body.url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG_1PX)).toBe(true);
    expect(d.ctx.service<any>("uploads").resolve([r.body.path])).toEqual([r.body.path]);
  });

  it("three posts of the same name and bytes give three paths and urls, each serving its bytes", async () => {
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await d.req("POST", "/api/uploads", { name: "image.png", data: `data:image/png;base64,${b64(PNG_1PX)}` })).body);
    expect(new Set(got.map((r) => r.path)).size).toBe(3);
    expect(new Set(got.map((r) => r.url)).size).toBe(3);
    for (const r of got) expect(Buffer.from(await (await d.app.request(r.url)).arrayBuffer()).equals(PNG_1PX)).toBe(true);
    expect(d.ctx.service<any>("uploads").resolve(got.map((r) => r.path))).toEqual(got.map((r) => r.path));
  });

  it("answers bad uploads with 413, 415 and 400, and unknown names with 404", async () => {
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const tooBig = await d.req("POST", "/api/uploads", { name: "big.png", data: b64(big) });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toMatch(/big\.png is 10\.0 MB; the limit is 10\.0 MB/);
    const pdf = await d.req("POST", "/api/uploads", { name: "doc.pdf", data: b64(Buffer.from("%PDF-1.7 hello")) });
    expect(pdf.status).toBe(415);
    expect((await d.req("POST", "/api/uploads", { name: "x" })).status).toBe(400);
    expect((await d.app.request("/api/uploads/2026-10-04/nope123.png")).status).toBe(404);
    expect((await d.app.request("/api/uploads/2026-10-04/..%2F..%2Findex.sqlite")).status).toBe(404);
  });
});
