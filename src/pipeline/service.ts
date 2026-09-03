import { Context, Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type {
  ArtifactValidationError,
  InvalidRequestError,
  StaleWorkspaceError,
  WorkspaceIoError,
  WorkspaceLockedError,
} from "../errors.js";
import { Ffmpeg } from "../ffmpeg/service.js";
import type {
  TranscodeArtifact,
  TranscodeRequest,
  VerifiedArtifact,
} from "../model.js";
import { TranscodeObserver } from "../observer.js";
import { withWorkspaceLock } from "../workspace/lock.js";
import {
  cleanupWorkspaceTemporaries,
  writeWorkspaceState,
} from "../workspace/state.js";
import { cleanupTranscodeArtifact } from "./cleanup.js";
import { finalizeTranscode } from "./finalize.js";
import {
  prepareTranscode,
  verifyPreparedTranscode,
  type PrepareError,
} from "./prepare.js";
import { verifyArtifact } from "./verify.js";

export type TranscodeError =
  | PrepareError
  | ArtifactValidationError
  | WorkspaceIoError;
export type VerifyError = ArtifactValidationError;
export type CleanupError =
  | InvalidRequestError
  | WorkspaceIoError
  | WorkspaceLockedError
  | StaleWorkspaceError;

export interface TranscoderService {
  readonly transcode: (
    request: TranscodeRequest,
  ) => Effect.Effect<TranscodeArtifact, TranscodeError>;
  readonly verify: (
    artifact: TranscodeArtifact,
  ) => Effect.Effect<VerifiedArtifact, VerifyError>;
  readonly cleanup: (
    artifact: TranscodeArtifact,
  ) => Effect.Effect<void, CleanupError>;
}

export class Transcoder extends Context.Service<
  Transcoder,
  TranscoderService
>()("@misofm/transcoder/Transcoder") {}

export const TranscoderLive = Layer.effect(
  Transcoder,
  Effect.gen(function* () {
    yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ffmpeg = yield* Ffmpeg;
    const observer = yield* TranscodeObserver;
    const around = <A, E>(
      phase: "prepare" | "finalize" | "verify",
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      observer.emit({ _tag: "PhaseStarted", phase }).pipe(
        Effect.andThen(effect),
        Effect.tap(() => observer.emit({ _tag: "PhaseCompleted", phase })),
      );
    return {
      transcode: (request) =>
        around(
          "prepare",
          prepareTranscode(request).pipe(Effect.provideService(Ffmpeg, ffmpeg)),
        ).pipe(
          Effect.flatMap((prepared) => {
            const workspacePath = path.join(prepared.rootPath, "..", "..");
            return around(
              "finalize",
              withWorkspaceLock(workspacePath, "finalize", () =>
                cleanupWorkspaceTemporaries(workspacePath).pipe(
                  Effect.andThen(verifyPreparedTranscode(prepared)),
                  Effect.provideService(Ffmpeg, ffmpeg),
                  Effect.andThen(
                    finalizeTranscode({
                      prepared,
                      ...(request.fresh === undefined
                        ? {}
                        : { fresh: request.fresh }),
                      ...(request.fileConcurrency === undefined
                        ? {}
                        : { fileConcurrency: request.fileConcurrency }),
                    }),
                  ),
                  Effect.tap((artifact) =>
                    writeWorkspaceState(workspacePath, {
                      schema: "miso.transcoder-workspace/1",
                      prepareDigest: prepared.prepareDigest,
                      transcodeDigest: artifact.transcodeDigest,
                    }),
                  ),
                ),
              ),
            );
          }),
        ),
      verify: (artifact) => around("verify", verifyArtifact(artifact)),
      cleanup: (artifact) => {
        const workspacePath = path.join(artifact.rootPath, "..", "..");
        return withWorkspaceLock(workspacePath, "cleanup", () =>
          cleanupTranscodeArtifact(artifact),
        );
      },
    };
  }),
);
