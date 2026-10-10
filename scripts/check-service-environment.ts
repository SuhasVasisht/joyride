// Safe launchd-environment smoke check: no launchctl and no feature modules,
// so this cannot connect to or start Herdr, agents or the live Joyride daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { serviceEnvironment } from "../src/cli/service.ts";

fs.mkdirSync(path.resolve(".joyride"), { recursive: true });
const root = fs.mkdtempSync(path.resolve(".joyride/service-check-"));
try {
  const env = serviceEnvironment({ home: os.homedir(), node: process.execPath, root, runtime: path.join(root, ".joyride"), shellPath: process.env.PATH });
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { once } from 'node:events';
    import { serve } from '@hono/node-server';
    import { createDaemon } from './src/server/app.ts';
    import { checkRuntimeTools } from './src/core/runtime-tools.ts';
    const daemon = await createDaemon({ only: [] });
    const server = serve({ fetch: daemon.app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      await daemon.start();
      const address = server.address();
      assert(address && typeof address !== 'string');
      assert.notEqual(address.port, 4317);
      assert.notEqual(address.port, 3000);
      const health = await (await fetch('http://127.0.0.1:' + address.port + '/api/health')).json();
      assert.deepEqual(health.modules, []);
      const tools = checkRuntimeTools();
      assert.deepEqual(health.runtime_tools, tools);
      console.log(JSON.stringify({ port: address.port, tools }, null, 2));
      assert.deepEqual(tools.missing, [], 'The plist environment must resolve every audited tool');
      for (const tool of tools.tools) {
        const resolved = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'check', tool.name], { encoding: 'utf8' }).trim();
        assert.equal(resolved, tool.path);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await daemon.stop();
      daemon.ctx.db.close();
    }
  `], { env, stdio: "inherit", timeout: 20000 });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally { fs.rmSync(root, { recursive: true, force: true }); }
