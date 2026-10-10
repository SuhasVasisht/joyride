// A stand-in for the Anthropic Messages API on 127.0.0.1, for lab runs with a real Claude Code
// (scripts/lab-images.sh). It records what each request carried (text, and every image block's
// media type, size and sha256) to a JSONL log, and answers with a short streamed reply that says
// which images reached it. A prompt that says "lab: slow <n>s" keeps its turn streaming for n
// seconds first, and "lab: tool <n>s" does the same and then reads a file (a turn with a tool call),
// so scripts/lab-staged.sh can reply while the agent is busy. The file is LAB_TOOL_FILE, which should
// sit in the agent's folder so reading it needs no permission. "lab: bash <command>" asks to run that
// shell command with the Bash tool, which a Claude Code in default permission mode stops to ask about
// (scripts/lab-fleet.sh answers that prompt through Joyride). Firstmate's inbox doorbell (": Firstmate
// instruction waiting: …") makes it act as a crewmate that follows its brief: one Bash call that prints
// every message in "$FM_TASK_INBOX" and moves each into handled/, the worker's acknowledgement
// (scripts/lab-control-plane.sh). Nothing leaves the machine.
//   node tests/fixtures/fake-anthropic.mjs <log.jsonl> <port-file> [port]
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

const [logFile, portFile, fixedPort] = process.argv.slice(2);
/** A crewmate's answer to Firstmate's doorbell: read each steering message, then move it into handled/. */
const ACK_INBOX = 'mkdir -p "$FM_TASK_INBOX/handled" && for f in "$FM_TASK_INBOX"/*.msg; do [ -e "$f" ] || continue; cat "$f"; mv "$f" "$FM_TASK_INBOX/handled/"; done';

/** Image blocks anywhere in the request (prompts, tool results). */
function images(node, out = []) {
  if (Array.isArray(node)) for (const x of node) images(x, out);
  else if (node && typeof node === "object") {
    if (node.type === "image" && node.source?.type === "base64") {
      const buf = Buffer.from(node.source.data ?? "", "base64");
      out.push({ type: "image", source_type: "base64", media_type: node.source.media_type, bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") images(v, out);
  }
  return out;
}
const lastUserText = (body) => {
  const u = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const c = u?.content;
  return typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const imgs = images(body.messages ?? []);
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), method: req.method, url: req.url, model: body.model ?? null, stream: Boolean(body.stream), text: lastUserText(body).slice(-4000), images: imgs }) + "\n");
    if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "lab" } })); return; }
    if (req.url.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 10 })); return; }
    const asked = lastUserText(body);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const afterTool = Array.isArray(lastUser?.content) && lastUser.content.some((b) => b.type === "tool_result");
    // Only the agent's own requests (they carry tools) slow down, not its side calls such as titles.
    const agentTurn = Array.isArray(body.tools) && body.tools.length > 0;
    const tool = afterTool || !agentTurn ? 0 : Number(asked.match(/lab: tool (\d+)s/)?.[1] ?? 0);
    const slow = tool || (agentTurn ? Number(asked.match(/lab: slow (\d+)s/)?.[1] ?? 0) : 0);
    const bash = afterTool || !agentTurn ? null : asked.match(/lab: bash (.+)$/m)?.[1]?.trim() ?? (asked.includes("Firstmate instruction waiting") ? ACK_INBOX : null);
    const said = asked.slice(-200).replace(/\s+/g, " ").trim();
    const text = bash ? `Lab model: I'll run \`${bash}\`.`
      : slow ? `Lab model: that took ${slow}s.`
      : afterTool ? `Lab model: the tool ran. Since then you said: ${said || "nothing"}`
      : imgs.length ? `Lab model: I received ${imgs.length} image${imgs.length === 1 ? "" : "s"} (${imgs.map((i) => `${i.media_type}, ${i.bytes} bytes, sha256 ${i.sha256.slice(0, 12)}`).join("; ")}).`
      : `Lab model: no image in this message. You said: ${said}`;
    const message = { id: `msg_lab_${Date.now()}`, type: "message", role: "assistant", model: body.model ?? "lab", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const finish = () => {
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      ev("content_block_stop", { index: 0 });
      if (tool || bash) {
        const [name, input] = bash ? ["Bash", { command: bash, description: "Lab command" }] : ["Read", { file_path: process.env.LAB_TOOL_FILE ?? "/etc/hosts" }];
        ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: `toolu_lab_${Date.now()}`, name, input: {} } });
        ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        ev("content_block_stop", { index: 1 });
      }
      ev("message_delta", { delta: { stop_reason: tool || bash ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
      ev("message_stop", {});
      res.end();
    };
    if (!slow) return finish();
    // Keep the stream alive (pings) so the agent shows a running turn, not a stalled request.
    const ping = setInterval(() => res.write(`event: ping\ndata: {"type":"ping"}\n\n`), 1000);
    setTimeout(() => { clearInterval(ping); finish(); }, slow * 1000);
  });
});
server.listen(Number(fixedPort) || 0, "127.0.0.1", () => { fs.writeFileSync(portFile, String(server.address().port)); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
