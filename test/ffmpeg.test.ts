import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ToolchainCapabilityError,
  UnsupportedSourceError,
} from "../src/errors.js";
import {
  parseToolchainFingerprint,
  TOOLCHAIN_CAPABILITIES,
} from "../src/ffmpeg/capabilities.js";
import { buildLadderInvocation } from "../src/ffmpeg/invocation.js";
import { parseSourceProbe, sourceProbeArgs } from "../src/ffmpeg/probe.js";
import { validatePlaintextRendition } from "../src/ffmpeg/validate-media.js";
import {
  measureAudio,
  parseLoudnormMeasurement,
  planSharedGainCentiDb,
} from "../src/ffmpeg/audio-meter.js";
import type { NativeProcessService } from "../src/process/native-process.js";

const temporaryRoot = realpath(tmpdir());

const version = (
  product: "ffmpeg" | "ffprobe",
  token = "8.1.2",
) => `${product} version ${token} Copyright
built with gcc 15.1.0
configuration: --enable-gpl --enable-libopus
libavcodec     62. 11.100 / 62. 11.100
libavformat    62.  3.100 / 62.  3.100
`;

const capabilityOutputs = {
  ffmpegVersion: version("ffmpeg"),
  ffprobeVersion: version("ffprobe"),
  encoders: " A..... aac                  AAC (Advanced Audio Coding)",
  muxers: " E  hls             Apple HTTP Live Streaming",
  filters: " ... loudnorm A->A\n T.C volume A->A",
  volumeHelp: "precision set mathematical precision double",
  hlsHelp:
    "hls_segment_type fmp4 var_stream_map hls_segment_filename master_pl_name",
  ffprobeJson: '{"program_version":{"version":"8.1.2"}}',
};

