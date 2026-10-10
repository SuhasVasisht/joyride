// Repeat the legacy camera checks while an independent harness worker owns a browser.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DevTools, freePort } from "../tests/e2e/devtools";

const root = path.resolve(".joyride/e2e-devtools", `companion-${randomUUID()}`);
await fs.mkdir(path.join(root, "tmp"), { recursive: true });
const debugPort = await freePort();
const bridgePort = await freePort();
const sandboxPort = await freePort();
const companion = new DevTools({ ...process.env, HOME: root, TMPDIR: path.join(root, "tmp"),
  npm_config_cache: path.join(root, "npm-cache"),
  CHROME_DEVTOOLS_AXI_SESSION: `companion-${process.pid}`,
  CHROME_DEVTOOLS_AXI_PORT: String(bridgePort),
  CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${debugPort}`,
  CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "",
  CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS: "90000",
});
const originalTmpdir = process.env.TMPDIR;
process.env.TMPDIR = path.join(root, "tmp");
const browser = await chromium.launch({ args: [`--remote-debugging-port=${debugPort}`] }).finally(() => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
});
try {
  const page = await browser.newPage();
  await page.goto("data:text/html,<title>Independent worker</title><h1>Independent worker</h1>");
  await companion.raw("start");
  await companion.select(page);
  const rounds = process.argv.includes("--once") ? 1 : 3;
  for (let round = 1; round <= rounds; round++) {
    console.log(`DevTools coexistence round ${round}: companion browser ${debugPort}, bridge ${bridgePort}`);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(path.resolve("bin/joyride-evidence"), ["run", "--mission", "build-joyride", "--name", `DevTools e2e round ${round}`, "--",
        "npx", "playwright", "test", "tests/e2e/map-zoom-crisp.spec.ts", "tests/e2e/map-zoom-render.spec.ts", "tests/e2e/devtools-harness.spec.ts", ...(process.env.MAP_ZOOM_PROFILE ? ["tests/e2e/map-zoom-profile.spec.ts"] : []), "--workers=1"], {
        stdio: "inherit", env: { ...process.env, E2E_PORT: String(sandboxPort) },
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) throw new Error(`DevTools round ${round} exited ${code}`);
    const title = await companion.command(page, "eval", "--full", "() => document.title");
    if (!title.includes("Independent worker")) throw new Error(`Companion page changed: ${title}`);
    await page.screenshot({ path: path.resolve(`test-results/devtools-companion-${round}.png`) });
  }
} finally {
  try { await companion.raw("stop"); }
  finally {
    await browser.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
