import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { finalizeTranscode } from "../src/pipeline/finalize.js";
import type { PreparedTranscode } from "../src/model.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

test("failed finalization zeroes the owned key and cannot promote partial output", async () => {
  const workspace = await mkdtemp(join("/private/tmp", "transcoder-fault-"));
  roots.push(workspace);
  const rootPath = join(workspace, "plaintext", "a".repeat(64));
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const prepared: PreparedTranscode = {
    prepareDigest: "a".repeat(64),
    rootPath,
    sourceSha256: "b".repeat(64),
    durationMs: 1_000,
    sampleRateHz: 48_000,
    segmentTargetMs: 6_000,
    toolchain: {
      ffmpegPath: "/ffmpeg",
      ffprobePath: "/ffprobe",
      ffmpegVersion: "ffmpeg version test",
      ffprobeVersion: "ffprobe version test",
      libavcodecVersion: "test",
      libavformatVersion: "test",
      capabilities: [],
      sha256: "c".repeat(64),
    },
  };
  const rootKey = new Uint8Array(32).fill(7);
  await expect(
    Effect.runPromise(
      finalizeTranscode(
        { prepared, recordingId: `0x${"01".repeat(32)}`, network: "testnet" },
        {
          generationNonce: new Uint8Array(32).fill(8),
          rootKey,
          keySeal: new Uint8Array([1]),
        },
      ),
    ),
  ).rejects.toBeDefined();
  expect(rootKey).toEqual(new Uint8Array(32));
  const generations = join(workspace, "generations");
  expect(
    (await readdir(generations)).every(
      (identifier) => !/^[0-9a-f]{64}$/u.test(identifier),
    ),
  ).toBe(true);
});
