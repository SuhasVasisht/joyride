import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { z } from "zod";

type Fault = { method: string; mode: "drop" } | { method: string; mode: "delay"; ms: number };
const Request = z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).default({}) });

// Forward to the helper-provisioned lab only. Faults affect replies after the
// real request has completed, so the ownership journal must handle lost acks.
export async function startHerdrReplyRelay(socket: string, target: string) {
  if (!/\/sessions\/fm-lab-[\w-]+\/herdr\.sock$/.test(target)) throw new Error("Reply proof requires a named Herdr lab socket.");
  if (!socket.startsWith(path.resolve(".joyride") + path.sep)) throw new Error("Reply relay must live in this worktree's private runtime.");
  const faults = new Map<string, Fault>(), sockets = new Set<net.Socket>(), timers = new Set<NodeJS.Timeout>();
  const calls: z.infer<typeof Request>[] = [];
  const server = net.createServer(client => {
    const upstream = net.connect(target);
    for (const connection of [client, upstream]) {
      sockets.add(connection);
      connection.on("close", () => sockets.delete(connection));
      connection.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    let fault: Fault | undefined, input = "", answer = "", finished = false;
    const inspect = (chunk: Buffer) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = Request.parse(JSON.parse(input.slice(0, input.indexOf("\n"))));
      calls.push(request); fault = faults.get(request.method); faults.delete(request.method);
      client.off("data", inspect);
    };
    client.on("data", inspect);
    client.pipe(upstream);
    upstream.on("data", (chunk: Buffer) => {
      if (!fault) { client.write(chunk); return; }
      if (finished) return;
      answer += chunk.toString();
      if (!answer.includes("\n")) return;
      finished = true;
      upstream.destroy();
      if (fault.mode === "drop") { client.destroy(); return; }
      const timer = setTimeout(() => { timers.delete(timer); if (!client.destroyed) client.end(answer); }, fault.ms);
      timers.add(timer);
    });
    upstream.on("end", () => { if (!fault) client.end(); });
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return {
    socket, calls, arm: (fault: Fault) => faults.set(fault.method, fault),
    stop: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const connection of sockets) connection.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (fs.existsSync(socket)) fs.unlinkSync(socket);
    },
  };
}
