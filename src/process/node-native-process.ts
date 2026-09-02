import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

import { Effect, Layer } from "effect";

import {
  InvalidRequestError,
  ProcessExitError,
  ProcessOutputLimitError,
  ProcessSpawnError,
  type NativeProcessError,
} from "../errors.js";
import {
  DEFAULT_PROGRESS_LIMIT_BYTES,
  DEFAULT_STDERR_LIMIT_BYTES,
  DEFAULT_STDOUT_LIMIT_BYTES,
  MAX_PROCESS_OUTPUT_LIMIT_BYTES,
  NativeProcess,
  type NativeProcessRequest,
  type NativeProcessResult,
  type NativeProcessService,
} from "./native-process.js";

type Spawn = (
  file: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface NodeNativeProcessOptions {
  readonly forceKillAfterMs?: number;
  /** @internal Test seam; production layers always use node:child_process.spawn. */
  readonly spawn?: Spawn;
}

interface TailBuffer {
  readonly bytes: () => Uint8Array;
  readonly append: (chunk: Uint8Array) => void;
  readonly truncated: () => boolean;
}

const makeTailBuffer = (limit: number): TailBuffer => {
  let value = Buffer.alloc(0);
  let didTruncate = false;
  return {
    append(chunk) {
      if (chunk.byteLength >= limit) {
        const discarded = value.byteLength > 0 || chunk.byteLength > limit;
        value = Buffer.from(chunk.subarray(chunk.byteLength - limit));
        didTruncate = didTruncate || discarded;
        return;
      }
      const overflow = value.byteLength + chunk.byteLength - limit;
      if (overflow > 0) {
        value = Buffer.concat([value.subarray(overflow), chunk], limit);
        didTruncate = true;
      } else {
        value = Buffer.concat([value, chunk]);
      }
    },
    bytes: () => Uint8Array.from(value),
    truncated: () => didTruncate,
  };
};

const safeReason = (error: unknown): string => {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UnknownError";
};

const validLimit = (value: number): boolean =>
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= MAX_PROCESS_OUTPUT_LIMIT_BYTES;

const invalidRequest = (
  subject: string,
  message: string,
): InvalidRequestError =>
  new InvalidRequestError({
    code: "INVALID_REQUEST",
    phase: "request",
    subject,
    message,
  });

const validateRequest = (
  request: NativeProcessRequest,
):
  | InvalidRequestError
  | {
      readonly stdout: number;
      readonly stderr: number;
      readonly progress: number;
    } => {
  if (!isAbsolute(request.executable)) {
    return invalidRequest(
      request.role,
      "Native executable path must be absolute",
    );
  }
  if (request.cwd !== undefined && !isAbsolute(request.cwd)) {
    return invalidRequest(
      request.role,
      "Native process working directory must be absolute",
    );
  }
  if (request.args.some((arg) => arg.includes("\0"))) {
    return invalidRequest(
      request.role,
      "Native process arguments must not contain NUL bytes",
    );
  }
  const stdout = request.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT_BYTES;
  const stderr = request.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
  const progress = request.progressLimitBytes ?? DEFAULT_PROGRESS_LIMIT_BYTES;
  if (!validLimit(stdout) || !validLimit(stderr) || !validLimit(progress)) {
    return invalidRequest(
      request.role,
      "Native process output limits are outside the supported range",
    );
  }
  return { stdout, stderr, progress };
};

const terminate = (
  child: ChildProcess,
  forceKillAfterMs: number,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }

    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
      resume(Effect.void);
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, forceKillAfterMs);
    const giveUpTimer = setTimeout(finish, forceKillAfterMs * 2 + 100);
    child.once("exit", finish);
    child.once("error", finish);
    child.kill("SIGTERM");
  });

const bytes = (chunk: Buffer | string): Uint8Array =>
  typeof chunk === "string" ? Buffer.from(chunk) : chunk;

