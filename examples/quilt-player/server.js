import { join } from "node:path";

const root = import.meta.dir;
const assets = new Map([
  ["/", [join(root, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [join(root, "index.html"), "text/html; charset=utf-8"]],
  ["/player.js", [join(root, "player.js"), "text/javascript; charset=utf-8"]],
  ["/styles.css", [join(root, "styles.css"), "text/css; charset=utf-8"]],
  [
    "/hls.min.js",
    [
      join(root, "../../node_modules/hls.js/dist/hls.min.js"),
      "text/javascript; charset=utf-8",
    ],
  ],
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  fetch(request) {
    const asset = assets.get(new URL(request.url).pathname);
    if (asset === undefined) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(asset[0]), {
      headers: {
        "content-type": asset[1],
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
});

process.stdout.write(`Quilt Listening Room: ${server.url}\n`);
