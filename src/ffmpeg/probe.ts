import { isAbsolute } from "node:path";

import { Effect } from "effect";

import {
  InvalidRequestError,
  UnsupportedSourceError,
  type NativeProcessError,
} from "../errors.js";
import type { NativeProcessService } from "../process/native-process.js";

export const FFPROBE_JSON_LIMIT_BYTES = 4 * 1024 * 1024;

export interface SourceProbe {
  readonly streamIndex: number;
  readonly durationMs: number;
  readonly sampleRateHz: 44100 | 48000;
  readonly channels: 1 | 2;
  readonly startTimeSeconds: number;
}

export const sourceProbeArgs = (inputPath: string): ReadonlyArray<string> => [
  "-hide_banner",
  "-v",
  "error",
  "-select_streams",
  "a",
  "-show_entries",
  "stream=index,codec_type,sample_rate,channels,duration,start_time,time_base:format=duration,start_time",
  "-of",
  "json",
  inputPath,
];

const unsupported = (message: string): UnsupportedSourceError =>
  new UnsupportedSourceError({
    code: "UNSUPPORTED_SOURCE",
    phase: "probe",
    subject: "0:a:0",
    message,
  });

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const finiteDecimal = (value: unknown): number | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseSourceProbe = (json: string): SourceProbe => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw unsupported("FFprobe returned invalid JSON");
  }
  const root = record(decoded);
  const streams = root?.["streams"];
  if (!Array.isArray(streams) || streams.length === 0) {
    throw unsupported("The source contains no audio stream");
  }
  if (streams.length !== 1) {
    throw unsupported("The source must contain exactly one audio stream");
  }
  const stream = record(streams[0]);
  if (
    stream === undefined ||
    (stream["codec_type"] !== undefined && stream["codec_type"] !== "audio")
  ) {
    throw unsupported("The selected stream is not audio");
  }
  const streamIndex = stream["index"];
  if (!Number.isSafeInteger(streamIndex) || (streamIndex as number) < 0) {
    throw unsupported("The selected audio stream has an invalid index");
  }
  const sampleRate = finiteDecimal(stream["sample_rate"]);
  if (sampleRate !== 44_100 && sampleRate !== 48_000) {
    throw unsupported("The source sample rate must be 44100 or 48000 Hz");
  }
  const channels = stream["channels"];
  if (channels !== 1 && channels !== 2) {
    throw unsupported("The source must contain mono or stereo audio");
  }
  const format = record(root?.["format"]);
  const duration =
    finiteDecimal(stream["duration"]) ?? finiteDecimal(format?.["duration"]);
  if (duration === undefined || duration <= 0) {
    throw unsupported("The source has an empty or unknown duration");
  }
  const durationMs = Math.ceil(duration * 1_000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw unsupported("The source duration is outside the supported range");
  }
  const streamStart = finiteDecimal(stream["start_time"]);
  const formatStart = finiteDecimal(format?.["start_time"]);
  if (
    (stream["start_time"] !== undefined && streamStart === undefined) ||
    (format?.["start_time"] !== undefined && formatStart === undefined)
  ) {
    throw unsupported("The source contains invalid timestamps");
  }
  const startTimeSeconds = streamStart ?? formatStart ?? 0;
  if (!Number.isFinite(startTimeSeconds)) {
    throw unsupported("The source contains invalid timestamps");
  }

  return {
    streamIndex: streamIndex as number,
    durationMs,
    sampleRateHz: sampleRate,
    channels,
    startTimeSeconds,
  };
};

export const probeSource = (
  process: NativeProcessService,
  ffprobePath: string,
  inputPath: string,
): Effect.Effect<
  SourceProbe,
  InvalidRequestError | UnsupportedSourceError | NativeProcessError
> => {
  if (!isAbsolute(ffprobePath) || !isAbsolute(inputPath)) {
    return Effect.fail(
      new InvalidRequestError({
        code: "INVALID_REQUEST",
        phase: "request",
        subject: "probe",
        message: "FFprobe and source paths must be absolute",
      }),
    );
  }
  return process
    .run({
      role: "ffprobe-source",
      executable: ffprobePath,
      args: sourceProbeArgs(inputPath),
      stdoutLimitBytes: FFPROBE_JSON_LIMIT_BYTES,
    })
    .pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () =>
            parseSourceProbe(
              new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
            ),
          catch: (error) =>
            error instanceof UnsupportedSourceError
              ? error
              : unsupported("FFprobe source metadata is not valid UTF-8 JSON"),
        }),
      ),
    );
};
