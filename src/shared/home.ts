// Where a checkout keeps its authored data and runtime. A gitignored `.joyride.env`
// beside the code can name a separate data home, so the code checkout carries no
// personal data. Dependency-light: the hook imports it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOCAL_ENV_FILE = ".joyride.env";
const KEYS = ["JOYRIDE_HOME", "JOYRIDE_RUNTIME"] as const;
export type LocalHome = Partial<Record<(typeof KEYS)[number], string>>;

const expand = (codeRoot: string, value: string) =>
  path.resolve(codeRoot, value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);

/** JOYRIDE_HOME and JOYRIDE_RUNTIME: the environment wins, then `<codeRoot>/.joyride.env`.
 * Tests never read the file, so a sandbox cannot reach the real data home. */
export function localHome(codeRoot: string, env: NodeJS.ProcessEnv = process.env): LocalHome {
  const out: LocalHome = {};
  let text = "";
  if (!env.VITEST && !env.JOYRIDE_TEST) try { text = fs.readFileSync(path.join(codeRoot, LOCAL_ENV_FILE), "utf8"); } catch {}
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(JOYRIDE_HOME|JOYRIDE_RUNTIME)\s*=\s*(.*?)\s*$/);
    const value = m?.[2].replace(/^['"]|['"]$/g, "");
    if (m && value) out[m[1] as keyof LocalHome] = expand(codeRoot, value);
  }
  for (const k of KEYS) if (env[k]) out[k] = env[k];
  return out;
}
