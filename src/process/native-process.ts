import { Context, type Effect } from "effect";

import type { NativeProcessError } from "../errors.js";

export const DEFAULT_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_STDERR_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_PROGRESS_LIMIT_BYTES = 256 * 1024;
export const MAX_PROCESS_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export interface NativeProcessRequest {
  readonly role: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly progressLimitBytes?: number;
  /**
   * Receives stdout while it is drained. The callback must be synchronous and
   * must not retain the provided view. It is intended for bounded streaming
   * validation such as scanning decoded PCM.
   */
  readonly onStdoutChunk?: (chunk: Uint8Array) => void;
  readonly retainStdout?: boolean;
}

export interface NativeProcessResult {
  readonly exitCode: 0;
  readonly signal: null;
  readonly stdout: Uint8Array;
  readonly stderrTail: Uint8Array;
  readonly progressTail: Uint8Array;
  readonly stderrTruncated: boolean;
  readonly progressTruncated: boolean;
}

export interface NativeProcessService {
  readonly run: (
    request: NativeProcessRequest,
  ) => Effect.Effect<NativeProcessResult, NativeProcessError>;
}

/**
 * Internal boundary for all native child-process behavior. Unstable Effect
 * process imports, if adopted in a future matching-version upgrade, belong in
 * this module and nowhere else in the package.
 *
 * @internal
 */
export class NativeProcess extends Context.Service<
  NativeProcess,
  NativeProcessService
>()("@misofm/transcoder/internal/NativeProcess") {}
