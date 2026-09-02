import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { Effect } from "effect";

import { Transcoder } from "../src/pipeline/service.js";
import { TranscoderNodeLive } from "../src/node.js";
import { deriveRenditionKey } from "../src/crypto/hkdf.js";
import { decryptSegment } from "../src/crypto/aes-cbc.js";
import { parseQuiltIndex } from "../src/schema.js";
import { parsePlaintextMediaPlaylist } from "../src/hls/playlist.js";

const roots: string[] = [];
const PINNED_FFMPEG_IMAGE =
  "ghcr.io/linuxserver/ffmpeg:8.1.2-cli-ls76@sha256:2e7000921be8de2704a4f27dfd3d988562697a346eaabb937a81046c306f0af7";
afterAll(async () =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);

const wav = (
  sampleRate: 44_100 | 48_000,
  channels: 1 | 2,
  seconds: number,
): Uint8Array => {
  const samples = sampleRate * seconds;
  const dataBytes = samples * channels * 2;
  const value = Buffer.alloc(44 + dataBytes);
  value.write("RIFF", 0);
  value.writeUInt32LE(36 + dataBytes, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(channels, 22);
  value.writeUInt32LE(sampleRate, 24);
  value.writeUInt32LE(sampleRate * channels * 2, 28);
  value.writeUInt16LE(channels * 2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < samples; frame += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3_000,
    );
    for (let channel = 0; channel < channels; channel += 1)
      value.writeInt16LE(sample, 44 + (frame * channels + channel) * 2);
  }
  return value;
};

const run = (file: string, args: readonly string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0 && signal === null
        ? resolve()
        : reject(new Error(Buffer.concat(stderr).toString())),
    );
  });

