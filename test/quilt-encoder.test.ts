import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { Effect } from "effect";

import { encodeWalrusQuilt, quiltPatchTags } from "../src/quilt/encoder.js";

const fixture = [
  {
    identifier: "index.json",
    contents: new TextEncoder().encode("{}\n"),
    tags: quiltPatchTags("index.json"),
  },
  {
    identifier: "aac-96-00000.m4s",
    contents: new Uint8Array([1, 2, 3]),
    tags: quiltPatchTags("aac-96-00000.m4s"),
  },
] as const;

test("encodes the pinned deterministic Walrus Quilt contract", async () => {
  const forward = await Effect.runPromise(encodeWalrusQuilt(fixture));
  const reverse = await Effect.runPromise(
    encodeWalrusQuilt([...fixture].reverse()),
  );
  expect(forward.bytes).toEqual(reverse.bytes);
  expect(forward.bytes.byteLength).toBe(445_556);
  expect(createHash("sha256").update(forward.bytes).digest("hex")).toBe(
    "0c707a2490267d5e8634c3d9a2baa663e4d85c5ab2528307208b649e10167b8b",
  );
  expect(forward.patches.map((patch) => patch.identifier)).toEqual([
    "aac-96-00000.m4s",
    "index.json",
  ]);
  expect(forward.patches[0]).toEqual({
    identifier: "aac-96-00000.m4s",
    startIndex: 1,
    endIndex: 2,
    tags: {
      "content-type": "audio/mp4",
    },
  });
});

test("fails closed for empty and over-count Quilt sources", async () => {
  await expect(Effect.runPromise(encodeWalrusQuilt([]))).rejects.toMatchObject({
    _tag: "QuiltEncodingError",
  });
  await expect(
    Effect.runPromise(
      encodeWalrusQuilt([
        ...Array.from({ length: 667 }, (_, index) => ({
          identifier: `file-${index}.m4s`,
          contents: new Uint8Array([index % 256]),
          tags: {},
        })),
      ]),
    ),
  ).rejects.toMatchObject({ _tag: "QuiltEncodingError" });
});

test("assigns only delivery-oriented content-type tags", () => {
  expect(quiltPatchTags("master.m3u8")).toEqual({
    "content-type": "application/vnd.apple.mpegurl",
  });
  expect(quiltPatchTags("aac-256-init.mp4")["content-type"]).toBe("audio/mp4");
  expect(() => quiltPatchTags("unknown.txt")).toThrow();
});
