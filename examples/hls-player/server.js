import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";

const configured = process.env.MISO_HLS_ARTIFACT;
if (!configured)
  throw new Error("MISO_HLS_ARTIFACT must name a verified artifact directory");
const root = await realpath(configured);
const assets = new URL("./", import.meta.url);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/")
      return new Response(Bun.file(new URL("index.html", assets)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (pathname === "/player.js")
      return new Response(Bun.file(new URL("player.js", assets)), {
        headers: { "content-type": "text/javascript" },
      });
    if (pathname === "/hls.js")
      return new Response(
        Bun.file(join(process.cwd(), "node_modules/hls.js/dist/hls.min.js")),
        { headers: { "content-type": "text/javascript" } },
      );
    if (!pathname.startsWith("/artifact/"))
      return new Response("Not found", { status: 404 });
    const identifier = pathname.slice("/artifact/".length);
    if (
      identifier !== basename(identifier) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(identifier)
    )
      return new Response("Not found", { status: 404 });
    const file = Bun.file(join(root, identifier));
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": identifier.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "audio/mp4",
      },
    });
  },
});
process.stdout.write(`Local HLS player: ${server.url}\n`);
