import { execFile } from "node:child_process";
import path from "node:path";
import { paths } from "../shared/paths.ts";

const exec = (file: string, args: string[]): Promise<string> => new Promise((resolve) => execFile(file, args, { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? "")));
export async function otherDaemons() {
  const ps = await exec("ps", ["-axo", "pid=,args="]);
  const pids = ps.split("\n").filter((line) => /(?:^|\s)\S*src\/server\/main\.ts(?:\s|$)/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid > 0 && pid !== process.pid);
  const daemons = await Promise.all(pids.map(async (pid) => {
    const [dir, sockets] = await Promise.all([exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]), exec("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])]);
    const cwd = dir.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "unknown";
    const ports = sockets.split("\n").filter((l) => l.startsWith("n")).map((l) => Number(l.match(/:(\d+)$/)?.[1])).filter(Boolean);
    return { pid, cwd, ports, other_checkout: cwd !== paths.code };
  }));
  return daemons.filter((d) => d.ports.length);
}

export async function checkPortOwner(port: number): Promise<void> {
  let h: unknown;
  try { h = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).json(); } catch { return; }
  if (h && typeof h === "object" && "pid" in h) {
    const root = "root" in h ? String(h.root) : "unknown";
    const code = "code" in h ? String(h.code) : root;
    throw new Error(`Port ${port} already has Joyride pid ${h.pid} from ${path.resolve(code)} (data ${root}). Use its checkout to stop it, or choose a private port.`);
  }
}

export async function assertDaemonProcess(pid: number, code = paths.code) {
  const args = await exec("ps", ["-p", String(pid), "-o", "args="]);
  if (!args.includes(path.join(code, "src/server/main.ts"))) throw new Error(`Pid ${pid} is not this checkout's Joyride daemon. Refusing to stop it.`);
}