export const makeNodeNativeProcess = (
  options: NodeNativeProcessOptions = {},
): NativeProcessService => {
  const spawn = options.spawn ?? nodeSpawn;
  const forceKillAfterMs = options.forceKillAfterMs ?? 2_000;

  return {
    run: (request) => {
      const limits = validateRequest(request);
      if (limits instanceof InvalidRequestError) return Effect.fail(limits);

      return Effect.callback<NativeProcessResult, NativeProcessError>(
        (resume) => {
          let child: ChildProcess;
          let completed = false;
          let stdoutBytes = 0;
          const stdoutChunks: Array<Uint8Array> = [];
          const stderr = makeTailBuffer(limits.stderr);
          const progress = makeTailBuffer(limits.progress);
          let outputFailure:
            | ProcessOutputLimitError
            | ProcessSpawnError
            | undefined;

          const finish = (
            effect: Effect.Effect<NativeProcessResult, NativeProcessError>,
          ) => {
            if (completed) return;
            completed = true;
            resume(effect);
          };

          try {
            child = spawn(request.executable, request.args, {
              shell: false,
              detached: false,
              stdio: ["ignore", "pipe", "pipe", "pipe"],
              ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            });
          } catch (error) {
            finish(
              Effect.fail(
                new ProcessSpawnError({
                  code: "PROCESS_SPAWN",
                  phase: "process",
                  subject: request.role,
                  message: "Failed to start native process",
                  role: request.role,
                  reason: safeReason(error),
                }),
              ),
            );
            return;
          }

          const failOutput = (
            stream: "stdout" | "stderr" | "progress",
            limitBytes: number,
          ) => {
            outputFailure ??= new ProcessOutputLimitError({
              code: "PROCESS_OUTPUT_LIMIT",
              phase: "process",
              subject: request.role,
              message: `Native process ${stream} exceeded its configured byte limit`,
              role: request.role,
              stream,
              limitBytes,
            });
            child.kill("SIGTERM");
          };

          child.stdout?.on("data", (chunk: Buffer | string) => {
            const view = bytes(chunk);
            if (request.retainStdout !== false) {
              stdoutBytes += view.byteLength;
              if (stdoutBytes > limits.stdout) {
                failOutput("stdout", limits.stdout);
                return;
              }
            }
            try {
              request.onStdoutChunk?.(view);
              if (request.retainStdout !== false)
                stdoutChunks.push(Uint8Array.from(view));
            } catch (error) {
              outputFailure = new ProcessSpawnError({
                code: "PROCESS_SPAWN",
                phase: "process",
                subject: request.role,
                message: "Native process output consumer failed",
                role: request.role,
                reason: safeReason(error),
              });
              child.kill("SIGTERM");
            }
          });

          child.stderr?.on("data", (chunk: Buffer | string) =>
            stderr.append(bytes(chunk)),
          );

          const progressStream = child.stdio[3] as Readable | null | undefined;
          progressStream?.on("data", (chunk: Buffer | string) =>
            progress.append(bytes(chunk)),
          );

          child.once("error", (error) => {
            finish(
              Effect.fail(
                new ProcessSpawnError({
                  code: "PROCESS_SPAWN",
                  phase: "process",
                  subject: request.role,
                  message: "Failed to start native process",
                  role: request.role,
                  reason: safeReason(error),
                }),
              ),
            );
          });

          child.once("close", (exitCode, signal) => {
            if (outputFailure !== undefined) {
              finish(Effect.fail(outputFailure));
              return;
            }
            if (exitCode !== 0 || signal !== null) {
              finish(
                Effect.fail(
                  new ProcessExitError({
                    code: "PROCESS_EXIT",
                    phase: "process",
                    subject: request.role,
                    message: "Native process exited unsuccessfully",
                    role: request.role,
                    exitCode,
                    signal,
                    stderrTail: new TextDecoder().decode(stderr.bytes()),
                  }),
                ),
              );
              return;
            }
            finish(
              Effect.succeed({
                exitCode: 0,
                signal: null,
                stdout: Buffer.concat(stdoutChunks),
                stderrTail: stderr.bytes(),
                progressTail: progress.bytes(),
                stderrTruncated: stderr.truncated(),
                progressTruncated: progress.truncated(),
              }),
            );
          });

          return terminate(child, forceKillAfterMs);
        },
      );
    },
  };
};

export const NodeNativeProcessLive = Layer.succeed(
  NativeProcess,
  makeNodeNativeProcess(),
);