test("real FFmpeg creates one aligned three-rendition plaintext ladder", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "misofm-transcoder-integration-")),
  );
  roots.push(root);
  const inputPath = join(root, "hostile ; $(no-shell) *.wav");
  const workspacePath = join(root, "workspace");
  await writeFile(inputPath, wav(48_000, 1, 7), { mode: 0o600 });
  const ffmpegPath =
    process.env["MISO_FFMPEG"] ??
    (process.platform === "darwin"
      ? "/opt/homebrew/bin/ffmpeg"
      : "/usr/bin/ffmpeg");
  const ffprobePath =
    process.env["MISO_FFPROBE"] ??
    (process.platform === "darwin"
      ? "/opt/homebrew/bin/ffprobe"
      : "/usr/bin/ffprobe");
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.prepare({
        inputPath,
        workspacePath,
        ffmpegPath,
        ffprobePath,
      });
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(prepared.sampleRateHz).toBe(48_000);
  expect(prepared.segmentTargetMs).toBe(6_000);
  for (const id of ["aac-096", "aac-160", "aac-256"] as const) {
    expect(await Bun.file(join(prepared.rootPath, `${id}.m3u8`)).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(prepared.rootPath, `${id}-init.mp4`)).exists(),
    ).toBe(true);
  }
  const recordingId = `0x${"01".repeat(32)}`;
  const generationNonce = Uint8Array.from(
    { length: 32 },
    (_, index) => 255 - index,
  );
  const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const keys = new Map(
    ["aac-096", "aac-160", "aac-256"].map((id) => [
      id,
      deriveRenditionKey(
        rootKey,
        recordingId,
        generationNonce,
        id as "aac-096",
      ),
    ]),
  );
  const artifact = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.finalize(
        { prepared, recordingId, network: "testnet" },
        {
          generationNonce,
          rootKey,
        },
      );
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(rootKey).toEqual(new Uint8Array(32));
  const verified = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.verify(artifact);
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(verified.verified).toBe(true);
  expect(verified.patchCount).toBe(14);
  const index = parseQuiltIndex(await Bun.file(artifact.indexPath).bytes());
  if (process.env["MISO_PINNED_FFMPEG"] === "1") {
    const golden = `${JSON.stringify(
      {
        schema: "miso.transcoder-golden/1",
        image: PINNED_FFMPEG_IMAGE,
        sourceSha256: prepared.sourceSha256,
        indexSha256: artifact.indexSha256,
        indexBase64: Buffer.from(artifact.indexBytes).toString("base64"),
        patchCount: artifact.patchCount,
        patches: artifact.patches.map(({ identifier, bytes, sha256 }) => ({
          identifier,
          bytes,
          sha256,
        })),
        toolchain: artifact.toolchain,
      },
      null,
      2,
    )}\n`;
    const goldenUrl = new URL(
      "./fixtures/linuxserver-ffmpeg-8.1.2.golden.json",
      import.meta.url,
    );
    expect(await readFile(goldenUrl, "utf8")).toBe(golden);
  }
  const verificationRootKey = Uint8Array.from(
    { length: 32 },
    (_, index) => index,
  );
  try {
    for (const rendition of index.renditions) {
      const key = deriveRenditionKey(
        verificationRootKey,
        recordingId,
        generationNonce,
        rendition.id,
      );
      try {
        for (const segment of rendition.segments) {
          const decrypted = decryptSegment(
            await Bun.file(join(artifact.rootPath, segment.identifier)).bytes(),
            key,
            segment.sequence,
          );
          expect(decrypted).toEqual(
            await Bun.file(join(prepared.rootPath, segment.identifier)).bytes(),
          );
          decrypted.fill(0);
        }
      } finally {
        key.fill(0);
      }
    }
  } finally {
    verificationRootKey.fill(0);
  }
  const checkpointPath = join(
    workspacePath,
    "generations",
    `${artifact.generationDigest}.json`,
  );
  await unlink(checkpointPath);
  const resumedRootKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      const cachedPrepare = yield* transcoder.prepare({
        inputPath,
        workspacePath,
        ffmpegPath,
        ffprobePath,
      });
      expect(cachedPrepare.prepareDigest).toBe(prepared.prepareDigest);
      return yield* transcoder.finalize(
        { prepared: cachedPrepare, recordingId, network: "testnet" },
        {
          generationNonce,
          rootKey: resumedRootKey,
        },
      );
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(resumed.generationDigest).toBe(artifact.generationDigest);
  expect(resumedRootKey).toEqual(new Uint8Array(32));
  expect(await Bun.file(checkpointPath).exists()).toBe(true);
  const wrongRootKey = new Uint8Array(32).fill(99);
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const transcoder = yield* Transcoder;
        return yield* transcoder.finalize(
          { prepared, recordingId, network: "testnet" },
          { generationNonce, rootKey: wrongRootKey },
        );
      }).pipe(Effect.provide(TranscoderNodeLive)),
    ),
  ).rejects.toBeDefined();
  expect(wrongRootKey).toEqual(new Uint8Array(32));
  const correctCheckpoint = await readFile(checkpointPath);
  await writeFile(checkpointPath, "tampered\n");
  const checkpointKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const transcoder = yield* Transcoder;
        return yield* transcoder.finalize(
          { prepared, recordingId, network: "testnet" },
          {
            generationNonce,
            rootKey: checkpointKey,
          },
        );
      }).pipe(Effect.provide(TranscoderNodeLive)),
    ),
  ).rejects.toBeDefined();
  expect(checkpointKey).toEqual(new Uint8Array(32));
  await writeFile(checkpointPath, correctCheckpoint);
  const reusedNonceKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const transcoder = yield* Transcoder;
        return yield* transcoder.finalize(
          { prepared, recordingId, network: "mainnet" },
          {
            generationNonce,
            rootKey: reusedNonceKey,
          },
        );
      }).pipe(Effect.provide(TranscoderNodeLive)),
    ),
  ).rejects.toBeDefined();
  expect(reusedNonceKey).toEqual(new Uint8Array(32));

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/player.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><audio id="audio"></audio><script src="/hls.js"></script>',
      );
      return;
    }
    if (url.pathname === "/hls.js") {
      const body = await Bun.file(
        join(process.cwd(), "node_modules/hls.js/dist/hls.min.js"),
      ).arrayBuffer();
      response.writeHead(200, {
        "content-type": "text/javascript",
        "content-length": body.byteLength,
      });
      response.end(Buffer.from(body));
      return;
    }
    if (url.pathname === "/key.external") {
      if (
        url.searchParams.get("generation") !==
        Buffer.from(generationNonce).toString("base64url")
      ) {
        response.writeHead(404).end();
        return;
      }
      const key = keys.get(url.searchParams.get("rendition") ?? "");
      if (key === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": key.byteLength,
      });
      response.end(key);
      return;
    }
    const identifier = url.pathname.slice(1);
    const file = Bun.file(join(artifact.rootPath, identifier));
    if (!(await file.exists())) {
      response.writeHead(404).end();
      return;
    }
    const body = await file.arrayBuffer();
    response.writeHead(200, { "content-length": body.byteLength });
    response.end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("test server did not bind");
    for (const id of ["aac-096", "aac-160", "aac-256"] as const) {
      await run(ffmpegPath, [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        `http://127.0.0.1:${address.port}/${id}.m3u8`,
        "-f",
        "null",
        "-",
      ]);
    }
    if (process.env["MISO_HLS_SMOKE"] === "1") {
      const { chromium } = await import("playwright");
      const executablePath = process.env["MISO_CHROMIUM_PATH"];
      const browser = await chromium.launch(
        executablePath === undefined
          ? { headless: true }
          : { headless: true, executablePath },
      );
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/player.html`);
        const levels = await page.evaluate(
          (masterUrl) =>
            new Promise<number>((resolve, reject) => {
              const HlsConstructor = (
                globalThis as unknown as {
                  Hls: typeof import("hls.js").default;
                }
              ).Hls;
              const hls = new HlsConstructor({
                autoStartLoad: false,
                maxBufferLength: 1,
              });
              const media = document.querySelector("audio")!;
              media.muted = true;
              const timeout = setTimeout(() => {
                hls.destroy();
                reject(new Error("hls.js timeout"));
              }, 15_000);
              hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
                if (data.fatal) {
                  clearTimeout(timeout);
                  hls.destroy();
                  reject(new Error(`${data.type}:${data.details}`));
                }
              });
              hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
                if (hls.levels.length !== 3) {
                  clearTimeout(timeout);
                  hls.destroy();
                  reject(new Error("missing levels"));
                  return;
                }
                hls.startLevel = 0;
                hls.startLoad();
                void media.play();
              });
              let switched = false;
              hls.on(HlsConstructor.Events.FRAG_BUFFERED, () => {
                if (!switched) {
                  switched = true;
                  hls.nextLevel = 2;
                  return;
                }
              });
              hls.on(HlsConstructor.Events.LEVEL_SWITCHED, (_event, data) => {
                if (!switched || data.level !== 2) return;
                clearTimeout(timeout);
                const count = hls.levels.length;
                hls.destroy();
                resolve(count);
              });
              hls.loadSource(masterUrl);
              hls.attachMedia(media);
            }),
          `http://127.0.0.1:${address.port}/master.m3u8`,
        );
        expect(levels).toBe(3);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
    for (const key of keys.values()) key.fill(0);
  }
  for (const identifier of [
    index.renditions[0]!.init.identifier,
    index.renditions[0]!.segments[0]!.identifier,
  ]) {
    const path = join(artifact.rootPath, identifier);
    const original = await readFile(path);
    const tampered = Buffer.from(original);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await writeFile(path, tampered);
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const transcoder = yield* Transcoder;
          return yield* transcoder.verify(artifact);
        }).pipe(Effect.provide(TranscoderNodeLive)),
      ),
    ).rejects.toBeDefined();
    await writeFile(path, original);
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      yield* transcoder.cleanupPrepared(prepared);
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(await Bun.file(prepared.rootPath).exists()).toBe(false);
  await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      yield* transcoder.cleanupPrepared(prepared);
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(
    JSON.parse(await Bun.file(join(workspacePath, "workspace.json")).text()),
  ).toEqual({
    schema: "miso.transcoder-workspace/1",
    generationDigest: artifact.generationDigest,
  });
}, 120_000);

