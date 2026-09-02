import { Effect } from "effect";

import { MediaValidationError, type NativeProcessError } from "../errors.js";
import type { AudioMeasurement } from "../model.js";
import type { NativeProcessService } from "../process/native-process.js";
import type { SourceProbe } from "./probe.js";

export const AUDIO_POLICY_ID = "miso.aac-codec-preview/1" as const;
export const FINAL_TRUE_PEAK_CENTI_DBTP = -101;
export const PLANNING_TRUE_PEAK_CENTI_DBTP = -150;
export const GAIN_QUANTUM_CENTI_DB = 10;
export const LOUDNORM_RECIPE =
  "loudnorm=I=-24:LRA=7:TP=-2:print_format=json" as const;
const METER_OUTPUT_LIMIT = 256 * 1024;

export interface DecodedAudioMeasurement extends AudioMeasurement {
  readonly exactSamplePeak: number;
}

const invalid = (subject: string, message: string) =>
  new MediaValidationError({
    code: "MEDIA_VALIDATION",
    phase: "validate",
    subject,
    message,
  });

const assertNoDuplicateKeys = (source: string): void => {
  let position = 0;
  const whitespace = () => {
    while (/\s/u.test(source[position] ?? "")) position += 1;
  };
  const string = (): string => {
    const start = position;
    if (source[position++] !== '"') throw new SyntaxError();
    let escaped = false;
    while (position < source.length) {
      const character = source[position++]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"')
        return JSON.parse(source.slice(start, position)) as string;
      else if (character < " ") throw new SyntaxError();
    }
    throw new SyntaxError();
  };
  const value = (depth: number): void => {
    if (depth > 16) throw new SyntaxError();
    whitespace();
    if (source[position] === '"') {
      string();
      return;
    }
    if (source[position] === "{") {
      position += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[position] === "}") {
        position += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new SyntaxError();
        keys.add(key);
        whitespace();
        if (source[position++] !== ":") throw new SyntaxError();
        value(depth + 1);
        whitespace();
        const delimiter = source[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new SyntaxError();
      }
    }
    if (source[position] === "[") {
      position += 1;
      whitespace();
      if (source[position] === "]") {
        position += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = source[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new SyntaxError();
      }
    }
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?|true|false|null)/u.exec(
      source.slice(position),
    );
    if (match === null) throw new SyntaxError();
    position += match[0].length;
  };
  value(0);
  whitespace();
  if (position !== source.length) throw new SyntaxError();
};

const meterValue = (value: unknown): number | null => {
  if (value === "-inf") return null;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)\.\d{2}$/u.test(value))
    throw new TypeError();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < -999 || numeric > 999)
    throw new TypeError();
  return Math.round(numeric * 100);
};

const finiteMeterValue = (value: unknown): number => {
  const parsed = meterValue(value);
  if (parsed === null) throw new TypeError();
  return parsed;
};

export const parseLoudnormMeasurement = (
  subject: string,
  bytes: Uint8Array,
): Pick<
  AudioMeasurement,
  "integratedLoudnessCentiLufs" | "truePeakCentiDbtp"
> => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const reports: string[] = [];
    for (const marker of text.matchAll(
      /\[Parsed_loudnorm_\d+\s+@[^\]\r\n]+\]/gu,
    )) {
      let position = marker.index + marker[0].length;
      while (/\s/u.test(text[position] ?? "")) position += 1;
      if (text[position] !== "{") continue;
      const start = position;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (; position < text.length; position += 1) {
        const character = text[position]!;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === "{") depth += 1;
        else if (character === "}" && --depth === 0) {
          reports.push(text.slice(start, position + 1));
          break;
        }
      }
    }
    if (reports.length !== 1) throw new TypeError();
    const json = reports[0]!;
    assertNoDuplicateKeys(json);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TypeError();
    const record = parsed as Record<string, unknown>;
    const expected = [
      "input_i",
      "input_tp",
      "input_lra",
      "input_thresh",
      "output_i",
      "output_tp",
      "output_lra",
      "output_thresh",
      "normalization_type",
      "target_offset",
    ].sort();
    if (Object.keys(record).sort().join("\0") !== expected.join("\0"))
      throw new TypeError();
    const inputLra = finiteMeterValue(record["input_lra"]);
    finiteMeterValue(record["input_thresh"]);
    const outputI = meterValue(record["output_i"]);
    const outputTp = meterValue(record["output_tp"]);
    const outputLra = finiteMeterValue(record["output_lra"]);
    finiteMeterValue(record["output_thresh"]);
    if (
      inputLra < 0 ||
      outputLra < 0 ||
      (outputI === null) !== (outputTp === null)
    )
      throw new TypeError();
    if (
      record["normalization_type"] !== "linear" &&
      record["normalization_type"] !== "dynamic"
    )
      throw new TypeError();
    const inputI = meterValue(record["input_i"]);
    const inputTp = meterValue(record["input_tp"]);
    if (
      (inputI === null) !== (inputTp === null) ||
      (inputI === null) !== (outputI === null)
    )
      throw new TypeError();
    if (inputI === null) {
      if (
        outputI !== null ||
        outputTp !== null ||
        record["target_offset"] !== "inf"
      )
        throw new TypeError();
    } else finiteMeterValue(record["target_offset"]);
    return {
      integratedLoudnessCentiLufs: inputI,
      truePeakCentiDbtp: inputTp,
    };
  } catch {
    throw invalid(
      subject,
      "FFmpeg loudnorm returned malformed measurement JSON",
    );
  }
};

