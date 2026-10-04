import html from "./demo/page.html";
import css from "./demo/styles.css";
import client from "./demo/client.mjs";
import view from "./demo/view.mjs";

// Text modules travel with the Worker; no separate asset host or build tool.
// https://developers.cloudflare.com/workers/wrangler/configuration/#modules
const assets = new Map([
  ["/", { body: html, type: "text/html" }],
  ["/assets/demo.css", { body: css, type: "text/css" }],
  ["/assets/demo.mjs", { body: client, type: "text/javascript" }],
  ["/assets/view.mjs", { body: view, type: "text/javascript" }],
]);

export function handleDemoRequest(request: Request): Response | null {
  const asset = assets.get(new URL(request.url).pathname);
  if (!asset) return null;
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  return new Response(request.method === "HEAD" ? null : asset.body, {
    headers: { "Content-Type": `${asset.type}; charset=utf-8` },
  });
}
