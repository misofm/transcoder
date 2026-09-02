import { Context, Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type {
  ArtifactValidationError,
  CryptoError,
  InvalidRequestError,
  StaleWorkspaceError,
  WorkspaceIoError,
  WorkspaceLockedError,
} from "../errors.js";
import { StaleWorkspaceError as StaleWorkspaceFailure } from "../errors.js";
import { Ffmpeg } from "../ffmpeg/service.js";
import type {
  FinalizeRequest,
  GenerationMaterial,
  PrepareRequest,
  QuiltArtifact,
  VerifiedArtifact,
} from "../model.js";
import { TranscodeObserver } from "../observer.js";
import { withWorkspaceLock } from "../workspace/lock.js";
import {
  cleanupWorkspaceTemporaries,
  readWorkspaceState,
  writeWorkspaceState,
} from "../workspace/state.js";
import { finalizeTranscode } from "./finalize.js";
import { cleanupPreparedTranscode } from "./cleanup.js";
import {
  prepareTranscode,
  verifyPreparedTranscode,
  type PrepareError,
} from "./prepare.js";
import { verifyArtifact } from "./verify.js";

export type FinalizeError =
  | CryptoError
  | ArtifactValidationError
  | WorkspaceIoError;
export type VerifyError = ArtifactValidationError;
export type CleanupError =
  | InvalidRequestError
  | WorkspaceIoError
  | WorkspaceLockedError
  | StaleWorkspaceError;

export interface TranscoderService {
  readonly prepare: (
    request: PrepareRequest,
  ) => Effect.Effect<import("../model.js").PreparedTranscode, PrepareError>;
  readonly finalize: (
    request: FinalizeRequest,
    material: GenerationMaterial,
  ) => Effect.Effect<QuiltArtifact, FinalizeError | PrepareError>;
  readonly verify: (
    artifact: QuiltArtifact,
  ) => Effect.Effect<VerifiedArtifact, VerifyError>;
  readonly cleanupPrepared: (
    prepared: import("../model.js").PreparedTranscode,
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
      prepare: (request) =>
        around(
          "prepare",
          prepareTranscode(request).pipe(Effect.provideService(Ffmpeg, ffmpeg)),
        ),
      finalize: (request, material) => {
        const workspacePath = path.join(request.prepared.rootPath, "..", "..");
        return Effect.suspend(() => {
          if (
            material.rootKey.byteLength !== 32 ||
            material.generationNonce.byteLength !== 32
          )
            return finalizeTranscode(request, material);
          const ownedMaterial: GenerationMaterial = {
            generationNonce: Uint8Array.from(material.generationNonce),
            rootKey: Uint8Array.from(material.rootKey),
          };
          material.rootKey.fill(0);
          return around(
            "finalize",
            withWorkspaceLock(workspacePath, "finalize", () =>
              cleanupWorkspaceTemporaries(workspacePath).pipe(
                Effect.andThen(verifyPreparedTranscode(request.prepared)),
                Effect.provideService(Ffmpeg, ffmpeg),
                Effect.andThen(finalizeTranscode(request, ownedMaterial)),
                Effect.tap((artifact) =>
                  writeWorkspaceState(workspacePath, {
                    schema: "miso.transcoder-workspace/1",
                    prepareDigest: request.prepared.prepareDigest,
                    generationDigest: artifact.generationDigest,
                  }),
                ),
              ),
            ),
          ).pipe(
            Effect.ensuring(Effect.sync(() => ownedMaterial.rootKey.fill(0))),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => material.rootKey.fill(0))));
      },
      verify: (artifact) => around("verify", verifyArtifact(artifact)),
      cleanupPrepared: (prepared) => {
        const workspacePath = path.join(prepared.rootPath, "..", "..");
        return withWorkspaceLock(workspacePath, "cleanup", () =>
          Effect.gen(function* () {
            const state = yield* readWorkspaceState(workspacePath);
            if (
              state.prepareDigest !== undefined &&
              state.prepareDigest !== prepared.prepareDigest
            )
              return yield* Effect.fail(
                new StaleWorkspaceFailure({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: prepared.rootPath,
                  message: "Cleanup target is not the current preparation",
                }),
              );
            yield* cleanupPreparedTranscode(prepared);
            yield* writeWorkspaceState(workspacePath, {
              schema: "miso.transcoder-workspace/1",
              ...(state.generationDigest === undefined
                ? {}
                : { generationDigest: state.generationDigest }),
            });
          }),
        );
      },
    };
  }),
);
