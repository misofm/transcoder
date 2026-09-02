import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { Effect } from "effect";

import {
  InvalidRequestError,
  ToolchainCapabilityError,
  ToolNotFoundError,
  type NativeProcessError,
} from "../errors.js";
import type { ToolchainFingerprint } from "../model.js";
import type { NativeProcessService } from "../process/native-process.js";

const VERSION_OUTPUT_LIMIT = 256 * 1024;
const CAPABILITY_OUTPUT_LIMIT = 4 * 1024 * 1024;

export const REQUIRED_FFMPEG_VERSION = "8.1.2" as const;

export const FFMPEG_VERSION_ARGS = ["-version"] as const;
export const FFPROBE_VERSION_ARGS = ["-version"] as const;
export const FFMPEG_ENCODERS_ARGS = ["-hide_banner", "-encoders"] as const;
export const FFMPEG_MUXERS_ARGS = ["-hide_banner", "-muxers"] as const;
export const FFMPEG_FILTERS_ARGS = ["-hide_banner", "-filters"] as const;
export const FFMPEG_VOLUME_HELP_ARGS = [
  "-hide_banner",
  "-h",
  "filter=volume",
] as const;
export const FFMPEG_HLS_HELP_ARGS = [
  "-hide_banner",
  "-h",
  "muxer=hls",
] as const;
export const FFPROBE_JSON_ARGS = [
  "-hide_banner",
  "-show_program_version",
  "-of",
  "json",
] as const;

export const TOOLCHAIN_CAPABILITIES = [
  "aac-encoder:native",
  "hls-muxer",
  "hls-segment-type:fmp4",
  "hls-var-stream-map",
  "hls-named-variant-template",
  "ffprobe-output:json",
] as const;

export interface CapabilityOutputs {
  readonly ffmpegVersion: string;
  readonly ffprobeVersion: string;
  readonly encoders: string;
  readonly muxers: string;
  readonly filters: string;
  readonly volumeHelp: string;
  readonly hlsHelp: string;
  readonly ffprobeJson: string;
}

const decode = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

const firstNonemptyLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .find((line) => line.trim().length > 0);

const firstBuildLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .find((line) => /^built with\s/u.test(line));

const configurationLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .find((line) => /^configuration:/u.test(line));

const versionToken = (
  line: string,
  product: "ffmpeg" | "ffprobe",
): string | undefined => {
  const match = new RegExp(`^${product} version\\s+(\\S+)`, "u").exec(line);
  return match?.[1];
};

const isRequiredVersion = (token: string | undefined): boolean =>
  token === REQUIRED_FFMPEG_VERSION ||
  token?.startsWith(`${REQUIRED_FFMPEG_VERSION}-`) === true;

const libraryVersion = (
  value: string,
  library: "libavcodec" | "libavformat",
): string | undefined => {
  const match = new RegExp(`^\\s*${library}\\s+([^\\r\\n]+)$`, "mu").exec(
    value,
  );
  return match?.[1]?.trim().replace(/\s+/gu, " ");
};

const capabilityError = (
  subject: string,
  message: string,
): ToolchainCapabilityError =>
  new ToolchainCapabilityError({
    code: "TOOLCHAIN_CAPABILITY",
    phase: "capability",
    subject,
    message,
  });

