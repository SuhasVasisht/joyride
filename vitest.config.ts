import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/unit/**/*.test.ts"], setupFiles: ["tests/setup-env.ts"], testTimeout: 30000, pool: "forks", isolate: true } });
