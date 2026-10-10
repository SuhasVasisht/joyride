import { test, expect, DevTools, freePort } from "./devtools";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { shot } from "./shot";

const bridgeState = z.object({ pid: z.number().int().positive(), port: z.number().int().positive() });

test("an idle bridge expires and the next command reselects its page", async ({ page, devtoolsWorker }) => {
  test.setTimeout(120000);
  await page.goto("/#/map");
  const home = path.join(devtoolsWorker.root, "idle");
  const bridge = new DevTools({ ...process.env, HOME: home,
    npm_config_cache: path.join(home, "npm-cache"),
    CHROME_DEVTOOLS_AXI_SESSION: "idle",
    CHROME_DEVTOOLS_AXI_PORT: String(await freePort()),
    CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${devtoolsWorker.debugPort}`,
    CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "",
    CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS: "90000",
    CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: "5000",
  });
  const stateFile = path.join(home, ".chrome-devtools-axi/sessions/idle/bridge.pid");
  try {
    await bridge.raw("start");
    await bridge.select(page);
    const before = bridgeState.parse(JSON.parse(await fs.readFile(stateFile, "utf8")));
    await page.waitForTimeout(6500);
    expect(await bridge.command(page, "eval", "--full", "() => location.href")).toContain(page.url());
    const after = bridgeState.parse(JSON.parse(await fs.readFile(stateFile, "utf8")));
    expect(after.pid).not.toBe(before.pid);
    await shot(page, "C12/devtools", "idle-reconnected-page");
  } finally { await bridge.raw("stop"); }
});
