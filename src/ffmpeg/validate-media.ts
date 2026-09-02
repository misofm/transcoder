import { Effect } from "effect";

import { MediaValidationError, type NativeProcessError } from "../errors.js";
import type { NativeProcessService } from "../process/native-process.js";

const PACKET_JSON_LIMIT = 16 * 1024 * 1024;

export interface TimelineValidation {
  readonly intervals: readonly string[];
  readonly totalSamples: number;
}

const invalid = (subject: string, message: string) =>
  new MediaValidationError({
    code: "MEDIA_VALIDATION",
    phase: "validate",
    subject,
    message,
  });

const packetArgs = (playlistPath: string): readonly string[] => [
  "-hide_banner",
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_streams",
  "-show_packets",
  "-show_entries",
  "stream=codec_name,profile,codec_tag_string,sample_rate,channels,time_base:packet=pts,dts,duration,pts_time,duration_time",
  "-of",
  "json",
  playlistPath,
];

const parseInteger = (value: unknown): number | undefined => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const parseTimeline = (
  subject: string,
  bytes: Uint8Array,
  sampleRateHz: 44_100 | 48_000,
): TimelineValidation => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw invalid(subject, "FFprobe returned invalid packet JSON");
  }
  if (typeof decoded !== "object" || decoded === null)
    throw invalid(subject, "Missing packet data");
  const root = decoded as Record<string, unknown>;
  const streams = root["streams"];
  const packets = root["packets"];
  if (
    !Array.isArray(streams) ||
    streams.length !== 1 ||
    !Array.isArray(packets) ||
    packets.length === 0
  ) {
    throw invalid(subject, "Expected exactly one non-empty AAC stream");
  }
  const stream = streams[0] as Record<string, unknown>;
  if (
    stream["codec_name"] !== "aac" ||
    stream["profile"] !== "LC" ||
    stream["codec_tag_string"] !== "mp4a" ||
    Number(stream["sample_rate"]) !== sampleRateHz ||
    stream["channels"] !== 2
  ) {
    throw invalid(
      subject,
      "Rendition is not AAC-LC mp4a.40.2 at the expected stereo sample rate",
    );
  }
  let previousDts: number | undefined;
  let totalSamples = 0;
  const intervals: string[] = [];
  for (const packetValue of packets) {
    if (typeof packetValue !== "object" || packetValue === null)
      throw invalid(subject, "Invalid packet record");
    const packet = packetValue as Record<string, unknown>;
    const pts = parseInteger(packet["pts"]);
    const dts = parseInteger(packet["dts"]);
    const duration = parseInteger(packet["duration"]);
    const ptsTime =
      typeof packet["pts_time"] === "string" ? packet["pts_time"] : undefined;
    const durationTime =
      typeof packet["duration_time"] === "string"
        ? packet["duration_time"]
        : undefined;
    if (
      pts === undefined ||
      dts === undefined ||
      duration === undefined ||
      duration <= 0 ||
      ptsTime === undefined ||
      durationTime === undefined ||
      (previousDts !== undefined && dts < previousDts)
    )
      throw invalid(subject, "Packet timestamps are missing or non-monotonic");
    previousDts = dts;
    totalSamples += duration;
    if (!Number.isSafeInteger(totalSamples))
      throw invalid(subject, "Total sample count exceeds safe bounds");
    intervals.push(`${ptsTime}/${durationTime}`);
  }
  return { intervals, totalSamples };
};

export const validatePlaintextRendition = (
  process: NativeProcessService,
  ffmpegPath: string,
  ffprobePath: string,
  playlistPath: string,
  sampleRateHz: 44_100 | 48_000,
  durationMs: number,
): Effect.Effect<
  TimelineValidation,
  NativeProcessError | MediaValidationError
> =>
  Effect.gen(function* () {
    const packetResult = yield* process.run({
      role: "ffprobe-timeline",
      executable: ffprobePath,
      args: packetArgs(playlistPath),
      stdoutLimitBytes: PACKET_JSON_LIMIT,
    });
    const timeline = yield* Effect.try({
      try: () => parseTimeline(playlistPath, packetResult.stdout, sampleRateHz),
      catch: (error) =>
        error instanceof MediaValidationError
          ? error
          : invalid(playlistPath, "Packet validation failed"),
    });
    yield* process.run({
      role: "ffmpeg-decode",
      executable: ffmpegPath,
      args: [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        playlistPath,
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      retainStdout: false,
    });

    let carry = Buffer.alloc(0);
    let invalidSample = false;
    let decodedBytes = 0;
    const byteCeiling = Math.ceil(
      (durationMs / 1_000 + 2) * sampleRateHz * 2 * 4,
    );
    yield* process.run({
      role: "ffmpeg-clipping-scan",
      executable: ffmpegPath,
      args: [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-i",
        playlistPath,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-",
      ],
      retainStdout: false,
      onStdoutChunk: (chunk) => {
        decodedBytes += chunk.byteLength;
        if (decodedBytes > byteCeiling)
          throw new RangeError("decoded PCM exceeded bounded ceiling");
        const value =
          carry.byteLength === 0
            ? Buffer.from(chunk)
            : Buffer.concat([carry, chunk]);
        const complete = value.byteLength - (value.byteLength % 4);
        for (let offset = 0; offset < complete; offset += 4) {
          const sample = value.readFloatLE(offset);
          if (!Number.isFinite(sample) || Math.abs(sample) > 1)
            invalidSample = true;
        }
        carry = Buffer.from(value.subarray(complete));
      },
    });
    if (carry.byteLength !== 0 || invalidSample)
      return yield* Effect.fail(
        invalid(
          playlistPath,
          "Decoded audio contains clipping or non-finite samples",
        ),
      );
    return timeline;
  });
