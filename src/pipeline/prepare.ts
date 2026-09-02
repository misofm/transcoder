import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
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
import {
  AUDIO_POLICY_ID,
  FINAL_TRUE_PEAK_CENTI_DBTP,
  GAIN_QUANTUM_CENTI_DB,
  LOUDNORM_RECIPE,
  PLANNING_TRUE_PEAK_CENTI_DBTP,
  planSharedGainCentiDb,
  type DecodedAudioMeasurement,
} from "../ffmpeg/audio-meter.js";
import type { TimelineValidation } from "../ffmpeg/validate-media.js";
import {
  parsePlaintextMediaPlaylist,
  type MediaPlaylist,
} from "../hls/playlist.js";
import { assertMasterPlaylistParses } from "../hls/master.js";
import {
  RENDITIONS,
  type PreparedAudioEvidence,
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
  cleanupWorkspaceTemporaries,
  parseWorkspaceState,
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
  readonly files: readonly {
    readonly identifier: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

type PreparedCheckpointBase = Pick<
  PreparedCheckpoint,
  | "prepareDigest"
  | "rootPath"
  | "sourceSha256"
  | "durationMs"
  | "sampleRateHz"
  | "segmentTargetMs"
  | "toolchain"
  | "argvSpecification"
>;

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

const hashFile = async (
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Promise<string> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new TypeError();
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size || bytes > maximum) throw new RangeError();
      hash.update(chunk);
    }
    if (bytes !== metadata.size) throw new RangeError();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

const readBoundedFile = async (
  path: string,
  maximum: number,
): Promise<Buffer> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
      throw new RangeError("file outside bounded read limit");
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0)
        throw new RangeError("file shrank during bounded read");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw new RangeError("file grew during bounded read");
    return bytes;
  } finally {
    await handle.close();
  }
};

