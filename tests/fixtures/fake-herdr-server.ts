// `herdr server` stand-in process for manager tests: the fake Herdr on $HERDR_SOCKET_PATH until signalled.
import { startFakeHerdr } from "./fake-herdr.ts";

const sock = process.env.HERDR_SOCKET_PATH;
if (!sock) { console.error("HERDR_SOCKET_PATH is not set"); process.exit(2); }
const fake = await startFakeHerdr(sock, { scenario: process.env.FAKE_HERDR_SCENARIO ?? "empty", version: "managed-fake" });
console.log(`fake herdr server running; api socket: ${sock}`);
const bye = async () => { await fake.stop(); process.exit(0); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
setInterval(() => {}, 1 << 30);
