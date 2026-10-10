// Installer integration evidence needs a browser for its receipt, not a daemon
// or Herdr. Keep this run wholly inside the disposable checkout.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "mcp-parity.spec.ts", workers: 1, timeout: 60000,
  outputDir: "test-results/mcp-parity",
  reporter: [["list"], ["json", { outputFile: "test-results/mcp-parity.json" }]],
  use: { viewport: { width: 1440, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
