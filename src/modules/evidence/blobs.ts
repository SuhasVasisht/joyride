// Content-addressed blob store (.joyride/blobs/<sha256>). Shared by the
// joyride-evidence CLI (bun) and the daemon; node builtins only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../../shared/paths.ts";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
export const isSha = (s: string) => /^[a-f0-9]{64}$/.test(s);
export const blobPath = (sha: string) => path.join(paths.blobs, sha);

function place(tmp: string, sha: string) {
  const dest = blobPath(sha);
  if (fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
  else fs.renameSync(tmp, dest);
  return sha;
}

export function putBlobBuffer(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  const sha = crypto.createHash("sha256").update(b).digest("hex");
  if (fs.existsSync(blobPath(sha))) return sha;
  fs.mkdirSync(paths.blobs, { recursive: true });
  const tmp = path.join(paths.blobs, `.${sha}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, b);
  return place(tmp, sha);
}

export function putBlobFile(file: string): string { return putBlobBuffer(fs.readFileSync(file)); }

/** Move an already-written temp file into the store under its sha. */
export function adoptBlob(tmpFile: string, sha: string): string {
  fs.mkdirSync(paths.blobs, { recursive: true });
  return place(tmpFile, sha);
}

/** Content type from magic bytes (blobs carry no extension). */
export function sniffType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  const head = buf.subarray(0, 4096);
  if (head.includes(0)) return "application/octet-stream";
  const t = head.toString("utf8").trimStart();
  if (t.startsWith("{") || t.startsWith("[")) { try { JSON.parse(buf.toString("utf8")); return "application/json"; } catch { /* text */ } }
  return "text/plain; charset=utf-8";
}

export const extFor = (type: string) => ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<string, string>)[type] ?? "";
