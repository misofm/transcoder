import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import {
  encryptFileAtomic,
  finalizeTranscode,
} from "../src/pipeline/finalize.js";
import type { PreparedTranscode } from "../src/model.js";
import { decryptSegment } from "../src/crypto/aes-cbc.js";
import {
  acquireWorkspaceLockPromise,
  releaseWorkspaceLockPromise,
  withWorkspaceLock,
} from "../src/workspace/lock.js";

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
      ffmpegBuild: "built with test",
      ffprobeVersion: "ffprobe version test",
      ffprobeBuild: "built with test",
      configuration: "configuration: test",
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

test("segment encryption faults after every durable transition", async () => {
  for (const transition of ["file-fsync", "rename", "parent-fsync"] as const) {
    const root = await mkdtemp(
      join("/private/tmp", "transcoder-segment-fault-"),
    );
    roots.push(root);
    const plaintext = join(root, "plain.m4s");
    const destination = join(root, "cipher.m4s");
    await writeFile(plaintext, "complete fragment", { mode: 0o600 });
    const key = new Uint8Array(16).fill(5);
    await expect(
      encryptFileAtomic(
        plaintext,
        destination,
        key,
        0,
        new AbortController().signal,
        {
          afterTransition: (current) => {
            if (current === transition) throw new Error("injected crash");
          },
        },
      ),
    ).rejects.toBeDefined();
    const destinationFile = Bun.file(destination);
    if (transition === "file-fsync") {
      expect(await destinationFile.exists()).toBe(false);
    } else {
      expect(decryptSegment(await destinationFile.bytes(), key, 0)).toEqual(
        new TextEncoder().encode("complete fragment"),
      );
    }
    expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
    key.fill(0);
  }
});

test("interrupted encryption joins cleanup before scope completion", async () => {
  const workspace = await mkdtemp(join("/private/tmp", "transcoder-cancel-"));
  roots.push(workspace);
  const digest = "d".repeat(64);
  const rootPath = join(workspace, "plaintext", digest);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, "generations"), { mode: 0o700 });
  for (const id of ["aac-096", "aac-160", "aac-256"] as const) {
    await writeFile(join(rootPath, `${id}-init.mp4`), "i");
    const segment = join(rootPath, `${id}-00000.m4s`);
    const handle = await open(segment, "w", 0o600);
    await handle.truncate(32 * 1024 * 1024);
    await handle.close();
    await writeFile(
      join(rootPath, `${id}.m3u8`),
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="${id}-init.mp4"\n#EXTINF:6.000,\n${id}-00000.m4s\n#EXT-X-ENDLIST\n`,
    );
  }
  const prepared: PreparedTranscode = {
    prepareDigest: digest,
    rootPath,
    sourceSha256: "e".repeat(64),
    durationMs: 6_000,
    sampleRateHz: 48_000,
    segmentTargetMs: 6_000,
    toolchain: {
      ffmpegPath: "/ffmpeg",
      ffprobePath: "/ffprobe",
      ffmpegVersion: "ffmpeg version test",
      ffmpegBuild: "built with test",
      ffprobeVersion: "ffprobe version test",
      ffprobeBuild: "built with test",
      configuration: "configuration: test",
      libavcodecVersion: "test",
      libavformatVersion: "test",
      capabilities: [],
      sha256: "f".repeat(64),
    },
  };
  const rootKey = new Uint8Array(32).fill(9);
  const fiber = Effect.runFork(
    withWorkspaceLock(workspace, "finalize", () =>
      finalizeTranscode(
        {
          prepared,
          recordingId: `0x${"02".repeat(32)}`,
          network: "testnet",
          encryptionConcurrency: 1,
        },
        {
          generationNonce: new Uint8Array(32).fill(10),
          rootKey,
          keySeal: new Uint8Array([1]),
        },
      ),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(rootKey).toEqual(new Uint8Array(32));
  const generations = join(workspace, "generations");
  expect(
    (await readdir(generations)).every(
      (identifier) =>
        !/^[0-9a-f]{64}$/u.test(identifier) && !identifier.startsWith(".tmp-"),
    ),
  ).toBe(true);
  const resumedLock = await acquireWorkspaceLockPromise(workspace, "resume");
  await releaseWorkspaceLockPromise(resumedLock);
});
