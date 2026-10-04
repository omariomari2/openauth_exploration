import assert from "node:assert/strict";
import { createServer } from "node:http";

// This listener only denies traffic. The one allowed origin bypasses it and
// reaches the real Worker directly; no requests or credentials are forwarded.
export async function createBrowserNetwork(origin) {
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const blocked = [];
  function record(request) {
    let destination = "invalid destination";
    try { destination = new URL(request.method === "CONNECT" ? `https://${request.url}` : request.url).origin; }
    catch {}
    blocked.push(`Blocked browser destination: ${destination}`);
  }
  const server = createServer((request, response) => {
    record(request);
    response.writeHead(403, { "Content-Type": "text/plain", Connection: "close" });
    response.end("Blocked browser destination");
  });
  const denySocket = (request, socket) => {
    record(request);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  server.on("connect", denySocket);
  server.on("upgrade", denySocket);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    // Explicit Chromium flags protect popups before their first request without
    // changing Node's context.request proxy/cookie behavior. Order matters:
    // subtract implicit loopback bypass first, then allow only the Worker origin.
    args: [`--proxy-server=http://127.0.0.1:${server.address().port}`, `--proxy-bypass-list=<-loopback>;${origin}`],
    assertNoUnexpectedRequests() { assert.deepEqual(blocked, [], "browser network stays within the allowed origin"); },
    async dispose() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