export const parseToolchainFingerprint = (
  ffmpegPath: string,
  ffprobePath: string,
  outputs: CapabilityOutputs,
): ToolchainFingerprint => {
  const ffmpegVersion = firstNonemptyLine(outputs.ffmpegVersion);
  const ffprobeVersion = firstNonemptyLine(outputs.ffprobeVersion);
  const ffmpegBuild = firstBuildLine(outputs.ffmpegVersion);
  const ffprobeBuild = firstBuildLine(outputs.ffprobeVersion);
  const ffmpegConfiguration = configurationLine(outputs.ffmpegVersion);
  const ffprobeConfiguration = configurationLine(outputs.ffprobeVersion);
  if (
    ffmpegVersion === undefined ||
    versionToken(ffmpegVersion, "ffmpeg") === undefined
  ) {
    throw capabilityError(
      "ffmpeg",
      "FFmpeg returned an unrecognized version line",
    );
  }
  if (
    ffprobeVersion === undefined ||
    versionToken(ffprobeVersion, "ffprobe") === undefined
  ) {
    throw capabilityError(
      "ffprobe",
      "FFprobe returned an unrecognized version line",
    );
  }
  if (
    versionToken(ffmpegVersion, "ffmpeg") !==
    versionToken(ffprobeVersion, "ffprobe")
  ) {
    throw capabilityError(
      "toolchain",
      "FFmpeg and FFprobe build versions do not match",
    );
  }
  if (
    !isRequiredVersion(versionToken(ffmpegVersion, "ffmpeg")) ||
    !isRequiredVersion(versionToken(ffprobeVersion, "ffprobe"))
  ) {
    throw capabilityError(
      "toolchain",
      `FFmpeg and FFprobe ${REQUIRED_FFMPEG_VERSION} are required`,
    );
  }
  if (
    ffmpegBuild === undefined ||
    ffprobeBuild === undefined ||
    ffmpegBuild !== ffprobeBuild ||
    ffmpegConfiguration === undefined ||
    ffprobeConfiguration === undefined ||
    ffmpegConfiguration !== ffprobeConfiguration
  ) {
    throw capabilityError(
      "toolchain",
      "FFmpeg and FFprobe did not report complete build lines",
    );
  }

  const libavcodecVersion = libraryVersion(outputs.ffmpegVersion, "libavcodec");
  const libavformatVersion = libraryVersion(
    outputs.ffmpegVersion,
    "libavformat",
  );
  if (libavcodecVersion === undefined || libavformatVersion === undefined) {
    throw capabilityError(
      "ffmpeg",
      "FFmpeg did not report required library versions",
    );
  }
  if (
    libraryVersion(outputs.ffprobeVersion, "libavcodec") !==
      libavcodecVersion ||
    libraryVersion(outputs.ffprobeVersion, "libavformat") !== libavformatVersion
  )
    throw capabilityError(
      "toolchain",
      "FFmpeg and FFprobe library versions do not match",
    );
  if (!/^\s*A\S*\s+aac\s/imu.test(outputs.encoders)) {
    throw capabilityError("ffmpeg", "FFmpeg native AAC encoder is unavailable");
  }
  if (!/^\s*E\S*\s+hls\s/imu.test(outputs.muxers)) {
    throw capabilityError("ffmpeg", "FFmpeg HLS muxer is unavailable");
  }
  if (!/^\s*\S+\s+loudnorm\s/imu.test(outputs.filters)) {
    throw capabilityError("ffmpeg", "FFmpeg loudnorm filter is unavailable");
  }
  if (!/^\s*\S+\s+volume\s/imu.test(outputs.filters)) {
    throw capabilityError("ffmpeg", "FFmpeg volume filter is unavailable");
  }
  if (
    !/precision/iu.test(outputs.volumeHelp) ||
    !/\bdouble\b/iu.test(outputs.volumeHelp)
  ) {
    throw capabilityError(
      "ffmpeg",
      "FFmpeg double-precision volume filter is unavailable",
    );
  }
  if (
    !/hls_segment_type/iu.test(outputs.hlsHelp) ||
    !/fmp4/iu.test(outputs.hlsHelp)
  ) {
    throw capabilityError("ffmpeg", "FFmpeg HLS fMP4 support is unavailable");
  }
  if (!/var_stream_map/iu.test(outputs.hlsHelp)) {
    throw capabilityError(
      "ffmpeg",
      "FFmpeg var_stream_map support is unavailable",
    );
  }
  if (
    !/hls_segment_filename/iu.test(outputs.hlsHelp) ||
    !/master_pl_name/iu.test(outputs.hlsHelp)
  ) {
    throw capabilityError(
      "ffmpeg",
      "FFmpeg variant filename templates are unavailable",
    );
  }
  try {
    const parsed: unknown = JSON.parse(outputs.ffprobeJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TypeError();
    const programVersion = (parsed as Record<string, unknown>)[
      "program_version"
    ];
    const reportedVersion =
      typeof programVersion === "object" && programVersion !== null
        ? (programVersion as Record<string, unknown>)["version"]
        : undefined;
    if (
      typeof reportedVersion !== "string" ||
      !isRequiredVersion(reportedVersion)
    )
      throw new TypeError();
  } catch {
    throw capabilityError(
      "ffprobe",
      `FFprobe ${REQUIRED_FFMPEG_VERSION} JSON output is unavailable`,
    );
  }

  const withoutDigest = {
    ffmpegPath,
    ffprobePath,
    ffmpegVersion,
    ffmpegBuild,
    ffprobeVersion,
    ffprobeBuild,
    configuration: ffmpegConfiguration,
    libavcodecVersion,
    libavformatVersion,
    capabilities: TOOLCHAIN_CAPABILITIES,
  };
  const sha256 = createHash("sha256")
    .update(`${JSON.stringify(withoutDigest)}\n`, "utf8")
    .digest("hex");
  return { ...withoutDigest, sha256 };
};

const toolNotFound = (role: "ffmpeg" | "ffprobe"): ToolNotFoundError =>
  new ToolNotFoundError({
    code: "TOOL_NOT_FOUND",
    phase: "capability",
    subject: role,
    message: `The configured ${role} executable could not be started`,
    role,
  });

const runText = (
  process: NativeProcessService,
  role: "ffmpeg" | "ffprobe",
  executable: string,
  args: ReadonlyArray<string>,
  stdoutLimitBytes: number,
): Effect.Effect<string, NativeProcessError | ToolNotFoundError> =>
  process.run({ role, executable, args, stdoutLimitBytes }).pipe(
    Effect.map((result) => decode(result.stdout)),
    Effect.mapError((error): NativeProcessError | ToolNotFoundError =>
      error._tag === "ProcessSpawnError" && error.reason === "ENOENT"
        ? toolNotFound(role)
        : error,
    ),
  );

export const inspectToolchain = (
  process: NativeProcessService,
  ffmpegPath: string,
  ffprobePath: string,
): Effect.Effect<
  ToolchainFingerprint,
  | InvalidRequestError
  | NativeProcessError
  | ToolNotFoundError
  | ToolchainCapabilityError
> => {
  if (!isAbsolute(ffmpegPath) || !isAbsolute(ffprobePath)) {
    return Effect.fail(
      new InvalidRequestError({
        code: "INVALID_REQUEST",
        phase: "request",
        subject: "toolchain",
        message: "FFmpeg and FFprobe executable paths must be absolute",
      }),
    );
  }

  return Effect.gen(function* () {
    const ffmpegVersion = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_VERSION_ARGS,
      VERSION_OUTPUT_LIMIT,
    );
    const ffprobeVersion = yield* runText(
      process,
      "ffprobe",
      ffprobePath,
      FFPROBE_VERSION_ARGS,
      VERSION_OUTPUT_LIMIT,
    );
    const encoders = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_ENCODERS_ARGS,
      CAPABILITY_OUTPUT_LIMIT,
    );
    const muxers = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_MUXERS_ARGS,
      CAPABILITY_OUTPUT_LIMIT,
    );
    const filters = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_FILTERS_ARGS,
      CAPABILITY_OUTPUT_LIMIT,
    );
    const volumeHelp = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_VOLUME_HELP_ARGS,
      CAPABILITY_OUTPUT_LIMIT,
    );
    const hlsHelp = yield* runText(
      process,
      "ffmpeg",
      ffmpegPath,
      FFMPEG_HLS_HELP_ARGS,
      CAPABILITY_OUTPUT_LIMIT,
    );
    const ffprobeJson = yield* runText(
      process,
      "ffprobe",
      ffprobePath,
      FFPROBE_JSON_ARGS,
      VERSION_OUTPUT_LIMIT,
    );
    return yield* Effect.try({
      try: () =>
        parseToolchainFingerprint(ffmpegPath, ffprobePath, {
          ffmpegVersion,
          ffprobeVersion,
          encoders,
          muxers,
          filters,
          volumeHelp,
          hlsHelp,
          ffprobeJson,
        }),
      catch: (error) =>
        error instanceof ToolchainCapabilityError
          ? error
          : capabilityError(
              "toolchain",
              "Toolchain capability output could not be parsed",
            ),
    });
  });
};
