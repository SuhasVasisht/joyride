// Playwright webServer: fresh sandbox + optional fake Herdr + the real daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSandbox } from "../sandbox.ts";

const port = Number(process.env.E2E_PORT ?? 4399);
const sb = buildSandbox(`/tmp/joyride-e2e-${port}`, { port });
if (process.env.E2E_UI_DIR) process.env.JOYRIDE_UI_DIR = path.resolve(process.env.E2E_UI_DIR);
// A real Herdr lab session instead of the fake (scripts/lab-relay.sh); the sandbox never starts a Herdr server itself.
const lab = process.env.E2E_LAB_HERDR_SOCKET;
if (lab && !/\/sessions\/fm-lab-[\w-]+\/herdr\.sock$/.test(lab)) throw new Error(`E2E_LAB_HERDR_SOCKET must be a Herdr lab session's socket (.../sessions/fm-lab-*/herdr.sock), not ${lab}.`);
if (lab) sb.env.JOYRIDE_HERDR_SOCKET = lab;
// The lab's own Claude Code config folder (scripts/lab-staged.sh), so its sessions and transcripts are indexed.
const labClaude = process.env.E2E_LAB_CLAUDE_DIR;
if (labClaude) {
  const dir = path.resolve(labClaude), real = path.join(os.homedir(), ".claude");
  if (!lab || dir === real || dir.startsWith(real + path.sep)) throw new Error(`E2E_LAB_CLAUDE_DIR must be a lab Claude Code folder used with E2E_LAB_HERDR_SOCKET, not ${labClaude}.`);
  sb.env.JOYRIDE_CLAUDE_DIR = dir;
}
// The isolated Codex rollout store, so the lab checks the actual chat as well as the raw input.
const labCodex = process.env.E2E_LAB_CODEX_DIR;
if (labCodex) {
  const dir = path.resolve(labCodex), real = path.join(os.homedir(), ".codex");
  if (!lab || dir === real || dir.startsWith(real + path.sep)) throw new Error(`E2E_LAB_CODEX_DIR must be a lab Codex folder used with E2E_LAB_HERDR_SOCKET, not ${labCodex}.`);
  sb.env.JOYRIDE_CODEX_DIR = dir;
}
// A marked Firstmate lab home (scripts/lab-fleet.sh, bin/fm-lab-home.sh create) instead of the sandbox's,
// so the fleet's captain inbox notes land where the lab can read them. Never the live home.
const labFm = process.env.E2E_LAB_FM_HOME;
if (labFm) {
  if (!lab || !fs.existsSync(path.join(labFm, ".fm-lab-home"))) throw new Error(`E2E_LAB_FM_HOME must be a marked Firstmate lab home used with E2E_LAB_HERDR_SOCKET, not ${labFm}.`);
  sb.env.FM_HOME = path.resolve(labFm);
}
Object.assign(process.env, sb.env);
const fake = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "fake-herdr.ts");
if (!lab && fs.existsSync(fake)) {
  const { startFakeHerdr } = await import(fake);
  await startFakeHerdr(sb.env.JOYRIDE_HERDR_SOCKET, { scenario: process.env.E2E_HERDR_SCENARIO ?? "default" });
}
await import("../../src/server/main.ts");
