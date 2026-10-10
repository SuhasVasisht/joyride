import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src/ui"),
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve(__dirname, "src/shared") } },
  build: { outDir: path.resolve(__dirname, process.env.JOYRIDE_UI_OUT ?? "dist/ui"), emptyOutDir: true, sourcemap: true },
  server: { port: 4318, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.JOYRIDE_PORT ?? 4317}`, changeOrigin: false } } },
});
