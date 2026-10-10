import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { paths } from "../shared/paths.ts";
import { ensureDir, writeJsonAtomic } from "../core/util.ts";
import { supervisorOwner } from "./supervisor.ts";

export const SERVICE_LABEL = "com.joyride.daemon";
type Options = { home: string; code: string; root: string; runtime: string; node: string; shellPath?: string; uid: number; launchctl: (args: string[], optional?: boolean) => string };
export const serviceOptions = (): Options => ({ home: os.homedir(), code: paths.code, root: paths.root, runtime: paths.runtime, node: process.execPath, shellPath: process.env.PATH, uid: process.getuid?.() ?? 0, launchctl: (args, optional = false) => {
  try { return execFileSync("launchctl", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (e) { if (optional) return "not loaded"; throw e; }
} });
const plistPath = (o: Options) => path.join(o.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
const manifestPath = (o: Options) => path.join(o.runtime, "install", "service.json");
const domain = (o: Options) => `gui/${o.uid}`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serviceEnvironment(o: Pick<Options, "home" | "node" | "root" | "runtime" | "shellPath">) {
  const shellPath = o.shellPath ?? process.env.PATH ?? "";
  const dirs = [...(shellPath ? shellPath.split(path.delimiter) : []), path.dirname(o.node), path.join(o.home, ".local/bin"), path.join(o.home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return { PATH: [...new Set(dirs)].join(path.delimiter), HOME: o.home, JOYRIDE_HOME: o.root, JOYRIDE_RUNTIME: o.runtime, JOYRIDE_SUPERVISED: "1" };
}

export function servicePlist(o: Options) {
  const env = serviceEnvironment(o);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(o.node)}</string><string>--import</string><string>tsx</string><string>${xml(path.join(o.code, "src/server/main.ts"))}</string></array>
<key>WorkingDirectory</key><string>${xml(o.code)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>1</integer>
<key>ProcessType</key><string>Interactive</string>
<key>ExitTimeOut</key><integer>1</integer>
<key>StandardOutPath</key><string>${xml(path.join(o.runtime, "daemon.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(o.runtime, "daemon.log"))}</string>
</dict></plist>
`;
}

export function serviceInstalled(o = serviceOptions()) {
  return fs.existsSync(plistPath(o));
}
export function assertServiceOwner(o = serviceOptions()) {
  const content = fs.readFileSync(plistPath(o), "utf8");
  if (!content.includes(`<string>${xml(o.code)}</string>`)) throw new Error(`The installed Joyride service belongs to another checkout. Use that checkout to control it: ${plistPath(o)}`);
}
export function serviceUp(o = serviceOptions()) {
  assertServiceOwner(o);
  o.launchctl(["bootstrap", domain(o), plistPath(o)], true);
  return o.launchctl(["kickstart", `${domain(o)}/${SERVICE_LABEL}`]);
}
export function serviceDown(o = serviceOptions()) {
  assertServiceOwner(o);
  return o.launchctl(["bootout", `${domain(o)}/${SERVICE_LABEL}`], true);
}
export function serviceRestart(o = serviceOptions()) {
  assertServiceOwner(o);
  o.launchctl(["bootstrap", domain(o), plistPath(o)], true);
  return o.launchctl(["kickstart", "-k", `${domain(o)}/${SERVICE_LABEL}`]);
}
export function installService(o = serviceOptions()): string[] {
  assertServiceLocation(o);
  if (supervisorOwner(o.runtime)) throw new Error("Joyride's supervisor is running. Run joyride down before installing the launchd service.");
  ensureDir(path.dirname(plistPath(o)));
  ensureDir(o.runtime);
  const next = servicePlist(o);
  let existing: string | null = null;
  try { existing = fs.readFileSync(plistPath(o), "utf8"); } catch {}
  if (existing === next) { serviceUp(o); return ["service already installed; launchd is supervising Joyride"]; }
  let backup: string | null = null;
  let hadManifest = false;
  try { hadManifest = fs.existsSync(manifestPath(o)); } catch {}
  if (existing !== null) {
    const backups = ensureDir(path.join(o.runtime, "backups", `service-${Date.now()}`));
    backup = path.join(backups, `${SERVICE_LABEL}.plist`);
    fs.writeFileSync(backup, existing, { mode: 0o600 });
  }
  // Preserve the original predecessor across repeated updates of our own installed plist.
  if (!hadManifest) writeJsonAtomic(manifestPath(o), { original: backup });
  let stopped: number | null = null;
  try {
    const info: unknown = JSON.parse(fs.readFileSync(path.join(o.runtime, "daemon.json"), "utf8"));
    if (info && typeof info === "object" && "pid" in info && typeof info.pid === "number") {
      const argv = execFileSync("ps", ["-p", String(info.pid), "-o", "args="], { encoding: "utf8", timeout: 1000 });
      if (!argv.includes(path.join(o.code, "src/server/main.ts"))) throw new Error(`Pid ${info.pid} is not this checkout's Joyride daemon. Refusing to stop it.`);
      process.kill(info.pid, "SIGTERM");
      stopped = info.pid;
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("Refusing")) throw e;
  }
  o.launchctl(["bootout", `${domain(o)}/${SERVICE_LABEL}`], true);
  fs.writeFileSync(plistPath(o), next);
  try { o.launchctl(["bootstrap", domain(o), plistPath(o)]); }
  catch (e) {
    if (existing !== null) fs.writeFileSync(plistPath(o), existing);
    else fs.rmSync(plistPath(o), { force: true });
    if (!hadManifest) fs.rmSync(manifestPath(o), { force: true });
    throw new Error(`launchd did not load Joyride. Restored the previous plist; run joyride up to recover. ${e instanceof Error ? e.message : String(e)}`);
  }
  return [`wrote ${plistPath(o)} (KeepAlive, RunAtLoad, throttle 1 s, Interactive)`, ...(backup ? [`backed up the previous plist to ${backup}`] : []), ...(stopped ? [`stopped this checkout's manual daemon pid ${stopped}`] : []), "launchd now restarts crashed or wedged daemons; down unloads it until up"];
}

export function assertServiceLocation(o: Pick<Options, "home" | "code" | "root" | "runtime" | "node">) {
  const resolved = (folder: string): string => {
    try { return fs.realpathSync(folder); }
    catch { const parent = path.dirname(folder); return parent === folder ? folder : path.join(resolved(parent), path.basename(folder)); }
  };
  const home = resolved(o.home);
  for (const root of [o.code, o.root, o.runtime]) {
    const actual = resolved(path.resolve(root));
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      const protectedRoot = path.join(home, folder);
      if (actual === protectedRoot || actual.startsWith(protectedRoot + path.sep)) {
        throw new Error(`Cannot install the launchd service: ${root} is under ${protectedRoot}, a macOS privacy-protected folder. Grant Full Disk Access to the node binary (${o.node}), or move the repo and data outside Documents, Desktop and Downloads. No files were written. The detached supervisor started by joyride up already covers crashes and unresponsive daemons without new OS permissions.`);
      }
    }
  }
}
export function uninstallService(o = serviceOptions()): string[] {
  if (!serviceInstalled(o)) return ["service is not installed"];
  assertServiceOwner(o);
  let original: string | null = null;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(manifestPath(o), "utf8"));
    if (value && typeof value === "object" && "original" in value && typeof value.original === "string") original = value.original;
  } catch {}
  o.launchctl(["bootout", `${domain(o)}/${SERVICE_LABEL}`], true);
  if (original) fs.copyFileSync(original, plistPath(o));
  else fs.unlinkSync(plistPath(o));
  fs.rmSync(manifestPath(o), { force: true });
  return [original ? `restored ${plistPath(o)} from ${original}; it is left unloaded` : `removed ${plistPath(o)}`];
}
export function serviceStatus(o = serviceOptions()) {
  if (!serviceInstalled(o)) return "not installed";
  const r = o.launchctl(["print", `${domain(o)}/${SERVICE_LABEL}`], true);
  return `launchd ${r.match(/state = (\w+)/)?.[1] ?? "unloaded"}${r.match(/pid = (\d+)/)?.[1] ? ` pid ${r.match(/pid = (\d+)/)?.[1]}` : ""}`;
}
