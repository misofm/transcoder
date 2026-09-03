import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Fiber } from "effect";

import { copyFileAtomic, finalizeTranscode } from "../src/pipeline/finalize.js";
import type { PreparedTranscode } from "../src/model.js";
import {
  acquireWorkspaceLockPromise,
  releaseWorkspaceLockPromise,
  withWorkspaceLock,
} from "../src/workspace/lock.js";

const roots: string[] = [];
const temporaryRoot = realpath(tmpdir());
const preparedAudio = {
  resultDigest: "9".repeat(64),
  audio: {
    policyId: "miso.aac-codec-preview/1" as const,
    appliedGainCentiDb: 0,
    source: {
      integratedLoudnessCentiLufs: -2400,
      truePeakCentiDbtp: -200,
      samplePeakCentiDbfs: -200,
    },
    preview: ["aac-096", "aac-160", "aac-256"].map((id) => ({
      id: id as "aac-096" | "aac-160" | "aac-256",
      integratedLoudnessCentiLufs: -2400,
      truePeakCentiDbtp: -200,
      samplePeakCentiDbfs: -200,
    })),
    output: ["aac-096", "aac-160", "aac-256"].map((id) => ({
      id: id as "aac-096" | "aac-160" | "aac-256",
      integratedLoudnessCentiLufs: -2400,
      truePeakCentiDbtp: -200,
      samplePeakCentiDbfs: -200,
    })),
  },
};
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

test("failed finalization cannot promote partial output", async () => {
  const workspace = await mkdtemp(
    join(await temporaryRoot, "transcoder-fault-"),
  );
  roots.push(workspace);
  const rootPath = join(workspace, "plaintext", "a".repeat(64));
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  await mkdir(join(workspace, "generations"), { mode: 0o700 });
  const prepared: PreparedTranscode = {
    ...preparedAudio,
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
  const finalization = finalizeTranscode({
    prepared,
    recordingId: `0x${"01".repeat(32)}`,
  });
  await expect(Effect.runPromise(finalization)).rejects.toBeDefined();
  const generations = join(workspace, "generations");
  expect(
    (await readdir(generations)).every(
      (identifier) => !/^[0-9a-f]{64}$/u.test(identifier),
    ),
  ).toBe(true);
});

test("segment copy faults after every durable transition", async () => {
  for (const transition of ["file-fsync", "rename", "parent-fsync"] as const) {
    const root = await mkdtemp(
      join(await temporaryRoot, "transcoder-segment-fault-"),
    );
    roots.push(root);
    const source = join(root, "source.m4s");
    const destination = join(root, "copy.m4s");
    await writeFile(source, "complete fragment", { mode: 0o600 });
    await expect(
      copyFileAtomic(source, destination, new AbortController().signal, {
        afterTransition: (current) => {
          if (current === transition) throw new Error("injected crash");
        },
      }),
    ).rejects.toBeDefined();
    const destinationFile = Bun.file(destination);
    if (transition === "file-fsync") {
      expect(await destinationFile.exists()).toBe(false);
    } else {
      expect(await destinationFile.text()).toBe("complete fragment");
    }
    expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  }
});

test("segment copy rejects a source mutation before promotion", async () => {
  const root = await mkdtemp(
    join(await temporaryRoot, "transcoder-segment-mutation-"),
  );
  roots.push(root);
  const source = join(root, "source.m4s");
  const destination = join(root, "copy.m4s");
  await writeFile(source, "complete fragment", { mode: 0o600 });
  await expect(
    copyFileAtomic(source, destination, new AbortController().signal, {
      afterTransition: async (transition) => {
        if (transition === "file-fsync")
          await writeFile(source, "corrupt! fragment", { mode: 0o600 });
      },
    }),
  ).rejects.toBeDefined();
  expect(await Bun.file(destination).exists()).toBe(false);
  expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
    false,
  );
});

test("interrupted copy joins cleanup before scope completion", async () => {
  const workspace = await mkdtemp(
    join(await temporaryRoot, "transcoder-cancel-"),
  );
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
    ...preparedAudio,
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
  const fiber = Effect.runFork(
    withWorkspaceLock(workspace, "finalize", () =>
      finalizeTranscode({
        prepared,
        recordingId: `0x${"02".repeat(32)}`,
        fileConcurrency: 1,
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  await Effect.runPromise(Fiber.interrupt(fiber));
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
