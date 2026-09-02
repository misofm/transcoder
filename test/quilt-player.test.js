import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { decodeHex, deriveRootKeyId } from "../examples/quilt-player/player.js";

describe("static Quilt Listening Room", () => {
  test("matches the server library root-key commitment vector", async () => {
    const root = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const recordingId = decodeHex("01".repeat(32), 32);
    expect(await deriveRootKeyId(root, recordingId, nonce)).toBe(
      "0d37753262e83b95312fe181cb376a5adca1f15b704b1c728e3d4bd35de4f570",
    );
    expect(() => decodeHex("AA".repeat(32), 32)).toThrow();
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
    expect(html).not.toMatch(/https?:\/\//u);
  });
});
