import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import {
  InvalidRequestError,
  MediaValidationError,
  PatchLimitExceededError,
  PlaylistValidationError,
  StaleWorkspaceError,
  type NativeProcessError,
  type ToolNotFoundError,
  type ToolchainCapabilityError,
  type UnsupportedSourceError,
  type WorkspaceIoError,
  type WorkspaceLockedError,
} from "../errors.js";
import { Ffmpeg } from "../ffmpeg/service.js";
import { buildLadderInvocation } from "../ffmpeg/invocation.js";
import type { TimelineValidation } from "../ffmpeg/validate-media.js";
import {
  parsePlaintextMediaPlaylist,
  type MediaPlaylist,
} from "../hls/playlist.js";
import {
  RENDITIONS,
  type PrepareRequest,
  type PreparedTranscode,
} from "../model.js";
import {
  AAC_FRAME_SAMPLES,
  MAX_PATCHES,
  chooseSegmentTargetMs,
  patchCountForSegments,
} from "../profile.js";
import { atomicWriteFile } from "../workspace/atomic-file.js";
import { withWorkspaceLock } from "../workspace/lock.js";
import {
  initializeWorkspace,
  promoteWorkspaceDirectory,
  writeWorkspaceState,
} from "../workspace/state.js";

export type PrepareError =
  | InvalidRequestError
  | UnsupportedSourceError
  | ToolNotFoundError
  | ToolchainCapabilityError
  | NativeProcessError
  | WorkspaceLockedError
  | StaleWorkspaceError
  | WorkspaceIoError
  | PatchLimitExceededError
  | PlaylistValidationError
  | MediaValidationError;

interface PreparedCheckpoint extends PreparedTranscode {
  readonly schema: "miso.transcoder-prepared/1";
  readonly argvSpecification: readonly string[];
}

const invalid = (subject: string, message: string) =>
  new InvalidRequestError({
    code: "INVALID_REQUEST",
    phase: "request",
    subject,
    message,
  });
const playlistFailure = (subject: string, message: string) =>
  new PlaylistValidationError({
    code: "PLAYLIST_VALIDATION",
    phase: "validate",
    subject,
    message,
  });

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const canonicalPrepareDigest = (value: object): string =>
  createHash("sha256")
    .update("miso.transcoder.prepare/1\0")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex");

const readWorkspacePrepareDigest = async (
  workspacePath: string,
): Promise<string | undefined> => {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(workspacePath, "workspace.json"), "utf8"),
    );
    if (typeof value !== "object" || value === null) throw new TypeError();
    const digest = (value as Record<string, unknown>)["prepareDigest"];
    return typeof digest === "string" ? digest : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new StaleWorkspaceError({
      code: "STALE_WORKSPACE",
      phase: "workspace",
      subject: workspacePath,
      message: "Workspace checkpoint is invalid",
    });
  }
};

const validatePlaylistSet = async (
  rootPath: string,
  segmentTargetMs: number,
  sampleRateHz: 44_100 | 48_000,
  allowCheckpoint: boolean,
): Promise<readonly MediaPlaylist[]> => {
  const playlists: MediaPlaylist[] = [];
  const expected = new Set(["master.m3u8"]);
  const frameMs = (AAC_FRAME_SAMPLES * 1_000) / sampleRateHz;
  for (const rendition of RENDITIONS) {
    const name = `${rendition.id}.m3u8`;
    expected.add(name);
    const playlist = parsePlaintextMediaPlaylist(
      await readFile(join(rootPath, name)),
    );
    if (playlist.mapIdentifier !== `${rendition.id}-init.mp4`)
      throw playlistFailure(name, "Unexpected init identifier");
    expected.add(playlist.mapIdentifier);
    for (const [position, segment] of playlist.segments.entries()) {
      if (
        segment.identifier !==
        `${rendition.id}-${String(position).padStart(5, "0")}.m4s`
      )
        throw playlistFailure(name, "Non-canonical segment identifier");
      if (
        position < playlist.segments.length - 1 &&
        Math.abs(segment.durationMs - segmentTargetMs) > Math.ceil(frameMs)
      ) {
        throw playlistFailure(
          name,
          "Non-final segment is outside one AAC frame of target",
        );
      }
      if (
        position === playlist.segments.length - 1 &&
        segment.durationMs >
          Math.min(10_000, segmentTargetMs + Math.ceil(frameMs))
      ) {
        throw playlistFailure(
          name,
          "Final segment exceeds the representable target tolerance",
        );
      }
      expected.add(segment.identifier);
    }
    playlists.push(playlist);
  }
  const counts = playlists.map((playlist) => playlist.segments.length);
  if (!counts.every((count) => count === counts[0]))
    throw playlistFailure(rootPath, "Rendition segment counts differ");
  const patchCount = patchCountForSegments(counts[0] ?? 0);
  if (patchCount > MAX_PATCHES)
    throw new PatchLimitExceededError({
      code: "PATCH_LIMIT_EXCEEDED",
      phase: "validate",
      subject: rootPath,
      message: "Encoded ladder exceeds the Quilt v1 patch ceiling",
      patchCount,
      patchLimit: MAX_PATCHES,
    });
  for (let sequence = 0; sequence < (counts[0] ?? 0); sequence += 1) {
    const durations = playlists.map(
      (playlist) => playlist.segments[sequence]?.durationMs,
    );
    if (!durations.every((duration) => duration === durations[0]))
      throw playlistFailure(
        rootPath,
        "Rendition segment durations are not aligned",
      );
  }
  if (allowCheckpoint) expected.add("prepared.json");
  const actual = await readdir(rootPath);
  if (
    actual.length !== expected.size ||
    actual.some((identifier) => !expected.has(identifier))
  )
    throw playlistFailure(
      rootPath,
      "Plaintext directory contains missing or unknown files",
    );
  return playlists;
};

