import { Data } from "effect";

export type TranscodePhase =
  | "request"
  | "capability"
  | "probe"
  | "prepare"
  | "encode"
  | "validate"
  | "finalize"
  | "verify"
  | "workspace"
  | "process";

interface FailureFields<Code extends string> {
  readonly code: Code;
  readonly phase: TranscodePhase;
  readonly subject: string;
  readonly message: string;
}

export class InvalidRequestError extends Data.TaggedError(
  "InvalidRequestError",
)<FailureFields<"INVALID_REQUEST">> {}

export class UnsupportedSourceError extends Data.TaggedError(
  "UnsupportedSourceError",
)<FailureFields<"UNSUPPORTED_SOURCE">> {}

export class ToolNotFoundError extends Data.TaggedError("ToolNotFoundError")<
  FailureFields<"TOOL_NOT_FOUND"> & { readonly role: "ffmpeg" | "ffprobe" }
> {}

export class ToolchainCapabilityError extends Data.TaggedError(
  "ToolchainCapabilityError",
)<FailureFields<"TOOLCHAIN_CAPABILITY">> {}

export class ProcessSpawnError extends Data.TaggedError("ProcessSpawnError")<
  FailureFields<"PROCESS_SPAWN"> & {
    readonly role: string;
    readonly reason: string;
  }
> {}

export class ProcessExitError extends Data.TaggedError("ProcessExitError")<
  FailureFields<"PROCESS_EXIT"> & {
    readonly role: string;
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly stderrTail: string;
  }
> {}

export class ProcessOutputLimitError extends Data.TaggedError(
  "ProcessOutputLimitError",
)<
  FailureFields<"PROCESS_OUTPUT_LIMIT"> & {
    readonly role: string;
    readonly stream: "stdout" | "stderr" | "progress";
    readonly limitBytes: number;
  }
> {}

export class WorkspaceLockedError extends Data.TaggedError(
  "WorkspaceLockedError",
)<FailureFields<"WORKSPACE_LOCKED">> {}

export class StaleWorkspaceError extends Data.TaggedError(
  "StaleWorkspaceError",
)<FailureFields<"STALE_WORKSPACE">> {}

export class WorkspaceIoError extends Data.TaggedError("WorkspaceIoError")<
  FailureFields<"WORKSPACE_IO">
> {}

export class PatchLimitExceededError extends Data.TaggedError(
  "PatchLimitExceededError",
)<
  FailureFields<"PATCH_LIMIT_EXCEEDED"> & {
    readonly patchCount: number;
    readonly patchLimit: number;
  }
> {}

export class PlaylistValidationError extends Data.TaggedError(
  "PlaylistValidationError",
)<FailureFields<"PLAYLIST_VALIDATION">> {}

export class MediaValidationError extends Data.TaggedError(
  "MediaValidationError",
)<FailureFields<"MEDIA_VALIDATION">> {}

export class ArtifactValidationError extends Data.TaggedError(
  "ArtifactValidationError",
)<FailureFields<"ARTIFACT_VALIDATION">> {}

export type NativeProcessError =
  | InvalidRequestError
  | ProcessSpawnError
  | ProcessExitError
  | ProcessOutputLimitError;
