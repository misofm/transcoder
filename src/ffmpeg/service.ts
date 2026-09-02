import { Context, Effect, Layer } from "effect";

import type {
  InvalidRequestError,
  NativeProcessError,
  ToolchainCapabilityError,
  ToolNotFoundError,
  UnsupportedSourceError,
} from "../errors.js";
import type { ToolchainFingerprint } from "../model.js";
import {
  NativeProcess,
  type NativeProcessResult,
  type NativeProcessService,
} from "../process/native-process.js";
import { inspectToolchain } from "./capabilities.js";
import { measureAudio, type DecodedAudioMeasurement } from "./audio-meter.js";
import { encodeLadder, type LadderInvocationOptions } from "./invocation.js";
import { probeSource, type SourceProbe } from "./probe.js";
import {
  validatePlaintextRendition,
  type TimelineValidation,
} from "./validate-media.js";

export interface FfmpegService {
  readonly inspectToolchain: (
    ffmpegPath: string,
    ffprobePath: string,
  ) => Effect.Effect<
    ToolchainFingerprint,
    | InvalidRequestError
    | NativeProcessError
    | ToolNotFoundError
    | ToolchainCapabilityError
  >;
  readonly probeSource: (
    ffprobePath: string,
    inputPath: string,
  ) => Effect.Effect<
    SourceProbe,
    InvalidRequestError | UnsupportedSourceError | NativeProcessError
  >;
  readonly encodeLadder: (
    options: LadderInvocationOptions,
  ) => Effect.Effect<
    NativeProcessResult,
    InvalidRequestError | NativeProcessError
  >;
  readonly validatePlaintextRendition: (
    ffmpegPath: string,
    ffprobePath: string,
    playlistPath: string,
    sampleRateHz: 44_100 | 48_000,
    durationMs: number,
  ) => Effect.Effect<
    TimelineValidation,
    NativeProcessError | import("../errors.js").MediaValidationError
  >;
  readonly measureAudio: (
    ffmpegPath: string,
    inputPath: string,
    sampleRateHz: 44_100 | 48_000,
    durationMs: number,
    normalizedSource?: Pick<SourceProbe, "channels">,
  ) => Effect.Effect<
    DecodedAudioMeasurement,
    NativeProcessError | import("../errors.js").MediaValidationError
  >;
}

export const makeFfmpeg = (process: NativeProcessService): FfmpegService => ({
  inspectToolchain: (ffmpegPath, ffprobePath) =>
    inspectToolchain(process, ffmpegPath, ffprobePath),
  probeSource: (ffprobePath, inputPath) =>
    probeSource(process, ffprobePath, inputPath),
  encodeLadder: (options) => encodeLadder(process, options),
  measureAudio: (
    ffmpegPath,
    inputPath,
    sampleRateHz,
    durationMs,
    normalizedSource,
  ) =>
    measureAudio(
      process,
      ffmpegPath,
      inputPath,
      sampleRateHz,
      durationMs,
      normalizedSource,
    ),
  validatePlaintextRendition: (
    ffmpegPath,
    ffprobePath,
    playlistPath,
    sampleRateHz,
    durationMs,
  ) =>
    validatePlaintextRendition(
      process,
      ffmpegPath,
      ffprobePath,
      playlistPath,
      sampleRateHz,
      durationMs,
    ),
});

export class Ffmpeg extends Context.Service<Ffmpeg, FfmpegService>()(
  "@misofm/transcoder/internal/Ffmpeg",
) {}

export const FfmpegLive = Layer.effect(
  Ffmpeg,
  Effect.gen(function* () {
    return makeFfmpeg(yield* NativeProcess);
  }),
);
