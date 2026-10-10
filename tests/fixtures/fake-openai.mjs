// A stand-in for the OpenAI Responses API on 127.0.0.1, for lab runs with a real Codex
// (scripts/lab-staged.sh). It logs the last user text of each request to a JSONL file and answers
// with a short streamed reply. A prompt that says "lab: slow <n>s" keeps its turn streaming for n
// seconds first, so a reply can be sent while Codex is busy. Nothing leaves the machine.
//   node tests/fixtures/fake-openai.mjs <log.jsonl> <port-file>
import http from "node:http";
import fs from "node:fs";

const [logFile, portFile] = process.argv.slice(2);

const lastUserText = (body) => {
  const items = Array.isArray(body.input) ? body.input : [];
  const u = [...items].reverse().find((m) => m.role === "user");
  const c = u?.content;
  return typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "input_text").map((b) => b.text).join("\n");
};

let n = 0;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const asked = lastUserText(body);
    fs.appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), method: req.method, url: req.url, model: body.model ?? null, text: asked.slice(-4000) }) + "\n");
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [] })); return; }
    if (!req.url?.startsWith("/v1/responses")) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "lab", type: "not_found" } })); return; }
    const slow = Number(asked.match(/lab: slow (\d+)s/)?.[1] ?? 0);
    const text = slow ? `Lab model: that took ${slow}s.` : `Lab model: you said: ${asked.slice(-200).replace(/\s+/g, " ").trim()}`;
    const id = `resp_lab_${++n}`, item = `msg_lab_${n}`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    ev("response.output_item.added", { output_index: 0, item: { id: item, type: "message", role: "assistant", status: "in_progress", content: [] } });
    const finish = () => {
      ev("response.output_text.delta", { item_id: item, output_index: 0, content_index: 0, delta: text });
      ev("response.output_item.done", { output_index: 0, item: { id: item, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } });
      ev("response.completed", { response: { id, object: "response", status: "completed", output: [], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 } } });
      res.end();
    };
    if (!slow) return finish();
    setTimeout(finish, slow * 1000);
  });
});
server.listen(0, "127.0.0.1", () => { fs.writeFileSync(portFile, String(server.address().port)); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
