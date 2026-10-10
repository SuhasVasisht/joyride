// Small real images for upload and relay tests.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** A real 1x1 PNG. */
export const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** The base64 data URL the UI posts to /api/uploads. */
export const pngDataUrl = () => `data:image/png;base64,${PNG_1PX.toString("base64")}`;

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A width x height PNG: a solid colour with a diagonal band, so a thumbnail shows something. */
export function solidPng(width = 240, height = 150, rgb: [number, number, number] = [180, 35, 24]): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const band = Math.abs(x - y * (width / height)) < 18;
      rows[o + 1 + x * 3] = band ? 251 : rgb[0]; rows[o + 2 + x * 3] = band ? 251 : rgb[1]; rows[o + 3 + x * 3] = band ? 247 : rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** Write a PNG to a file (for Playwright's file picker). */
export function writePng(dir: string, name = "screenshot.png", png: Buffer = solidPng()) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, png);
  return p;
}
