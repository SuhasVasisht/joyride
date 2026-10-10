import { execFile } from "node:child_process";
import { z } from "zod";

export const HANDOFF_FILING_TIMEOUT_MS = 180_000;
const Receipt = z.object({ saved: z.literal(true), id: z.string(), outcome: z.string(), announced: z.boolean().nullable().optional(), path: z.string() });

/** Exit 3 still confirms a durable note; its wake can wait for the successor. */
export function fileInboxNote(opts: { script: string; cwd: string; env: NodeJS.ProcessEnv; requestId: string; body: string; timeoutMs?: number }) {
  const timeout = opts.timeoutMs ?? 30_000;
  return new Promise<{ note: string; outcome: string; announced: boolean | null; path: string }>((resolve, reject) => {
    const child = execFile(opts.script, ["note", "--request-id", opts.requestId, "--json", "-"], { env: opts.env, cwd: opts.cwd, timeout, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      let receipt: z.infer<typeof Receipt> | null = null;
      try { const parsed = Receipt.safeParse(JSON.parse(line ?? "null")); if (parsed.success) receipt = parsed.data; } catch {}
      if (receipt && (!err || err.code === 3)) return resolve({ note: receipt.id, outcome: receipt.outcome, announced: receipt.announced ?? null, path: receipt.path });
      const output = `${stdout}${stderr}`.trim().slice(-1200);
      const reason = err?.killed ? `timed out after ${timeout / 1000} seconds` : `exit ${err?.code ?? "?"}`;
      reject(new Error(`fm-inbox.sh could not file the inbox note (${reason}): ${output || err?.message || "no output"}`));
    });
    child.stdin?.on("error", () => { /* execFile reports an early child exit. */ });
    child.stdin?.end(opts.body);
  });
}