test("parses and deterministically fingerprints the required toolchain capabilities", () => {
  const first = parseToolchainFingerprint(
    "/opt/ffmpeg",
    "/opt/ffprobe",
    capabilityOutputs,
  );
  const second = parseToolchainFingerprint(
    "/opt/ffmpeg",
    "/opt/ffprobe",
    capabilityOutputs,
  );
  expect(first).toEqual(second);
  expect(first.ffmpegVersion).toBe("ffmpeg version 8.1.2 Copyright");
  expect(first.libavcodecVersion).toBe("62. 11.100 / 62. 11.100");
  expect(first.capabilities).toEqual(TOOLCHAIN_CAPABILITIES);
  expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("rejects mismatched ffmpeg and ffprobe builds", () => {
  expect(() =>
    parseToolchainFingerprint("/opt/ffmpeg", "/opt/ffprobe", {
      ...capabilityOutputs,
      ffprobeVersion: version("ffprobe", "8.1.1-static"),
    }),
  ).toThrow(ToolchainCapabilityError);
});

test("rejects matching toolchains outside the pinned FFmpeg release", () => {
  expect(() =>
    parseToolchainFingerprint("/opt/ffmpeg", "/opt/ffprobe", {
      ...capabilityOutputs,
      ffmpegVersion: version("ffmpeg", "8.1.1-static"),
      ffprobeVersion: version("ffprobe", "8.1.1-static"),
      ffprobeJson: '{"program_version":{"version":"8.1.1"}}',
    }),
  ).toThrow(ToolchainCapabilityError);
});

test("rejects mismatched ffmpeg and ffprobe configurations", () => {
  expect(() =>
    parseToolchainFingerprint("/opt/ffmpeg", "/opt/ffprobe", {
      ...capabilityOutputs,
      ffprobeVersion: version("ffprobe").replace(
        "--enable-libopus",
        "--disable-libopus",
      ),
    }),
  ).toThrow(ToolchainCapabilityError);
});

test("builds the frozen single-process aligned AAC ladder argv", () => {
  const hostile = "/media/input $(touch nope); *.wav ' quoted.wav";
  const out = "/work/.tmp-123-abc";
  const invocation = buildLadderInvocation({
    ffmpegPath: "/opt/ffmpeg",
    inputPath: hostile,
    outputDirectory: out,
    source: { sampleRateHz: 44_100, channels: 1 },
    segmentTargetMs: 6_000,
  });

  expect(invocation).toEqual({
    executable: "/opt/ffmpeg",
    cwd: out,
    args: [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-i",
      hostile,
      "-vn",
      "-sn",
      "-dn",
      "-filter_complex",
      "[0:a:0]pan=stereo|c0=c0|c1=c0,aresample=44100:async=0:first_pts=0,asetpts=N/SR/TB,asplit=3[aac96][aac160][aac256]",
      "-map",
      "[aac96]",
      "-map",
      "[aac160]",
      "-map",
      "[aac256]",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a:0",
      "96k",
      "-b:a:1",
      "160k",
      "-b:a:2",
      "256k",
      "-ar:a",
      "44100",
      "-ac:a",
      "2",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-f",
      "hls",
      "-hls_playlist_type",
      "vod",
      "-hls_segment_type",
      "fmp4",
      "-hls_time",
      "6.000",
      "-hls_list_size",
      "0",
      "-start_number",
      "0",
      "-hls_fmp4_init_filename",
      "%v-init.mp4",
      "-hls_segment_filename",
      `${out}/%v-%05d.m4s`,
      "-master_pl_name",
      "master.m3u8",
      "-var_stream_map",
      "a:0,name:aac-96 a:1,name:aac-160 a:2,name:aac-256",
      "-progress",
      "pipe:3",
      "-nostats",
      `${out}/%v.m3u8`,
    ],
  });
  expect(invocation.args.filter((arg) => arg === hostile)).toHaveLength(1);
  expect(
    invocation.args.filter((arg) => arg.includes("asplit=3")),
  ).toHaveLength(1);
  expect(
    invocation.args.some((arg) => /hls_enc|hls_key_info_file/u.test(arg)),
  ).toBe(false);
});

test("places fixed-decimal double-precision gain exactly once before asplit", () => {
  const invocation = buildLadderInvocation({
    ffmpegPath: "/opt/ffmpeg",
    inputPath: "/media/master.flac",
    outputDirectory: "/work/output",
    source: { sampleRateHz: 48_000, channels: 2 },
    segmentTargetMs: 6_000,
    gainCentiDb: -530,
  });
  const filter =
    invocation.args[invocation.args.indexOf("-filter_complex") + 1]!;
  expect(filter).toContain(
    "asetpts=N/SR/TB,volume=-5.30dB:precision=double,asplit=3",
  );
  expect(filter.match(/volume=/gu)).toHaveLength(1);
});

test("builds ffprobe argv with the hostile absolute path as one item", () => {
  const hostile = "/media/$(touch nope);*.wav";
  const args = sourceProbeArgs(hostile);
  expect(args.at(-1)).toBe(hostile);
  expect(args.filter((arg) => arg === hostile)).toHaveLength(1);
  expect(args).toContain("a");
});

test("parses a supported mono source and rejects ambiguous or surround audio", () => {
  expect(
    parseSourceProbe(
      JSON.stringify({
        streams: [
          {
            index: 2,
            codec_type: "audio",
            sample_rate: "48000",
            channels: 1,
            start_time: "0.000",
          },
        ],
        format: { duration: "7.000", start_time: "0.000" },
      }),
    ),
  ).toEqual({
    streamIndex: 2,
    durationMs: 7_000,
    sampleRateHz: 48_000,
    channels: 1,
    startTimeSeconds: 0,
  });

  expect(() =>
    parseSourceProbe(
      JSON.stringify({
        streams: [
          { index: 0, sample_rate: "48000", channels: 2 },
          { index: 1, sample_rate: "48000", channels: 2 },
        ],
        format: { duration: "1" },
      }),
    ),
  ).toThrow(UnsupportedSourceError);
  expect(() =>
    parseSourceProbe(
      JSON.stringify({
        streams: [{ index: 0, sample_rate: "48000", channels: 6 }],
        format: { duration: "1" },
      }),
    ),
  ).toThrow(UnsupportedSourceError);
});

test("structural preview validation permits finite decoded overshoot", async () => {
  const root = await mkdtemp(join(await temporaryRoot, "transcoder-pcm-"));
  const playlistPath = join(root, "aac-96.m3u8");
  await writeFile(
    playlistPath,
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="aac-96-init.mp4"\n#EXTINF:1.000,\naac-96-00000.m4s\n#EXT-X-ENDLIST\n',
  );
  await writeFile(join(root, "aac-96-init.mp4"), "i");
  await writeFile(join(root, "aac-96-00000.m4s"), "s");
  const timeline = new TextEncoder().encode(
    JSON.stringify({
      streams: [
        {
          codec_name: "aac",
          profile: "LC",
          codec_tag_string: "mp4a",
          sample_rate: "48000",
          channels: 2,
          time_base: "1/48000",
        },
      ],
      packets: [
        {
          pts: 0,
          dts: 0,
          duration: 48000,
          pos: 1,
          pts_time: "0.000000",
          duration_time: "1.000000",
        },
      ],
    }),
  );
  const process: NativeProcessService = {
    run: (request) => {
      return Effect.succeed({
        exitCode: 0,
        signal: null,
        stdout:
          request.role === "ffprobe-timeline" ? timeline : new Uint8Array(),
        stderrTail: new Uint8Array(),
        progressTail: new Uint8Array(),
        stderrTruncated: false,
        progressTruncated: false,
      });
    },
  };
  try {
    await expect(
      Effect.runPromise(
        validatePlaintextRendition(
          process,
          "/ffmpeg",
          "/ffprobe",
          playlistPath,
          48_000,
          1_000,
        ),
      ),
    ).resolves.toMatchObject({ totalSamples: 48_000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const loudnormJson = (inputTp = "-1.05", inputI = "-14.00") => {
  const silence = inputTp === "-inf" && inputI === "-inf";
  return Buffer.from(`noise {from a hostile path} before\n[Parsed_loudnorm_0 @ 0x1234]\n{
  "input_i" : "${inputI}",
  "input_tp" : "${inputTp}",
  "input_lra" : "1.00",
  "input_thresh" : "-24.00",
  "output_i" : "${silence ? "-inf" : "-24.00"}",
  "output_tp" : "${silence ? "-inf" : "-2.00"}",
  "output_lra" : "1.00",
  "output_thresh" : "-34.00",
  "normalization_type" : "${silence ? "dynamic" : "linear"}",
  "target_offset" : "${silence ? "inf" : "0.00"}"
}\n`);
};

test("strictly parses pinned loudnorm JSON including silence", () => {
  expect(parseLoudnormMeasurement("audio", loudnormJson())).toEqual({
    integratedLoudnessCentiLufs: -1400,
    truePeakCentiDbtp: -105,
  });
  expect(
    parseLoudnormMeasurement("audio", loudnormJson("-inf", "-inf")),
  ).toEqual({
    integratedLoudnessCentiLufs: null,
    truePeakCentiDbtp: null,
  });
  for (const malformed of [
    Buffer.from("{}"),
    Buffer.from(
      loudnormJson()
        .toString()
        .replace(
          '"input_tp" : "-1.05",',
          '"input_tp" : "-1.05",\n"input_tp":"-2.00",',
        ),
    ),
    loudnormJson("NaN"),
    loudnormJson("+inf"),
    Buffer.from(
      loudnormJson()
        .toString()
        .replace('"input_lra" : "1.00"', '"input_lra" : "-inf"'),
    ),
    Buffer.from(
      loudnormJson()
        .toString()
        .replace('"input_tp" : "-1.05"', '"input_tp" : "-inf"'),
    ),
    Buffer.concat([loudnormJson(), loudnormJson()]),
    loudnormJson().subarray(0, 30),
  ])
    expect(() => parseLoudnormMeasurement("audio", malformed)).toThrow();
});

test("plans shared gain with negative quantized floor", () => {
  expect(planSharedGainCentiDb([-105, -200, -300])).toBe(-50);
  expect(planSharedGainCentiDb([372, 100, -10])).toBe(-530);
  expect(planSharedGainCentiDb([-151, -200])).toBe(0);
  expect(planSharedGainCentiDb([null, null])).toBe(0);
});

test.each([
  ["finite overshoot", 1.5, false],
  ["non-finite", Number.NaN, true],
] as const)(
  "decoded sample scan handles %s",
  async (_name, sample, rejects) => {
    const process: NativeProcessService = {
      run: (request) => {
        if (request.role === "ffmpeg-sample-scan") {
          const chunk = Buffer.alloc(8);
          chunk.writeFloatLE(sample);
          chunk.writeFloatLE(sample, 4);
          request.onStdoutChunk?.(chunk);
        }
        return Effect.succeed({
          exitCode: 0,
          signal: null,
          stdout: new Uint8Array(),
          stderrTail:
            request.role === "ffmpeg-loudnorm-meter"
              ? loudnormJson("3.72")
              : new Uint8Array(),
          progressTail: new Uint8Array(),
          stderrTruncated: false,
          progressTruncated: false,
        });
      },
    };
    const result = Effect.runPromise(
      measureAudio(process, "/ffmpeg", "/audio.m3u8", 48_000, 1_000),
    );
    if (rejects) await expect(result).rejects.toBeDefined();
    else
      await expect(result).resolves.toMatchObject({
        truePeakCentiDbtp: 372,
        exactSamplePeak: 1.5,
      });
  },
);
