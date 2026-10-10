import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Daemon calls and the Firstmate helpers it launches, including alternate harnesses
// and the tmux backend. Resolve PATH only: a fallback discovery path cannot make
// a bare command in a child process executable.
export const RUNTIME_TOOLS = ["herdr", "claude", "codex", "cursor-agent", "treehouse", "quota-axi", "git", "tmux", "lavish-axi", "bun", "node", "jq", "tasks-axi"];
export const RuntimeToolCheck = z.object({
  path: z.string(),
  tools: z.array(z.object({ name: z.string(), path: z.string().nullable() })),
  missing: z.array(z.string()),
});

export function checkRuntimeTools(env: NodeJS.ProcessEnv = process.env, log?: (message: string) => void): z.infer<typeof RuntimeToolCheck> {
  const searchPath = env.PATH ?? "";
  const dirs = [...new Set(searchPath.split(path.delimiter))];
  const tools = RUNTIME_TOOLS.map((name) => {
    for (const dir of dirs) {
      const candidate = path.resolve(dir, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return { name, path: candidate };
      } catch { /* Missing, unreadable or non-executable candidates do not stop startup. */ }
    }
    log?.(`Cannot resolve ${name} on daemon PATH. Install it or add its directory to PATH, then reinstall the Joyride service from that shell.`);
    return { name, path: null };
  });
  return { path: searchPath, tools, missing: tools.filter((tool) => tool.path === null).map((tool) => tool.name) };
}

export function runtimeToolStatus(check: z.infer<typeof RuntimeToolCheck>) {
  return check.missing.length ? `missing on PATH: ${check.missing.join(", ")}. Install the tools or reinstall the service from a shell that resolves them.` : `all ${check.tools.length} tools resolve on PATH`;
}
