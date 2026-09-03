import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { chromium } from "playwright";
import {
  FfmpegLive,
  NodeNativeProcessLive,
  TranscoderNodeLive,
} from "../src/node.js";
import { TranscodeObserver } from "../src/observer.js";
import { Transcoder, TranscoderLive } from "../src/pipeline/service.js";
import {
  acquireWorkspaceLockPromise,
  releaseWorkspaceLockPromise,
} from "../src/workspace/lock.js";

const roots: string[] = [];
afterAll(async () =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);
const wav = (sampleRate: 48_000, seconds: number): Uint8Array => {
  const samples = sampleRate * seconds;
  const value = Buffer.alloc(44 + samples * 2);
  value.write("RIFF", 0);
  value.writeUInt32LE(36 + samples * 2, 4);
  value.write("WAVEfmt ", 8);
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22);
  value.writeUInt32LE(sampleRate, 24);
  value.writeUInt32LE(sampleRate * 2, 28);
  value.writeUInt16LE(2, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36);
  value.writeUInt32LE(samples * 2, 40);
  for (let frame = 0; frame < samples; frame += 1)
    value.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 3000),
      44 + frame * 2,
    );
  return value;
};

test("pinned FFmpeg produces the golden verified loose HLS ladder and plays locally", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "misofm-transcoder-integration-")),
  );
  roots.push(root);
  const inputPath = join(root, "hostile ; $(no-shell) *.wav");
  await writeFile(inputPath, wav(48_000, 7), { mode: 0o600 });
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
  const artifact = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      const result = yield* transcoder.transcode({
        inputPath,
        workspacePath: join(root, "workspace"),
        ffmpegPath,
        ffprobePath,
        profile: { maxSegmentsPerRendition: 219 },
      });
      return yield* transcoder.verify(result);
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(artifact.verified).toBe(true);
  expect(artifact.files).toHaveLength(13);
  expect(artifact.renditions.map((item) => item.id)).toEqual([
    "aac-96",
    "aac-160",
    "aac-256",
  ]);
  expect(artifact.renditions.every((item) => item.segments.length === 2)).toBe(
    true,
  );
  const resumed = await Effect.runPromise(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.transcode({
        inputPath,
        workspacePath: join(root, "workspace"),
        ffmpegPath,
        ffprobePath,
        profile: { maxSegmentsPerRendition: 219 },
      });
    }).pipe(Effect.provide(TranscoderNodeLive)),
  );
  expect(resumed.transcodeDigest).toBe(artifact.transcodeDigest);
  if (process.env["MISO_PINNED_FFMPEG"] === "1") {
    const golden = JSON.parse(
      await readFile(
        new URL(
          "./fixtures/linuxserver-ffmpeg-8.1.2.golden.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      artifact.files.map(({ identifier, bytes, sha256 }) => [
        identifier,
        bytes,
        sha256,
      ]),
    ).toEqual(golden.files);
  }
  if (process.env["MISO_HLS_SMOKE"] === "1") {
    const requestedFragments = new Set<string>();
    const server = createServer(async (request, response) => {
      const pathname = new URL(
        request.url ?? "/",
        "http://127.0.0.1",
      ).pathname.slice(1);
      if (pathname === "player.html") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<audio id="audio" muted autoplay></audio><script src="/hls.js"></script><script>const audio=document.querySelector("#audio");const h=new Hls({startLevel:0});let fragments=0;const levels=new Set();h.loadSource("/master.m3u8");h.attachMedia(audio);h.on(Hls.Events.MANIFEST_PARSED,()=>audio.play());h.on(Hls.Events.FRAG_LOADED,(_,data)=>{fragments++;levels.add(data.frag.level);if(fragments===1)h.nextLevel=2;if(fragments>=2&&levels.size>=2)document.body.dataset.switched="yes"});audio.addEventListener("loadeddata",()=>document.body.dataset.decoded="yes");</script>',
        );
        return;
      }
      if (pathname === "hls.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(
          await readFile(
            join(process.cwd(), "node_modules/hls.js/dist/hls.min.js"),
          ),
        );
        return;
      }
      const file = artifact.files.find((item) => item.identifier === pathname);
      if (file === undefined) {
        response.writeHead(404).end();
        return;
      }
      if (pathname.endsWith(".m4s")) requestedFragments.add(pathname);
      response.writeHead(200, {
        "content-type": file.contentType,
        "content-length": file.bytes,
      });
      response.end(await readFile(file.path));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("server address unavailable");
      const browser = await chromium.launch(
        process.env["MISO_CHROMIUM_PATH"] === undefined
          ? { args: ["--autoplay-policy=no-user-gesture-required"] }
          : {
              executablePath: process.env["MISO_CHROMIUM_PATH"],
              args: ["--autoplay-policy=no-user-gesture-required"],
            },
      );
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}/player.html`);
        await page.waitForFunction(
          () =>
            document.body.dataset.decoded === "yes" &&
            document.body.dataset.switched === "yes",
          undefined,
          { timeout: 20_000 },
        );
        expect(
          new Set(
            [...requestedFragments].map(
              (identifier) => identifier.split("-000")[0],
            ),
          ).size,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await browser.close();
      }
    } finally {
      server.close();
    }
  }
}, 60_000);

test("pipeline interruption joins finalization, removes staging, and releases its lock", async () => {
  if (process.platform === "win32") return;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "misofm-transcoder-interrupt-")),
  );
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const inputPath = join(root, "long.wav");
  await writeFile(inputPath, wav(48_000, 45), { mode: 0o600 });
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
  let signalFinalize!: () => void;
  const finalizeStarted = new Promise<void>((resolve) => {
    signalFinalize = resolve;
  });
  const ffmpeg = FfmpegLive.pipe(Layer.provide(NodeNativeProcessLive));
  const layer = TranscoderLive.pipe(
    Layer.provide(ffmpeg),
    Layer.provide(
      Layer.succeed(TranscodeObserver, {
        emit: (event) =>
          Effect.sync(() => {
            if (event._tag === "PhaseStarted" && event.phase === "finalize")
              signalFinalize();
          }),
      }),
    ),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  );
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const transcoder = yield* Transcoder;
      return yield* transcoder.transcode({
        inputPath,
        workspacePath,
        ffmpegPath,
        ffprobePath,
        fileConcurrency: 1,
      });
    }).pipe(Effect.provide(layer)),
  );
  await finalizeStarted;
  const generations = join(workspacePath, "generations");
  let enteredFinalizeWorkspace = false;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      await readdir(generations);
      enteredFinalizeWorkspace = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  expect(enteredFinalizeWorkspace).toBe(true);
  await Effect.runPromise(Fiber.interrupt(fiber));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
    true,
  );
  expect(
    (await readdir(generations)).some((entry) => entry.startsWith(".tmp-")),
  ).toBe(false);
  const lock = await acquireWorkspaceLockPromise(workspacePath, "post-cancel");
  await releaseWorkspaceLockPromise(lock);
}, 20_000);
