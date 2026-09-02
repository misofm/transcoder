import { Context, Effect, Layer } from "effect";

export type TranscodeEvent =
  | {
      readonly _tag: "PhaseStarted";
      readonly phase: "prepare" | "finalize" | "verify";
    }
  | {
      readonly _tag: "PhaseCompleted";
      readonly phase: "prepare" | "finalize" | "verify";
    };

export interface TranscodeObserverService {
  readonly emit: (event: TranscodeEvent) => Effect.Effect<void>;
}

export class TranscodeObserver extends Context.Service<
  TranscodeObserver,
  TranscodeObserverService
>()("@misofm/transcoder/TranscodeObserver") {}

export const TranscodeObserverNoop = Layer.succeed(TranscodeObserver, {
  emit: () => Effect.void,
});