export const prepareTranscode = (
  request: PrepareRequest,
): Effect.Effect<PreparedTranscode, PrepareError, Ffmpeg> =>
  Effect.gen(function* () {
    if (
      ![
        request.inputPath,
        request.workspacePath,
        request.ffmpegPath,
        request.ffprobePath,
      ].every(isAbsolute)
    ) {
      return yield* Effect.fail(
        invalid(
          "prepare",
          "Input, workspace, FFmpeg, and FFprobe paths must be absolute",
        ),
      );
    }
    const inputMetadata = yield* Effect.tryPromise({
      try: () => lstat(request.inputPath),
      catch: () => invalid("inputPath", "Source inspection failed"),
    });
    if (!inputMetadata.isFile() || inputMetadata.isSymbolicLink())
      return yield* Effect.fail(
        invalid(
          "inputPath",
          "Source must be a non-symlinked regular local file",
        ),
      );
    yield* initializeWorkspace(request.workspacePath);
    return yield* withWorkspaceLock(
      request.workspacePath,
      "prepare",
      () =>
        Effect.gen(function* () {
          const ffmpeg = yield* Ffmpeg;
          const toolchain = yield* ffmpeg.inspectToolchain(
            request.ffmpegPath,
            request.ffprobePath,
          );
          const source = yield* ffmpeg.probeSource(
            request.ffprobePath,
            request.inputPath,
          );
          const minimumTarget = chooseSegmentTargetMs(source.durationMs);
          if (minimumTarget === undefined)
            return yield* Effect.fail(
              new PatchLimitExceededError({
                code: "PATCH_LIMIT_EXCEEDED",
                phase: "prepare",
                subject: request.inputPath,
                message: "Source cannot fit one AAC Quilt v1 artifact",
                patchCount: MAX_PATCHES + 1,
                patchLimit: MAX_PATCHES,
              }),
            );
          const segmentTargetMs =
            request.profile?.segmentTargetMs ?? minimumTarget;
          if (
            !Number.isSafeInteger(segmentTargetMs) ||
            segmentTargetMs < minimumTarget ||
            segmentTargetMs > 10_000
          ) {
            return yield* Effect.fail(
              invalid(
                "segmentTargetMs",
                "Configured target is outside the safe 6000-10000 ms range",
              ),
            );
          }
          const sourceSha256 = yield* Effect.tryPromise({
            try: () => hashFile(request.inputPath),
            catch: () => invalid("inputPath", "Source hashing failed"),
          });
          const specificationRoot = join(request.workspacePath, ".tmp-OUTPUT");
          const specification = buildLadderInvocation({
            ffmpegPath: request.ffmpegPath,
            inputPath: request.inputPath,
            outputDirectory: specificationRoot,
            source,
            segmentTargetMs,
          });
          const argvSpecification = specification.args.map((argument) =>
            argument.replaceAll(specificationRoot, "<OUTPUT>"),
          );
          const prepareDigest = canonicalPrepareDigest({
            sourceSha256,
            profile: { segmentTargetMs, renditions: RENDITIONS },
            selectedStream: "0:a:0",
            source: {
              sampleRateHz: source.sampleRateHz,
              channels: source.channels,
              durationMs: source.durationMs,
            },
            toolchain,
            argvSpecification,
          });
          const priorDigest = yield* Effect.tryPromise({
            try: () => readWorkspacePrepareDigest(request.workspacePath),
            catch: (error) => error as StaleWorkspaceError,
          });
          if (
            priorDigest !== undefined &&
            priorDigest !== prepareDigest &&
            request.fresh !== true
          ) {
            return yield* Effect.fail(
              new StaleWorkspaceError({
                code: "STALE_WORKSPACE",
                phase: "workspace",
                subject: request.workspacePath,
                message:
                  "Source, profile, or toolchain differs from the workspace checkpoint; explicit fresh mode is required",
              }),
            );
          }
          const target = join(
            request.workspacePath,
            "plaintext",
            prepareDigest,
          );
          const cached = yield* Effect.tryPromise({
            try: async () => {
              try {
                return JSON.parse(
                  await readFile(join(target, "prepared.json"), "utf8"),
                ) as PreparedCheckpoint;
              } catch (error) {
                if (
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
                  return undefined;
                throw error;
              }
            },
            catch: () =>
              new StaleWorkspaceError({
                code: "STALE_WORKSPACE",
                phase: "workspace",
                subject: target,
                message: "Cached plaintext checkpoint is invalid",
              }),
          });
          if (cached !== undefined) {
            if (
              cached.prepareDigest !== prepareDigest ||
              cached.sourceSha256 !== sourceSha256 ||
              cached.toolchain.sha256 !== toolchain.sha256
            ) {
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message:
                    "Cached plaintext checkpoint does not match this request",
                }),
              );
            }
            yield* Effect.tryPromise({
              try: () =>
                validatePlaylistSet(
                  target,
                  segmentTargetMs,
                  source.sampleRateHz,
                  true,
                ),
              catch: () =>
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message: "Cached plaintext failed validation",
                }),
            });
            return cached;
          }
          const temporary = join(
            request.workspacePath,
            `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
          );
          yield* Effect.tryPromise({
            try: () => mkdir(temporary, { mode: 0o700 }),
            catch: () =>
              invalid("workspace", "Temporary workspace creation failed"),
          });
          const cleanup = Effect.tryPromise({
            try: () => rm(temporary, { recursive: true, force: true }),
            catch: () => undefined,
          }).pipe(Effect.orDie);
          const prepared = yield* Effect.gen(function* () {
            yield* ffmpeg.encodeLadder({
              ffmpegPath: request.ffmpegPath,
              inputPath: request.inputPath,
              outputDirectory: temporary,
              source,
              segmentTargetMs,
            });
            const playlists = yield* Effect.tryPromise({
              try: () =>
                validatePlaylistSet(
                  temporary,
                  segmentTargetMs,
                  source.sampleRateHz,
                  false,
                ),
              catch: (error) =>
                error instanceof PlaylistValidationError ||
                error instanceof PatchLimitExceededError
                  ? error
                  : playlistFailure(
                      temporary,
                      "Plaintext playlist validation failed",
                    ),
            });
            const timelines: TimelineValidation[] = [];
            for (const rendition of RENDITIONS) {
              timelines.push(
                yield* ffmpeg.validatePlaintextRendition(
                  request.ffmpegPath,
                  request.ffprobePath,
                  join(temporary, `${rendition.id}.m3u8`),
                  source.sampleRateHz,
                  source.durationMs,
                ),
              );
            }
            if (
              !timelines
                .slice(1)
                .every(
                  (timeline) =>
                    timeline.totalSamples === timelines[0]?.totalSamples &&
                    timeline.intervals.join("\0") ===
                      timelines[0]?.intervals.join("\0"),
                )
            ) {
              return yield* Effect.fail(
                new MediaValidationError({
                  code: "MEDIA_VALIDATION",
                  phase: "validate",
                  subject: temporary,
                  message:
                    "Rendition packet timelines or total sample counts differ",
                }),
              );
            }
            if (
              !playlists
                .slice(1)
                .every(
                  (playlist) =>
                    playlist.segments.length === playlists[0]?.segments.length,
                )
            )
              return yield* Effect.fail(
                playlistFailure(temporary, "Renditions are not aligned"),
              );
            const value: PreparedCheckpoint = {
              schema: "miso.transcoder-prepared/1",
              prepareDigest,
              rootPath: target,
              sourceSha256,
              durationMs: source.durationMs,
              sampleRateHz: source.sampleRateHz,
              segmentTargetMs,
              toolchain,
              argvSpecification,
            };
            yield* atomicWriteFile(
              join(temporary, "prepared.json"),
              `${JSON.stringify(value, null, 2)}\n`,
            );
            yield* promoteWorkspaceDirectory(temporary, target);
            yield* writeWorkspaceState(request.workspacePath, {
              schema: "miso.transcoder-workspace/1",
              prepareDigest,
            });
            return value;
          }).pipe(Effect.onError(() => cleanup));
          return prepared;
        }),
      request.recoverStaleLock === undefined
        ? {}
        : { recoverStaleLock: request.recoverStaleLock },
    );
  });
