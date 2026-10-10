#!/usr/bin/env node
// joyride-fleet-feed: a Firstmate process-event-adapter/1 package (vendor/firstmate/docs/extension-bindings.md).
// It brings Joyride's fleet events (src/modules/fleet/feed.ts) to Firstmate: a watched session that is
// blocked, needs a decision, failed or is done, and the captain taking or handing back a session's helm.
//
// The source configuration reference is the Joyride daemon's loopback URL, for example
// http://127.0.0.1:4317/?consumer=home-1a2b3c (the installer names one consumer per Firstmate home).
// source.poll long-polls GET <url>/api/fleet/feed with that consumer (else the source id) and the
// host's request id as the idempotence key: a retry before capture gets the same
// batch back, and the daemon counts a batch delivered once the next request id arrives. It returns
// no-result within 50 seconds when nothing happened, or when the daemon is not answering.
// Results are never terminal (the feed keeps running) and never silent (each one is worth a look).
// Logs go to stderr; stdout carries exactly one JSON document.

const ID = "dev.joyride.fleet-feed";
const VERSION = "1.0.0";
const MAX_INPUT_BYTES = 65536;
const MAX_OUTPUT_BYTES = 30000;
const POLL_BUDGET_MS = 50000;
const RETRY_MS = 5000;

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error("request is oversized");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const write = (doc) => process.stdout.write(`${JSON.stringify(doc)}\n`);
const ok = (requestId, result) => write({ schema: "firstmate.extension-response.v1", request_id: requestId, ok: true, result, error: null });
const fail = (requestId, code, retryable, diagnostic) =>
  write({ schema: "firstmate.extension-response.v1", request_id: requestId, ok: false, result: null, error: { code, retryable, diagnostic: String(diagnostic).slice(0, 500) } });

/** The daemon's base URL from the config reference: http on a loopback host only. */
export function daemonUrl(reference) {
  let u;
  try { u = new URL(String(reference)); } catch { return null; }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
  return `${u.protocol}//${u.host}`;
}

/** Which consumer this home is in the daemon's feed: the reference's ?consumer=, else the source id. */
export function consumerOf(reference, sourceId) {
  let named = null;
  try { named = new URL(String(reference)).searchParams.get("consumer"); } catch {}
  return named && /^[A-Za-z0-9._:-]{1,120}$/.test(named) ? named : String(sourceId ?? "");
}

/** Bounded UTF-8: cut at a line end so a multi-byte character is never split. */
export function bounded(text) {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  const lines = text.split("\n");
  while (lines.length > 1 && Buffer.byteLength(lines.join("\n") + "\n- (more events: run joyride fleet events)", "utf8") > MAX_OUTPUT_BYTES) lines.splice(-2, 1);
  return `${lines.join("\n")}\n- (more events: run joyride fleet events)`;
}

/** The classification token Firstmate's handling agent sees, from the feed's first line. */
export function classify(content) {
  const kinds = (String(content).split("\n")[0].match(/kinds=(\S+)/)?.[1] ?? "").split(",");
  if (kinds.some((k) => ["member.blocked", "member.needs-decision", "member.failed"].includes(k))) return "fleet-needs-attention";
  if (kinds.some((k) => k.startsWith("helm."))) return "fleet-helm";
  return "fleet-update";
}

async function poll(request) {
  const base = daemonUrl(request.input?.config_ref);
  if (!base) return fail(request.request_id, "invalid-request", false, "config_ref must be the Joyride daemon's loopback URL, for example http://127.0.0.1:4317");
  const q = new URLSearchParams({ consumer: consumerOf(request.input?.config_ref, request.input?.source_id), request: String(request.request_id).replace(/^sha256:/, ""), wait: "45" });
  const deadline = Date.now() + POLL_BUDGET_MS;
  while (Date.now() < deadline - 1000) {
    let res;
    try { res = await fetch(`${base}/api/fleet/feed?${q}`, { headers: { "x-joyride-feed": "1" }, signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) }); }
    catch (e) {
      process.stderr.write(`joyride-fleet-feed: the daemon at ${base} is not answering (${e?.cause?.code ?? e?.name ?? e}); retrying\n`);
      await new Promise((r) => setTimeout(r, Math.min(RETRY_MS, Math.max(0, deadline - Date.now() - 1000))));
      continue;
    }
    if (res.status >= 400 && res.status < 500) {
      const body = await res.text().catch(() => "");
      return fail(request.request_id, "invalid-request", false, `GET /api/fleet/feed answered ${res.status}: ${body.slice(0, 200)}`);
    }
    if (!res.ok) { process.stderr.write(`joyride-fleet-feed: GET /api/fleet/feed answered ${res.status}\n`); break; }
    const body = await res.json();
    const text = typeof body?.text === "string" ? body.text : "";
    return ok(request.request_id, text.trim() ? { status: "result", output: bounded(text) } : { status: "no-result", output: "" });
  }
  return ok(request.request_id, { status: "no-result", output: "" });
}

async function main() {
  const verb = process.argv[2] || "";
  const request = await readRequest();
  if (verb === "handshake") {
    return write({
      schema: "firstmate.extension-handshake-response.v1", request_id: request.request_id,
      extension_id: ID, extension_version: VERSION, host_protocol: 1,
      capability: "process-event-adapter", capability_version: 1, adapter_names: request.capability?.adapter_names ?? [],
    });
  }
  if (verb !== "invoke") return fail(request.request_id ?? "", "invalid-request", false, `unknown verb ${verb}`);
  switch (request.operation) {
    case "source.poll": return poll(request);
    case "result.classify": return ok(request.request_id, { classification: classify(request.input?.content ?? "") });
    case "result.terminal": return ok(request.request_id, { value: false });
    case "result.silent": return ok(request.request_id, { value: false });
    default: return fail(request.request_id, "invalid-request", false, `unsupported operation ${request.operation}`);
  }
}

// Joyride's unit tests import the helpers above without running a verb.
if (!process.env.JOYRIDE_FLEET_FEED_IMPORT) {
  main().catch((e) => { process.stderr.write(`joyride-fleet-feed: ${e?.stack ?? e}\n`); process.exit(1); });
}
