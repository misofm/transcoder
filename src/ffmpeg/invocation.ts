import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { InvalidRequestError, type NativeProcessError } from "../errors.js";
import { RENDITIONS } from "../model.js";
import type {
  NativeProcessService,
  NativeProcessResult,
} from "../process/native-process.js";
import type { SourceProbe } from "./probe.js";

const bitrateArgument = (bitrate: number): string =>
  `${Math.trunc(bitrate / 1_000)}k`;

export interface LadderInvocation {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface LadderInvocationOptions {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  readonly outputDirectory: string;
  readonly source: Pick<SourceProbe, "sampleRateHz" | "channels">;
  readonly segmentTargetMs: number;
}

export const normalizedAudioFilter = (
  sampleRateHz: 44_100 | 48_000,
  channels: 1 | 2,
): string => {
  const channelFilter =
    channels === 1
      ? "pan=stereo|c0=c0|c1=c0"
      : "aformat=channel_layouts=stereo";
  return `[0:a:0]${channelFilter},aresample=${sampleRateHz}:async=0:first_pts=0,asetpts=N/SR/TB,asplit=3[aac096][aac160][aac256]`;
};

export const buildLadderInvocation = (
  options: LadderInvocationOptions,
): LadderInvocation => {
  if (
    !isAbsolute(options.ffmpegPath) ||
    !isAbsolute(options.inputPath) ||
    !isAbsolute(options.outputDirectory)
  ) {
    throw new InvalidRequestError({
      code: "INVALID_REQUEST",
      phase: "request",
      subject: "ffmpeg-ladder",
      message: "FFmpeg, source, and output paths must be absolute",
    });
  }
  if (
    !Number.isSafeInteger(options.segmentTargetMs) ||
    options.segmentTargetMs < 6_000 ||
    options.segmentTargetMs > 10_000
  ) {
    throw new InvalidRequestError({
      code: "INVALID_REQUEST",
      phase: "request",
      subject: "segmentTargetMs",
      message:
        "Segment target must be an integer from 6000 through 10000 milliseconds",
    });
  }

  const streamMap = RENDITIONS.map(
    (rendition, index) => `a:${index},name:${rendition.id}`,
  ).join(" ");
  const args: Array<string> = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    options.inputPath,
    "-vn",
    "-sn",
    "-dn",
    "-filter_complex",
    normalizedAudioFilter(options.source.sampleRateHz, options.source.channels),
    "-map",
    "[aac096]",
    "-map",
    "[aac160]",
    "-map",
    "[aac256]",
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
  ];
  for (const [index, rendition] of RENDITIONS.entries()) {
    args.push(`-b:a:${index}`, bitrateArgument(rendition.nominalBitrate));
  }
  args.push(
    "-ar:a",
    String(options.source.sampleRateHz),
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
    (options.segmentTargetMs / 1_000).toFixed(3),
    "-hls_list_size",
    "0",
    "-start_number",
    "0",
    "-hls_fmp4_init_filename",
    "%v-init.mp4",
    "-hls_segment_filename",
    join(options.outputDirectory, "%v-%05d.m4s"),
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    streamMap,
    "-progress",
    "pipe:3",
    "-nostats",
    join(options.outputDirectory, "%v.m3u8"),
  );

  return { executable: options.ffmpegPath, args, cwd: options.outputDirectory };
};

export const encodeLadder = (
  process: NativeProcessService,
  options: LadderInvocationOptions,
): Effect.Effect<
  NativeProcessResult,
  InvalidRequestError | NativeProcessError
> =>
  Effect.try({
    try: () => buildLadderInvocation(options),
    catch: (error) =>
      error instanceof InvalidRequestError
        ? error
        : new InvalidRequestError({
            code: "INVALID_REQUEST",
            phase: "request",
            subject: "ffmpeg-ladder",
            message: "The FFmpeg ladder request is invalid",
          }),
  }).pipe(
    Effect.flatMap((invocation) =>
      process.run({
        role: "ffmpeg-ladder",
        executable: invocation.executable,
        args: invocation.args,
        cwd: invocation.cwd,
        retainStdout: false,
      }),
    ),
  );
