// Image uploads on disk: <runtime>/uploads/<YYYY-MM-DD>/<id>.<ext>, inside Joyride's
// gitignored runtime folder, at a stable absolute path an agent can be handed.
// The type is read from the file's first bytes, never trusted from the browser.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, formatBytes, type ImageExt } from "../../shared/images.ts";

export type StoredImage = { id: string; path: string; name: string; type: string; bytes: number; created: string };

export class UploadError extends Error {
  constructor(message: string, public status: 400 | 404 | 413 | 415 = 400) { super(message); }
}

/** The image type from its magic bytes: png, jpg, gif or webp; null for anything else. */
export function sniffImage(buf: Buffer): ImageExt | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/** Decode and check an upload: base64 data (a data: URL is fine), at most MAX_IMAGE_BYTES, a real png/jpg/gif/webp. */
export function checkUpload(data: unknown, name = "image", max = MAX_IMAGE_BYTES): { buf: Buffer; ext: ImageExt } {
  if (typeof data !== "string" || !data) throw new UploadError('Send the image as base64 in "data".');
  const b64 = data.replace(/^data:[^,]*;base64,/, "");
  // base64 is 4 characters per 3 bytes: refuse before decoding something far too big.
  if (Math.floor(b64.length * 3 / 4) > max + 3) throw tooBig(name, Math.floor(b64.length * 3 / 4), max);
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new UploadError(`${name} is empty.`);
  if (buf.length > max) throw tooBig(name, buf.length, max);
  const ext = sniffImage(buf);
  if (!ext) throw new UploadError(`${name} is not a PNG, JPEG, GIF or WebP image. Joyride only sends those to agents; convert it or take a screenshot instead.`, 415);
  return { buf, ext };
}

const tooBig = (name: string, bytes: number, max: number) =>
  new UploadError(`${name} is ${formatBytes(bytes)}; the limit is ${formatBytes(max)}. Shrink it or crop a screenshot, then attach it again.`, 413);

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

const newId = () => crypto.randomBytes(9).toString("base64url").replace(/[-_]/g, "x").toLowerCase();

/**
 * Write a checked image under root/<day>/<id>.<ext> and return where it went. The id is random,
 * never the display name, a content hash or the time, so the same screenshot pasted twice (both
 * named image.png) stays two files; a file already at that id is never overwritten.
 */
export function saveUpload(root: string, buf: Buffer, ext: ImageExt, name: string, at = new Date(), drawId = newId): StoredImage {
  // The real path (macOS /tmp is /private/tmp), so it matches what resolveUploads hands back.
  fs.mkdirSync(path.join(root, dayOf(at)), { recursive: true });
  const dir = fs.realpathSync(path.join(root, dayOf(at)));
  for (let tries = 0; ; tries++) {
    const id = drawId();
    const file = path.join(dir, `${id}.${ext}`);
    try { fs.writeFileSync(file, buf, { flag: "wx" }); }
    catch (e: any) { if (e?.code === "EEXIST" && tries < 4) continue; throw e; }
    return { id, path: file, name: cleanName(name, ext), type: IMAGE_TYPES[ext], bytes: buf.length, created: at.toISOString() };
  }
}

function cleanName(name: string, ext: string) {
  const base = String(name ?? "").split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, "").trim().slice(0, 120);
  return base || `image.${ext}`;
}

const STORED_NAME = /^[a-z0-9]{6,32}\.(png|jpg|gif|webp)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The stored file for /api/uploads/<day>/<file>, or null when the name isn't one Joyride gave out. */
export function storedFile(root: string, day: string, file: string): { path: string; type: string } | null {
  if (!DAY.test(day) || !STORED_NAME.test(file)) return null;
  const p = path.join(root, day, file);
  if (!fs.existsSync(p)) return null;
  return { path: p, type: IMAGE_TYPES[file.split(".").pop() as ImageExt] };
}

/**
 * Check that the paths a message wants to send are images Joyride stored: inside root, still there,
 * and still png/jpg/gif/webp. Returns their real absolute paths. Anything else is refused, so an
 * intent can't paste an arbitrary file path into an agent.
 */
export function resolveUploads(root: string, wanted: unknown, max: number): string[] {
  if (wanted == null) return [];
  if (!Array.isArray(wanted)) throw new UploadError("images must be a list of uploaded image paths.");
  if (wanted.length > max) throw new UploadError(`That is ${wanted.length} images; one message takes at most ${max}. Send the rest in a second message.`);
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  return wanted.map((w) => {
    const p = String(w ?? "");
    let real: string;
    try { real = fs.realpathSync(path.resolve(p)); } catch { throw new UploadError(`The image ${p} is gone from Joyride's uploads. Attach it again.`, 404); }
    const rel = path.relative(realRoot, real);
    const [day, file, ...rest] = rel.split(path.sep);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rest.length || !DAY.test(day ?? "") || !STORED_NAME.test(file ?? "")) {
      throw new UploadError(`${p} is not an image uploaded to Joyride. Attach images in Joyride so they are stored under ${root}.`);
    }
    const head = Buffer.alloc(12);
    const fd = fs.openSync(real, "r");
    try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
    if (!sniffImage(head)) throw new UploadError(`${p} is no longer a PNG, JPEG, GIF or WebP image. Attach it again.`, 415);
    return real;
  });
}
