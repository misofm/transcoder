import { join } from "node:path";

import { Context, Effect, Layer } from "effect";

import type {
  ArtifactValidationError,
  CryptoError,
  WorkspaceIoError,
} from "../errors.js";
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
import { finalizeTranscode } from "./finalize.js";
import { prepareTranscode, type PrepareError } from "./prepare.js";
import { verifyArtifact } from "./verify.js";

export type FinalizeError =
  | CryptoError
  | ArtifactValidationError
  | WorkspaceIoError;
export type VerifyError = ArtifactValidationError;

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
}

export class Transcoder extends Context.Service<
  Transcoder,
  TranscoderService
>()("@misofm/transcoder/Transcoder") {}

export const TranscoderLive = Layer.effect(
  Transcoder,
  Effect.gen(function* () {
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
        const workspacePath = join(request.prepared.rootPath, "..", "..");
        return around(
          "finalize",
          withWorkspaceLock(workspacePath, "finalize", () =>
            finalizeTranscode(request, material),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => material.rootKey.fill(0))));
      },
      verify: (artifact) => around("verify", verifyArtifact(artifact)),
    };
  }),
);
