import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { z } from 'zod';
import { buildSandbox } from '../tests/sandbox.ts';
import { CODE_ROOT } from '../src/shared/paths.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const Health = z.object({ ok: z.literal(true), pid: z.number(), root: z.string(), code: z.string() });
const Owner = z.object({ pid: z.number() });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function privatePort() {
  for (let port = 4320; port <= 4329; port++) {
    const s = net.createServer();
    const free = await new Promise<boolean>((resolve) => { s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => resolve(true)); });
    if (free) { await new Promise<void>((resolve) => s.close(() => resolve())); return port; }
  }
  throw new Error('No private preview port available');
}
const port = await privatePort();
const lab = path.join(CODE_ROOT, '.joyride', `supervisor-check-${Date.now()}`);
const sb = buildSandbox(lab, { port });
const env = { ...process.env, ...sb.env, HOME: path.join(lab, 'user'), JOYRIDE_MANAGE_HERDR: '0', JOYRIDE_WATCHDOG_MS: '2500' };
fs.mkdirSync(env.HOME, { recursive: true });
const runtime = sb.env.JOYRIDE_RUNTIME;
const url = `http://127.0.0.1:${port}/api/health`;
const knownDaemons = new Set<number>();
let supervisor: number | null = null;
async function cli(command: string) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(CODE_ROOT, 'src/cli/joyride.ts'), command], { cwd: CODE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
  });
}
async function health() {
  try { return Health.parse(await (await fetch(url, { signal: AbortSignal.timeout(200) })).json()); } catch { return null; }
}
async function recovered(previous?: number) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const h = await health();
    if (h && h.pid !== previous) {
      assert.equal(h.code, CODE_ROOT); assert.equal(h.root, sb.env.JOYRIDE_HOME);
      knownDaemons.add(h.pid); return h;
    }
    await sleep(50);
  }
  throw new Error(`Recovery timed out on private port ${port}`);
}
try {
  console.log(`Private recovery lab: ${lab}, port ${port}; real Herdr management disabled`);
  console.log((await Promise.all([cli('up'), cli('up'), cli('up')])).join(''));
  supervisor = Owner.parse(JSON.parse(fs.readFileSync(path.join(runtime, 'supervisor.pid'), 'utf8'))).pid;
  const initial = await recovered();
  // The launching CLI processes have exited. The supervisor has its own process group.
  const processInfo = execFileSync('ps', ['-p', String(supervisor), '-o', 'ppid=,pgid='], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  assert.equal(processInfo[0], 1); assert.equal(processInfo[1], supervisor);
  console.log(`Detached supervisor ${supervisor} survived all launching CLIs, parent pid 1`);
  await cli('up');
  assert.equal(Owner.parse(JSON.parse(fs.readFileSync(path.join(runtime, 'supervisor.pid'), 'utf8'))).pid, supervisor);
  assert.equal((await recovered()).pid, initial.pid);
  console.log('Concurrent and repeated up kept one supervisor and one daemon');
  process.kill(initial.pid, 'SIGKILL');
  const afterCrash = await recovered(initial.pid);
  assert.equal(alive(initial.pid), false);
  console.log(`SIGKILL recovery: daemon ${initial.pid} replaced by ${afterCrash.pid}`);
  const stoppedAt = Date.now();
  process.kill(afterCrash.pid, 'SIGSTOP');
  const afterWedge = await recovered(afterCrash.pid);
  assert.equal(alive(afterCrash.pid), false);
  assert.ok(Date.now() - stoppedAt >= 2500);
  assert.match(fs.readFileSync(path.join(runtime, 'supervisor.log'), 'utf8'), /watchdog: daemon pid .*did not answer health/);
  console.log(`SIGSTOP recovery: daemon ${afterCrash.pid} replaced by ${afterWedge.pid} after external watchdog`);
  let outageAt: number | null = null;
  let availableAt: number | null = null;
  let monitoring = true;
  const monitor = (async () => {
    const deadline = Date.now() + 15000;
    while (monitoring && availableAt === null) {
      if (Date.now() > deadline) throw new Error('Restart monitoring timed out');
      const h = await health();
      if (!h && outageAt === null) outageAt = Date.now();
      if (h && h.pid !== afterWedge.pid) { availableAt = Date.now(); knownDaemons.add(h.pid); }
      await sleep(20);
    }
  })();
  try { await cli('restart'); await monitor; }
  finally { monitoring = false; await monitor; }
  const downtime = availableAt! - (outageAt ?? availableAt!);
  assert.ok(downtime < 2000, `Restart downtime ${downtime} ms exceeds 2 seconds`);
  assert.equal(Owner.parse(JSON.parse(fs.readFileSync(path.join(runtime, 'supervisor.pid'), 'utf8'))).pid, supervisor);
  assert.equal(alive(afterWedge.pid), false);
  console.log(`Explicit restart kept supervisor ${supervisor}; measured HTTP downtime ${downtime} ms`);
  assert.match(await cli('status'), new RegExp(`supervisor pid ${supervisor}, running, daemon pid`));
  await cli('down');
  assert.equal(alive(supervisor), false);
  for (const pid of knownDaemons) assert.equal(alive(pid), false);
  assert.equal(await health(), null);
  console.log('Down stopped supervisor and every owned daemon; private recovery checks passed');
} finally {
  // Cleanup addresses only pids read from this lab's own files.
  const supervisorFile = path.join(runtime, 'supervisor.pid');
  if (supervisor === null && fs.existsSync(supervisorFile)) supervisor = Owner.parse(JSON.parse(fs.readFileSync(supervisorFile, 'utf8'))).pid;
  if (supervisor && alive(supervisor)) { try { await cli('down'); } catch { process.kill(supervisor, 'SIGKILL'); } }
  const daemonFile = path.join(runtime, 'daemon.json');
  if (fs.existsSync(daemonFile)) knownDaemons.add(Owner.parse(JSON.parse(fs.readFileSync(daemonFile, 'utf8'))).pid);
  for (const pid of knownDaemons) if (alive(pid)) process.kill(pid, 'SIGKILL');
}
