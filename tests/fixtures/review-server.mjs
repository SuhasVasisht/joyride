import http from "node:http";
const [port, label = "Review fixture"] = process.argv.slice(2);
const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(`<title>${label}</title><h1>${label}</h1><p>Safe local review server</p>`); });
server.listen(Number(port), "127.0.0.1", () => console.log(`${label} ready on http://127.0.0.1:${server.address().port}`));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => server.close(() => process.exit(0)));
