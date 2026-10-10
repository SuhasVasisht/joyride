import { defineConfig } from "@playwright/test";
const port = Number(process.env.E2E_PORT ?? 4399);
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  outputDir: `test-results/${port}`,
  reporter: [["list"], ["json", { outputFile: `test-results/e2e-${port}.json` }]],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: { command: "node_modules/.bin/tsx tests/e2e/serve.ts", url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 60000, stdout: "pipe", stderr: "pipe" },
});