const sourceIdentity = (value: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): string => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`;

const plaintextIdentifiers = (
  playlists: readonly MediaPlaylist[],
): readonly string[] => [
  "master.m3u8",
  ...playlists.flatMap((playlist) => [
    playlist.lines.find((line) => line.startsWith("#EXT-X-MAP:")) === undefined
      ? ""
      : playlist.mapIdentifier,
    ...playlist.segments.map((segment) => segment.identifier),
  ]),
  ...RENDITIONS.map((rendition) => `${rendition.id}.m3u8`),
];

const collectPlaintextFiles = async (
  rootPath: string,
  playlists: readonly MediaPlaylist[],
  secureModes: boolean,
): Promise<PreparedCheckpoint["files"]> => {
  const identifiers = [...new Set(plaintextIdentifiers(playlists))].sort();
  if (identifiers.some((identifier) => identifier.length === 0))
    throw playlistFailure(rootPath, "Plaintext inventory is incomplete");
  const files = [];
  for (const identifier of identifiers) {
    const path = join(rootPath, identifier);
    const metadata = await lstat(path);
    const maximum = identifier.endsWith(".m3u8")
      ? 1_048_576
      : 256 * 1024 * 1024;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maximum
    )
      throw playlistFailure(
        identifier,
        "Plaintext output is not a regular file",
      );
    if (secureModes) await chmod(path, 0o600);
    else if ((metadata.mode & 0o777) !== 0o600)
      throw playlistFailure(
        identifier,
        "Cached plaintext permissions are not mode 0600",
      );
    files.push({
      identifier,
      bytes: metadata.size,
      sha256: await hashFile(path, maximum),
    });
  }
  return files;
};

const parsePreparedCheckpoint = (
  value: unknown,
  expected: PreparedCheckpointBase,
): PreparedCheckpoint => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "schema",
    "prepareDigest",
    "resultDigest",
    "rootPath",
    "sourceSha256",
    "durationMs",
    "sampleRateHz",
    "segmentTargetMs",
    "toolchain",
    "argvSpecification",
    "audio",
    "files",
  ].sort();
  if (
    keys.join("\0") !== expectedKeys.join("\0") ||
    record["schema"] !== "miso.transcoder-prepared/1" ||
    record["prepareDigest"] !== expected.prepareDigest ||
    record["rootPath"] !== expected.rootPath ||
    record["sourceSha256"] !== expected.sourceSha256 ||
    record["durationMs"] !== expected.durationMs ||
    record["sampleRateHz"] !== expected.sampleRateHz ||
    record["segmentTargetMs"] !== expected.segmentTargetMs ||
    JSON.stringify(record["toolchain"]) !==
      JSON.stringify(expected.toolchain) ||
    JSON.stringify(record["argvSpecification"]) !==
      JSON.stringify(expected.argvSpecification) ||
    !Array.isArray(record["files"]) ||
    !isPreparedAudioEvidence(record["audio"])
  )
    throw new TypeError();
  for (const file of record["files"]) {
    if (
      typeof file !== "object" ||
      file === null ||
      Object.keys(file).sort().join("\0") !== "bytes\0identifier\0sha256" ||
      typeof (file as Record<string, unknown>)["identifier"] !== "string" ||
      !Number.isSafeInteger((file as Record<string, unknown>)["bytes"]) ||
      !/^[0-9a-f]{64}$/u.test(
        String((file as Record<string, unknown>)["sha256"]),
      )
    )
      throw new TypeError();
  }
  if (
    record["resultDigest"] !==
    canonicalResultDigest(
      expected.prepareDigest,
      record["audio"] as PreparedAudioEvidence,
      record["files"] as PreparedCheckpoint["files"],
    )
  )
    throw new TypeError();
  return value as PreparedCheckpoint;
};

const measurementKeys = [
  "integratedLoudnessCentiLufs",
  "truePeakCentiDbtp",
  "samplePeakCentiDbfs",
] as const;

const isCentiOrNull = (value: unknown): boolean =>
  value === null ||
  (Number.isSafeInteger(value) &&
    (value as number) >= -99_900 &&
    (value as number) <= 99_900);

const isMeasurement = (value: unknown, rendition = false): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  const keys = [...measurementKeys, ...(rendition ? ["id"] : [])].sort();
  return (
    Object.keys(record).sort().join("\0") === keys.join("\0") &&
    measurementKeys.every((key) => isCentiOrNull(record[key]))
  );
};

const isPreparedAudioEvidence = (
  value: unknown,
): value is PreparedAudioEvidence => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["policyId", "appliedGainCentiDb", "source", "preview", "output"]
        .sort()
        .join("\0") ||
    record["policyId"] !== AUDIO_POLICY_ID ||
    !Number.isSafeInteger(record["appliedGainCentiDb"]) ||
    (record["appliedGainCentiDb"] as number) > 0 ||
    (record["appliedGainCentiDb"] as number) % GAIN_QUANTUM_CENTI_DB !== 0 ||
    !isMeasurement(record["source"]) ||
    !Array.isArray(record["preview"]) ||
    !Array.isArray(record["output"])
  )
    return false;
  const arraysValid = [record["preview"], record["output"]].every(
    (items) =>
      (items as unknown[]).length === RENDITIONS.length &&
      (items as unknown[]).every(
        (item, index) =>
          isMeasurement(item, true) &&
          (item as Record<string, unknown>)["id"] === RENDITIONS[index]?.id,
      ),
  );
  if (!arraysValid) return false;
  const output = record["output"] as Array<Record<string, unknown>>;
  const passesStoredPolicy = (measurement: Record<string, unknown>) =>
    (measurement["truePeakCentiDbtp"] === null ||
      (measurement["truePeakCentiDbtp"] as number) <=
        FINAL_TRUE_PEAK_CENTI_DBTP) &&
    (measurement["samplePeakCentiDbfs"] === null ||
      (measurement["samplePeakCentiDbfs"] as number) <= 0);
  if (!output.every(passesStoredPolicy)) return false;
  const gain = record["appliedGainCentiDb"] as number;
  const preview = record["preview"] as Array<Record<string, unknown>>;
  if (gain === 0)
    return (
      preview.every(passesStoredPolicy) &&
      JSON.stringify(preview) === JSON.stringify(output)
    );
  return (
    preview.some((measurement) => !passesStoredPolicy(measurement)) &&
    gain ===
      planSharedGainCentiDb(
        preview.map(
          (measurement) => measurement["truePeakCentiDbtp"] as number | null,
        ),
      )
  );
};

const canonicalPrepareDigest = (value: object): string =>
  createHash("sha256")
    .update("miso.transcoder.prepare/1\0")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex");

const canonicalResultDigest = (
  prepareDigest: string,
  audio: PreparedAudioEvidence,
  files: PreparedCheckpoint["files"],
): string =>
  createHash("sha256")
    .update("miso.transcoder.prepare-result/1\0")
    .update(`${JSON.stringify({ prepareDigest, audio, files })}\n`)
    .digest("hex");

const publicMeasurement = (measurement: DecodedAudioMeasurement) => ({
  integratedLoudnessCentiLufs: measurement.integratedLoudnessCentiLufs,
  truePeakCentiDbtp: measurement.truePeakCentiDbtp,
  samplePeakCentiDbfs: measurement.samplePeakCentiDbfs,
});

const passesFinalAudioPolicy = (
  measurement: DecodedAudioMeasurement,
): boolean =>
  (measurement.truePeakCentiDbtp === null ||
    measurement.truePeakCentiDbtp <= FINAL_TRUE_PEAK_CENTI_DBTP) &&
  measurement.exactSamplePeak <= 1;

const readWorkspacePrepareDigest = async (
  workspacePath: string,
): Promise<string | undefined> => {
  try {
    const path = join(workspacePath, "workspace.json");
    const bytes = await readBoundedFile(path, 64 * 1024);
    return parseWorkspaceState(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).prepareDigest;
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
  try {
    assertMasterPlaylistParses(
      await readBoundedFile(join(rootPath, "master.m3u8"), 1_048_576),
    );
  } catch {
    throw playlistFailure("master.m3u8", "Master playlist validation failed");
  }
  const playlists: MediaPlaylist[] = [];
  const expected = new Set(["master.m3u8"]);
  const frameMs = (AAC_FRAME_SAMPLES * 1_000) / sampleRateHz;
  for (const rendition of RENDITIONS) {
    const name = `${rendition.id}.m3u8`;
    expected.add(name);
    const playlist = parsePlaintextMediaPlaylist(
      await readBoundedFile(join(rootPath, name), 1_048_576),
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
          yield* cleanupWorkspaceTemporaries(request.workspacePath);
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
          const boundSourceMetadata = yield* Effect.tryPromise({
            try: () => lstat(request.inputPath),
            catch: () => invalid("inputPath", "Source changed during hashing"),
          });
          if (
            sourceIdentity(boundSourceMetadata) !==
            sourceIdentity(inputMetadata)
          )
            return yield* Effect.fail(
              invalid("inputPath", "Source changed during hashing"),
            );
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
          const retryArgvSpecification = buildLadderInvocation({
            ffmpegPath: request.ffmpegPath,
            inputPath: request.inputPath,
            outputDirectory: specificationRoot,
            source,
            segmentTargetMs,
            gainCentiDb: -10,
          }).args.map((argument) =>
            argument
              .replaceAll(specificationRoot, "<OUTPUT>")
              .replace("volume=-0.10dB", "volume=<GAIN_DB>dB"),
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
            retryArgvSpecification,
            audioPolicy: {
              id: AUDIO_POLICY_ID,
              meter: LOUDNORM_RECIPE,
              finalTruePeakCentiDbtp: FINAL_TRUE_PEAK_CENTI_DBTP,
              planningTruePeakCentiDbtp: PLANNING_TRUE_PEAK_CENTI_DBTP,
              gainQuantumCentiDb: GAIN_QUANTUM_CENTI_DB,
              scan: "pcm_f32le-exact-abs-finite/1",
            },
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
          const expectedCheckpoint = {
            prepareDigest,
            rootPath: target,
            sourceSha256,
            durationMs: source.durationMs,
            sampleRateHz: source.sampleRateHz,
            segmentTargetMs,
            toolchain,
            argvSpecification,
          } satisfies PreparedCheckpointBase;
          const cached = yield* Effect.tryPromise({
            try: async () => {
              try {
                return parsePreparedCheckpoint(
                  JSON.parse(
                    (
                      await readBoundedFile(
                        join(target, "prepared.json"),
                        4_194_304,
                      )
                    ).toString("utf8"),
                  ),
                  expectedCheckpoint,
                );
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
            if (request.fresh === true)
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message:
                    "Fresh preparation requires explicit cleanup of existing plaintext",
                }),
              );
            const cachedPlaylists = yield* Effect.tryPromise({
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
            const cachedFiles = yield* Effect.tryPromise({
              try: () => collectPlaintextFiles(target, cachedPlaylists, false),
              catch: () =>
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message: "Cached plaintext bytes or permissions changed",
                }),
            });
            if (JSON.stringify(cachedFiles) !== JSON.stringify(cached.files))
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message: "Cached plaintext hashes do not match checkpoint",
                }),
              );
            const cachedTimelines: TimelineValidation[] = [];
            for (const rendition of RENDITIONS) {
              cachedTimelines.push(
                yield* ffmpeg.validatePlaintextRendition(
                  request.ffmpegPath,
                  request.ffprobePath,
                  join(target, `${rendition.id}.m3u8`),
                  source.sampleRateHz,
                  source.durationMs,
                ),
              );
            }
            if (
              !cachedTimelines
                .slice(1)
                .every(
                  (timeline) =>
                    timeline.totalSamples ===
                      cachedTimelines[0]?.totalSamples &&
                    timeline.intervals.join("\0") ===
                      cachedTimelines[0]?.intervals.join("\0") &&
                    timeline.segmentIntervals.join("\0") ===
                      cachedTimelines[0]?.segmentIntervals.join("\0"),
                )
            )
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message: "Cached plaintext timeline validation failed",
                }),
              );
            const cachedSource = yield* ffmpeg.measureAudio(
              request.ffmpegPath,
              request.inputPath,
              source.sampleRateHz,
              source.durationMs,
              source,
            );
            if (
              JSON.stringify(publicMeasurement(cachedSource)) !==
              JSON.stringify(cached.audio.source)
            )
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message: "Cached source audio evidence no longer matches",
                }),
              );
            const cachedOutput = [];
            for (const rendition of RENDITIONS) {
              const measurement = yield* ffmpeg.measureAudio(
                request.ffmpegPath,
                join(target, `${rendition.id}.m3u8`),
                source.sampleRateHz,
                source.durationMs,
              );
              if (!passesFinalAudioPolicy(measurement))
                return yield* Effect.fail(
                  new StaleWorkspaceError({
                    code: "STALE_WORKSPACE",
                    phase: "workspace",
                    subject: target,
                    message: "Cached plaintext failed the audio policy",
                  }),
                );
              cachedOutput.push({
                id: rendition.id,
                ...publicMeasurement(measurement),
              });
            }
            if (
              JSON.stringify(cachedOutput) !==
              JSON.stringify(cached.audio.output)
            )
              return yield* Effect.fail(
                new StaleWorkspaceError({
                  code: "STALE_WORKSPACE",
                  phase: "workspace",
                  subject: target,
                  message:
                    "Cached audio evidence does not match decoded output",
                }),
              );
            return cached;
          }
          const temporaryPaths: string[] = [];
          const makeTemporary = () =>
            Effect.tryPromise({
              try: async () => {
                const path = join(
                  request.workspacePath,
                  `.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
                );
                await mkdir(path, { mode: 0o700 });
                temporaryPaths.push(path);
                return path;
              },
              catch: () =>
                invalid("workspace", "Temporary workspace creation failed"),
            });
          const cleanup = Effect.tryPromise({
            try: () =>
              Promise.all(
                temporaryPaths.map((path) =>
                  rm(path, { recursive: true, force: true }),
                ),
              ).then(() => undefined),
            catch: () => undefined,
          }).pipe(Effect.orDie);
          const prepared = yield* Effect.gen(function* () {
            const sourceMeasurement = yield* ffmpeg.measureAudio(
              request.ffmpegPath,
              request.inputPath,
              source.sampleRateHz,
              source.durationMs,
              source,
            );
            const inspectCandidate = (directory: string) =>
              Effect.gen(function* () {
                const playlists = yield* Effect.tryPromise({
                  try: () =>
                    validatePlaylistSet(
                      directory,
                      segmentTargetMs,
                      source.sampleRateHz,
                      false,
                    ),
                  catch: (error) =>
                    error instanceof PlaylistValidationError ||
                    error instanceof PatchLimitExceededError
                      ? error
                      : playlistFailure(
                          directory,
                          "Plaintext playlist validation failed",
                        ),
                });
                const timelines: TimelineValidation[] = [];
                const measurements: DecodedAudioMeasurement[] = [];
                for (const rendition of RENDITIONS) {
                  const playlistPath = join(directory, `${rendition.id}.m3u8`);
                  timelines.push(
                    yield* ffmpeg.validatePlaintextRendition(
                      request.ffmpegPath,
                      request.ffprobePath,
                      playlistPath,
                      source.sampleRateHz,
                      source.durationMs,
                    ),
                  );
                  measurements.push(
                    yield* ffmpeg.measureAudio(
                      request.ffmpegPath,
                      playlistPath,
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
                          timelines[0]?.intervals.join("\0") &&
                        timeline.segmentIntervals.join("\0") ===
                          timelines[0]?.segmentIntervals.join("\0"),
                    )
                )
                  return yield* Effect.fail(
                    new MediaValidationError({
                      code: "MEDIA_VALIDATION",
                      phase: "validate",
                      subject: directory,
                      message:
                        "Rendition packet timelines or total sample counts differ",
                    }),
                  );
                return { playlists, measurements };
              });

            const previewDirectory = yield* makeTemporary();
            yield* ffmpeg.encodeLadder({
              ffmpegPath: request.ffmpegPath,
              inputPath: request.inputPath,
              outputDirectory: previewDirectory,
              source,
              segmentTargetMs,
            });
            const preview = yield* inspectCandidate(previewDirectory);
            const unityPasses = preview.measurements.every(
              passesFinalAudioPolicy,
            );
            const appliedGainCentiDb = unityPasses
              ? 0
              : planSharedGainCentiDb(
                  preview.measurements.map(
                    (measurement) => measurement.truePeakCentiDbtp,
                  ),
                );
            let finalDirectory = previewDirectory;
            let finalCandidate = preview;
            if (!unityPasses) {
              finalDirectory = yield* makeTemporary();
              yield* ffmpeg.encodeLadder({
                ffmpegPath: request.ffmpegPath,
                inputPath: request.inputPath,
                outputDirectory: finalDirectory,
                source,
                segmentTargetMs,
                gainCentiDb: appliedGainCentiDb,
              });
              finalCandidate = yield* inspectCandidate(finalDirectory);
              if (!finalCandidate.measurements.every(passesFinalAudioPolicy))
                return yield* Effect.fail(
                  new MediaValidationError({
                    code: "MEDIA_VALIDATION",
                    phase: "validate",
                    subject: finalDirectory,
                    message:
                      "Second-pass AAC ladder exceeds the final true-peak or decoded sample ceiling",
                  }),
                );
              yield* Effect.tryPromise({
                try: () =>
                  rm(previewDirectory, { recursive: true, force: true }),
                catch: () => invalid("workspace", "Preview cleanup failed"),
              });
            }
            const finalSource = yield* Effect.tryPromise({
              try: async () => ({
                metadata: await lstat(request.inputPath),
                sha256: await hashFile(request.inputPath),
              }),
              catch: () =>
                invalid("inputPath", "Source changed during encoding"),
            });
            if (
              sourceIdentity(finalSource.metadata) !==
                sourceIdentity(boundSourceMetadata) ||
              finalSource.sha256 !== sourceSha256
            )
              return yield* Effect.fail(
                invalid("inputPath", "Source changed during encoding"),
              );
            const files = yield* Effect.tryPromise({
              try: () =>
                collectPlaintextFiles(
                  finalDirectory,
                  finalCandidate.playlists,
                  true,
                ),
              catch: (error) =>
                error instanceof PlaylistValidationError
                  ? error
                  : playlistFailure(
                      finalDirectory,
                      "Plaintext inventory hashing failed",
                    ),
            });
            const audio: PreparedAudioEvidence = {
              policyId: AUDIO_POLICY_ID,
              appliedGainCentiDb,
              source: publicMeasurement(sourceMeasurement),
              preview: preview.measurements.map((measurement, index) => ({
                id: RENDITIONS[index]!.id,
                ...publicMeasurement(measurement),
              })),
              output: finalCandidate.measurements.map((measurement, index) => ({
                id: RENDITIONS[index]!.id,
                ...publicMeasurement(measurement),
              })),
            };
            const resultDigest = canonicalResultDigest(
              prepareDigest,
              audio,
              files,
            );
            const value: PreparedCheckpoint = {
              schema: "miso.transcoder-prepared/1",
              prepareDigest,
              resultDigest,
              rootPath: target,
              sourceSha256,
              durationMs: source.durationMs,
              sampleRateHz: source.sampleRateHz,
              segmentTargetMs,
              toolchain,
              argvSpecification,
              audio,
              files,
            };
            yield* atomicWriteFile(
              join(finalDirectory, "prepared.json"),
              `${JSON.stringify(value, null, 2)}\n`,
            );
            yield* promoteWorkspaceDirectory(finalDirectory, target);
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

export const verifyPreparedTranscode = (
  prepared: PreparedTranscode,
): Effect.Effect<PreparedTranscode, PrepareError, Ffmpeg> =>
  Effect.gen(function* () {
    const ffmpeg = yield* Ffmpeg;
    const checkpoint = yield* Effect.tryPromise({
      try: async () => {
        const value: unknown = JSON.parse(
          (
            await readBoundedFile(
              join(prepared.rootPath, "prepared.json"),
              4_194_304,
            )
          ).toString("utf8"),
        );
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new TypeError();
        const raw = value as Record<string, unknown>;
        if (!Array.isArray(raw["argvSpecification"])) throw new TypeError();
        return parsePreparedCheckpoint(value, {
          prepareDigest: prepared.prepareDigest,
          rootPath: prepared.rootPath,
          sourceSha256: prepared.sourceSha256,
          durationMs: prepared.durationMs,
          sampleRateHz: prepared.sampleRateHz,
          segmentTargetMs: prepared.segmentTargetMs,
          toolchain: prepared.toolchain,
          argvSpecification: raw["argvSpecification"] as readonly string[],
        });
      },
      catch: () =>
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message: "Prepared checkpoint is missing, invalid, or mismatched",
        }),
    });
    if (
      checkpoint.resultDigest !== prepared.resultDigest ||
      JSON.stringify(checkpoint.audio) !== JSON.stringify(prepared.audio)
    )
      return yield* Effect.fail(
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message: "Prepared audio evidence or result identity mismatched",
        }),
      );
    const playlists = yield* Effect.tryPromise({
      try: () =>
        validatePlaylistSet(
          prepared.rootPath,
          prepared.segmentTargetMs,
          prepared.sampleRateHz,
          true,
        ),
      catch: () =>
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message: "Prepared playlists failed revalidation",
        }),
    });
    const files = yield* Effect.tryPromise({
      try: () => collectPlaintextFiles(prepared.rootPath, playlists, false),
      catch: () =>
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message: "Prepared bytes or permissions changed",
        }),
    });
    if (JSON.stringify(files) !== JSON.stringify(checkpoint.files))
      return yield* Effect.fail(
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message: "Prepared file hashes do not match checkpoint",
        }),
      );
    const timelines: TimelineValidation[] = [];
    for (const rendition of RENDITIONS) {
      timelines.push(
        yield* ffmpeg.validatePlaintextRendition(
          prepared.toolchain.ffmpegPath,
          prepared.toolchain.ffprobePath,
          join(prepared.rootPath, `${rendition.id}.m3u8`),
          prepared.sampleRateHz,
          prepared.durationMs,
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
              timelines[0]?.intervals.join("\0") &&
            timeline.segmentIntervals.join("\0") ===
              timelines[0]?.segmentIntervals.join("\0"),
        )
    )
      return yield* Effect.fail(
        new MediaValidationError({
          code: "MEDIA_VALIDATION",
          phase: "validate",
          subject: prepared.rootPath,
          message: "Prepared rendition timelines differ",
        }),
      );
    const output = [];
    for (const rendition of RENDITIONS) {
      const measurement = yield* ffmpeg.measureAudio(
        prepared.toolchain.ffmpegPath,
        join(prepared.rootPath, `${rendition.id}.m3u8`),
        prepared.sampleRateHz,
        prepared.durationMs,
      );
      if (!passesFinalAudioPolicy(measurement))
        return yield* Effect.fail(
          new MediaValidationError({
            code: "MEDIA_VALIDATION",
            phase: "validate",
            subject: prepared.rootPath,
            message: "Prepared output fails the audio policy",
          }),
        );
      output.push({ id: rendition.id, ...publicMeasurement(measurement) });
    }
    if (JSON.stringify(output) !== JSON.stringify(checkpoint.audio.output))
      return yield* Effect.fail(
        new StaleWorkspaceError({
          code: "STALE_WORKSPACE",
          phase: "workspace",
          subject: prepared.rootPath,
          message:
            "Prepared decoded measurements differ from checkpoint evidence",
        }),
      );
    return prepared;
  });
