import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("example player is local and storage-neutral", async () => {
  const files = await Promise.all(
    ["README.md", "index.html", "player.js", "server.js"].map((name) =>
      readFile(
        new URL(`../examples/hls-player/${name}`, import.meta.url),
        "utf8",
      ),
    ),
  );
  expect(files.join("\n")).toContain("master.m3u8");
  expect(files.join("\n")).not.toMatch(
    /https?:\/\/|walrus|quilt|\bR2\b|blobId|recordingId/iu,
  );
});
