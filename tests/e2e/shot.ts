import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
/** Save a checkpoint screenshot to docs/checkpoints/<checkpoint>/<name>.png */
export async function shot(page: Page, checkpoint: string, name: string, opts: { fullPage?: boolean } = {}) {
  const dir = path.resolve("docs/checkpoints", checkpoint);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  return file;
}