test("real FFmpeg preserves a 44.1 kHz stereo exact-target fixture", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "misofm-transcoder-44100-")),
  );
  roots.push(root);
  const inputPath = join(root, "exact-six-seconds.wav");
  const workspacePath = join(root, "workspace");
  await writeFile(inputPath, wav(44_100, 2, 6), { mode: 0o600 });
  const ffmpegPath =
    process.env["MISO_FFMPEG"] ??
    (process.platform === "darwin"
      ? "/opt/homebrew/bin/ffmpeg"
      : "/usr/bin/ffmpeg");
  const ffprobePath =
    process.env["MISO_FFPROBE"] ??
    (process.platform === "darwin"
      ? "/opt/homebrew/bin/ffprobe"
      : "/usr/bin/ffprobe");
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.prepare({
        inputPath,
        workspacePath,
        ffmpegPath,
        ffprobePath,
      });
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(prepared.sampleRateHz).toBe(44_100);
  const timelines = await Promise.all(
    ["aac-096", "aac-160", "aac-256"].map(async (id) =>
      parsePlaintextMediaPlaylist(
        await Bun.file(join(prepared.rootPath, `${id}.m3u8`)).bytes(),
      ).segments.map((segment) => segment.durationMs),
    ),
  );
  expect(timelines[1]).toEqual(timelines[0]);
  expect(timelines[2]).toEqual(timelines[0]);
  const firstSegment = join(prepared.rootPath, "aac-096-00000.m4s");
  const originalSegment = await readFile(firstSegment);
  const tamperedSegment = Buffer.from(originalSegment);
  tamperedSegment[0] = (tamperedSegment[0] ?? 0) ^ 0xff;
  await writeFile(firstSegment, tamperedSegment);
  await expect(
    Effect.runPromise(
      Effect.gen(function* () {
        const transcoder = yield* Transcoder;
        return yield* transcoder.prepare({
          inputPath,
          workspacePath,
          ffmpegPath,
          ffprobePath,
        });
      }).pipe(Effect.provide(TranscoderNodeLive)),
    ),
  ).rejects.toBeDefined();
  await writeFile(firstSegment, originalSegment);
  await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      yield* transcoder.cleanupPrepared(prepared);
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
}, 120_000);
