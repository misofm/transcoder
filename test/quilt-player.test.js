import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  buildQuiltPatchUrl,
  parseIndex,
} from "../examples/quilt-player/player.js";

describe("static Quilt Listening Room", () => {
  test("rejects the removed encryption field", () => {
    const index = {
      schema: "miso.aac-transcode-quilt/1",
      recordingId: `0x${"00".repeat(32)}`,
      generation: "A".repeat(43),
      masterPlaylist: "master.m3u8",
      segmentTargetMs: 6000,
      patchCount: 11,
      renditions: [],
      encryption: {},
    };
    expect(() =>
      parseIndex(new TextEncoder().encode(JSON.stringify(index))),
    ).toThrow();
  });

  test("pins the exact locally served hls.js browser bundle", async () => {
    const html = await readFile(
      new URL("../examples/quilt-player/index.html", import.meta.url),
      "utf8",
    );
    const bundle = await readFile(
      new URL("../node_modules/hls.js/dist/hls.min.js", import.meta.url),
    );
    const integrity = createHash("sha384").update(bundle).digest("base64");
    expect(html).toContain('src="./hls.min.js"');
    expect(html).toContain(`integrity="sha384-${integrity}"`);
    expect(html).toContain(
      'value="https://aggregator.mainnet.walrus.mirai.cloud"',
    );
    expect(html).toContain("connect-src blob: https:");
  });

  test("constructs strict Quilt HTTP patch URLs", () => {
    const blobId = "A".repeat(43);
    expect(
      buildQuiltPatchUrl(
        "https://aggregator.mainnet.walrus.mirai.cloud/",
        blobId,
        "master.m3u8",
      ),
    ).toBe(
      `https://aggregator.mainnet.walrus.mirai.cloud/v1/blobs/by-quilt-id/${blobId}/master.m3u8`,
    );
    expect(() =>
      buildQuiltPatchUrl("http://example.com", blobId, "master.m3u8"),
    ).toThrow();
    expect(() =>
      buildQuiltPatchUrl("https://example.com", blobId, "aac/96.m3u8"),
    ).toThrow();
  });
});
