import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { call, PORT } from "./map-seed";
import { shot } from "./shot";

const data = `/tmp/joyride-e2e-${PORT}/runtime/firstmate/data`;
const files = ["captain.md", "captain-shared.md", "learnings.md", "memory-archive.md"];
const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(data, file))).digest("hex");

test("Settings reads Firstmate's files, opens them, and leaves /stow edits alone", async ({ page }) => {
  fs.mkdirSync(data, { recursive: true });
  const originals = files.map((file) => fs.existsSync(path.join(data, file)) ? fs.readFileSync(path.join(data, file)) : null);
  try {
    for (const file of files) fs.writeFileSync(path.join(data, file), `# ${file}\n\n- Canonical preference in ${file}. <!--P-->\n`);
    const before = files.map(hash);
    await page.goto("/#/settings");
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Firstmate preferences" }).click();
    const section = page.locator('[data-settings="firstmate-files"]');
    await expect(section).toContainText("This view is read-only");
    for (const file of files) {
      const card = section.locator(`[data-file="${file}"]`);
      await expect(card.getByLabel(file)).toHaveText(`# ${file}\n\n- Canonical preference in ${file}. <!--P-->\n`);
      await expect(card.locator("input, textarea")).toHaveCount(0);
      const response = page.waitForResponse((r) => r.url().endsWith(`/api/system/firstmate-files/${file}/open`) && r.request().method() === "POST");
      await card.getByRole("button", { name: "Open file", exact: true }).click();
      expect((await response).status()).toBe(200);
    }
    expect(files.map(hash)).toEqual(before);
    await shot(page, "T3", "firstmate-preferences-read-only");
    const edited = "# Learnings\n\n- Firstmate stowed a changed bullet. <!--a:2026-10-05-->\n";
    fs.writeFileSync(path.join(data, "learnings.md"), edited);
    const created = await call("POST", "/api/notes", { bullets: ["Keep canonical files"], global: true });
    expect(created.status).toBe(201);
    expect((await call("GET", "/api/memory")).status).toBe(404);
    await page.reload();
    await expect(section.getByLabel("learnings.md")).toHaveText(edited);
    expect(fs.readFileSync(path.join(data, "learnings.md"), "utf8")).toBe(edited);
    fs.unlinkSync(path.join(data, "captain-shared.md"));
    await page.reload();
    const absent = section.locator('[data-file="captain-shared.md"]');
    await expect(absent).toContainText("Not created yet");
    await expect(absent.getByRole("button", { name: "Open file" })).toBeDisabled();
  } finally {
    for (const [i, file] of files.entries()) {
      const original = originals[i];
      if (original) fs.writeFileSync(path.join(data, file), original);
      else fs.rmSync(path.join(data, file), { force: true });
    }
  }
});
