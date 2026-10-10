import { test as base, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);

export async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a private TCP port");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export function pageId(output: string, url: string): string {
  const matches = output.split("\n").flatMap(line => {
    const row = /^\s*(\d+),(.*),(?:true|false)\s*$/.exec(line);
    return row && row[2] === url ? [row[1]] : [];
  });
  if (matches.length !== 1) throw new Error(`Expected one DevTools page at ${url}, found ${matches.length}:\n${output}`);
  return matches[0];
}

export class DevTools {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async raw(...args: string[]): Promise<string> {
    const { stdout } = await exec("chrome-devtools-axi", args, {
      env: this.env, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }

  async select(page: Page): Promise<void> {
    // list_pages refreshes the bridge's browser connection before selection.
    const output = await this.raw("pages");
    const id = pageId(output, page.url());
    // selectpage also takes a snapshot. Keep an existing selection to avoid
    // disturbing camera measurements, but reselect when reconnect cleared it.
    if (!output.split("\n").some(line => line.trim() === `${id},${page.url()},true`)) {
      await this.raw("selectpage", id);
    }
  }

  async command(page: Page, ...args: string[]): Promise<string> {
    await this.select(page);
    // Never replay eval or input: a disconnected response may have executed already.
    return this.raw(...args);
  }

  async run(page: Page, script: string): Promise<string> {
    await this.select(page);
    return new Promise((resolve, reject) => {
      const child = execFile("chrome-devtools-axi", ["run"], {
        env: this.env, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`, { cause: error }));
        else resolve(stdout);
      });
      child.stdin?.end(script);
    });
  }
}

type Worker = { devtoolsWorker: { root: string; debugPort: number; bridge: DevTools } };
export const test = base.extend<{ devtools: DevTools }, Worker>({
  devtoolsWorker: [async ({}, use, info) => {
    const root = path.resolve(".joyride/e2e-devtools", `${process.pid}-${info.workerIndex}-${randomUUID()}`);
    await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    const debugPort = await freePort();
    const bridgePort = await freePort();
    const env = { ...process.env, HOME: root, TMPDIR: path.join(root, "tmp"),
      // Downloads and bridge state belong to this worker.
      npm_config_cache: path.join(root, "npm-cache"),
      CHROME_DEVTOOLS_AXI_SESSION: `e2e-${process.pid}-${info.workerIndex}`,
      CHROME_DEVTOOLS_AXI_PORT: String(bridgePort),
      CHROME_DEVTOOLS_AXI_BROWSER_URL: `http://127.0.0.1:${debugPort}`,
      CHROME_DEVTOOLS_AXI_BRIDGE_TIMEOUT_MS: "90000",
      CHROME_DEVTOOLS_AXI_AUTO_CONNECT: "0",
      CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "",
      CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: "300000",
    };
    const bridge = new DevTools(env);
    try { await use({ root, debugPort, bridge }); }
    finally {
      await bridge.raw("stop");
      await fs.rm(root, { recursive: true, force: true });
    }
  }, { scope: "worker", timeout: 120000 }],
  browser: [async ({ playwright, browserName, headless, channel, launchOptions, devtoolsWorker }, use) => {
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = path.join(devtoolsWorker.root, "tmp");
    const browser = await playwright[browserName].launch({ ...launchOptions, headless, channel,
      args: [...(launchOptions.args ?? []).filter(arg => !arg.startsWith("--remote-debugging-port")),
        `--remote-debugging-port=${devtoolsWorker.debugPort}`],
    }).finally(() => {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: "worker" }],
  devtools: [async ({ page, devtoolsWorker }, use) => {
    await devtoolsWorker.bridge.raw("start");
    await use(devtoolsWorker.bridge);
  }, { timeout: 120000 }],
});
export { expect };