export const planSharedGainCentiDb = (
  truePeaks: readonly (number | null)[],
): number => {
  const finite = truePeaks.filter((value): value is number => value !== null);
  if (finite.length === 0) return 0;
  const maximum = Math.max(...finite);
  return Math.min(
    0,
    Math.floor(
      (PLANNING_TRUE_PEAK_CENTI_DBTP - maximum) / GAIN_QUANTUM_CENTI_DB,
    ) * GAIN_QUANTUM_CENTI_DB,
  );
};

const samplePeakCentiDbfs = (peak: number): number | null =>
  peak === 0 ? null : Math.ceil(20 * Math.log10(peak) * 100);

const scanSamples = (
  process: NativeProcessService,
  ffmpegPath: string,
  subject: string,
  args: readonly string[],
  byteCeiling: number,
): Effect.Effect<
  {
    readonly exactSamplePeak: number;
    readonly samplePeakCentiDbfs: number | null;
  },
  NativeProcessError | MediaValidationError
> =>
  Effect.gen(function* () {
    let carry = Buffer.alloc(0);
    let decodedBytes = 0;
    let nonFinite = false;
    let peak = 0;
    yield* process.run({
      role: "ffmpeg-sample-scan",
      executable: ffmpegPath,
      args,
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
          if (!Number.isFinite(sample)) nonFinite = true;
          else peak = Math.max(peak, Math.abs(sample));
        }
        carry = Buffer.from(value.subarray(complete));
      },
    });
    if (
      decodedBytes === 0 ||
      decodedBytes > byteCeiling ||
      decodedBytes % 8 !== 0 ||
      carry.byteLength !== 0 ||
      nonFinite
    )
      return yield* Effect.fail(
        invalid(
          subject,
          "Decoded audio is malformed or contains non-finite samples",
        ),
      );
    return {
      exactSamplePeak: peak,
      samplePeakCentiDbfs: samplePeakCentiDbfs(peak),
    };
  });

const loudnormArgs = (
  inputPath: string,
  audioFilter?: string,
): readonly string[] => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "info",
  "-xerror",
  "-i",
  inputPath,
  ...(audioFilter === undefined
    ? ["-map", "0:a:0", "-af", LOUDNORM_RECIPE]
    : [
        "-filter_complex",
        `${audioFilter},${LOUDNORM_RECIPE}[meter]`,
        "-map",
        "[meter]",
      ]),
  "-f",
  "null",
  "-",
];

const pcmArgs = (
  inputPath: string,
  audioFilter?: string,
): readonly string[] => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-xerror",
  "-i",
  inputPath,
  ...(audioFilter === undefined
    ? ["-map", "0:a:0"]
    : ["-filter_complex", `${audioFilter}[scan]`, "-map", "[scan]"]),
  "-f",
  "f32le",
  "-acodec",
  "pcm_f32le",
  "-",
];

export const measureAudio = (
  process: NativeProcessService,
  ffmpegPath: string,
  inputPath: string,
  sampleRateHz: 44_100 | 48_000,
  durationMs: number,
  normalizedSource?: Pick<SourceProbe, "channels">,
): Effect.Effect<
  DecodedAudioMeasurement,
  NativeProcessError | MediaValidationError
> =>
  Effect.gen(function* () {
    const channelFilter =
      normalizedSource === undefined
        ? undefined
        : `[0:a:0]${
            normalizedSource.channels === 1
              ? "pan=stereo|c0=c0|c1=c0"
              : "aformat=channel_layouts=stereo"
          },aresample=${sampleRateHz}:async=0:first_pts=0,asetpts=N/SR/TB`;
    const meter = yield* process.run({
      role: "ffmpeg-loudnorm-meter",
      executable: ffmpegPath,
      args: loudnormArgs(inputPath, channelFilter),
      retainStdout: false,
      stderrLimitBytes: METER_OUTPUT_LIMIT,
    });
    if (meter.stderrTruncated)
      return yield* Effect.fail(
        invalid(inputPath, "FFmpeg loudnorm output was truncated"),
      );
    const loudness = yield* Effect.try({
      try: () => parseLoudnormMeasurement(inputPath, meter.stderrTail),
      catch: (error) =>
        error instanceof MediaValidationError
          ? error
          : invalid(inputPath, "FFmpeg loudnorm measurement failed"),
    });
    const samples = yield* scanSamples(
      process,
      ffmpegPath,
      inputPath,
      pcmArgs(inputPath, channelFilter),
      Math.ceil((durationMs / 1_000 + 2) * sampleRateHz * 2 * 4),
    );
    return { ...loudness, ...samples };
  });
