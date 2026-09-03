import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect } from "effect";

import { ArtifactValidationError, WorkspaceIoError } from "../errors.js";
import { calculateBandwidth } from "../hls/bandwidth.js";
import { renderMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import {
  RENDITIONS,
  type FileDescriptor,
  type FinalizeRequest,
  type RenditionDescriptor,
  type SegmentDescriptor,
  type TranscodeArtifact,
} from "../model.js";
import {
  assertNoSymlinkComponentsPromise,
  atomicWriteFilePromise,
} from "../workspace/atomic-file.js";
import { promoteWorkspaceDirectory } from "../workspace/state.js";
import { verifyArtifact } from "./verify.js";

const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_CONCURRENCY = 16;
const PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl" as const;
const AUDIO_CONTENT_TYPE = "audio/mp4" as const;

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted)
    throw new DOMException("Operation interrupted", "AbortError");
};

const failure = (subject: string, message: string) =>
  new ArtifactValidationError({
    code: "ARTIFACT_VALIDATION",
    phase: "finalize",
    subject,
    message,
  });

const removeTree = async (path: string): Promise<void> => {
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await removeTree(child);
      else await unlink(child);
    }
    await rmdir(path);
  } catch {
    /* cleanup must not hide the original failure */
  }
};

const inspectAndHash = async (
  path: string,
): Promise<{ bytes: number; sha256: string }> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > MAX_ARTIFACT_FILE_BYTES
    )
      throw new RangeError("artifact file outside bounds");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size)
        throw new RangeError("artifact file grew while hashing");
      hash.update(chunk);
    }
    if (bytes !== metadata.size)
      throw new RangeError("artifact file changed while hashing");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};

const readBounded = async (
  path: string,
  ceiling: number,
): Promise<Uint8Array> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > ceiling)
      throw new RangeError("file outside bounds");
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (result.bytesRead === 0)
        throw new RangeError("file changed during read");
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

export type FileCopyTransition = "file-fsync" | "rename" | "parent-fsync";

/** @internal Exported only for durable-transition fault injection. */
export const copyFileAtomic = async (
  sourcePath: string,
  destinationPath: string,
  signal: AbortSignal,
  hooks: {
    readonly afterTransition?: (
      transition: FileCopyTransition,
    ) => void | Promise<void>;
    readonly afterChunk?: (copiedBytes: number) => void | Promise<void>;
  } = {},
): Promise<{ readonly bytes: number; readonly sha256: string }> => {
  throwIfAborted(signal);
  const input = await open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const metadata = await input.stat();
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_ARTIFACT_FILE_BYTES
  ) {
    await input.close();
    throw new RangeError("source size outside supported bounds");
  }
  const temporary = `${destinationPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let copiedBytes = 0;
  try {
    output = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copiedBytes += bytesRead;
      if (copiedBytes > metadata.size)
        throw new RangeError("source grew during copy");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(
          buffer,
          written,
          bytesRead - written,
          null,
        );
        if (result.bytesWritten === 0) throw new RangeError("short write");
        written += result.bytesWritten;
      }
      await hooks.afterChunk?.(copiedBytes);
    }
    if (copiedBytes !== metadata.size)
      throw new RangeError("source shrank during copy");
    await output.sync();
    await hooks.afterTransition?.("file-fsync");
  } catch (error) {
    await output?.close().catch(() => undefined);
    await input.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await input.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
  }
  try {
    const copied = { bytes: copiedBytes, sha256: hash.digest("hex") };
    const current = await inspectAndHash(sourcePath);
    if (current.bytes !== copied.bytes || current.sha256 !== copied.sha256)
      throw new Error("source changed during copy");
    throwIfAborted(signal);
    await rename(temporary, destinationPath);
    await hooks.afterTransition?.("rename");
    const parent = await open(join(destinationPath, ".."), constants.O_RDONLY);
    try {
      await parent.sync();
      await hooks.afterTransition?.("parent-fsync");
    } finally {
      await parent.close();
    }
    return copied;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const descriptor = (
  rootPath: string,
  identifier: string,
  measured: { bytes: number; sha256: string },
): FileDescriptor => ({
  identifier,
  path: join(rootPath, identifier),
  contentType: identifier.endsWith(".m3u8")
    ? PLAYLIST_CONTENT_TYPE
    : AUDIO_CONTENT_TYPE,
  ...measured,
});

const buildArtifact = async (
  rootPath: string,
  transcodeDigest: string,
  request: FinalizeRequest,
): Promise<TranscodeArtifact> => {
  const renditions: RenditionDescriptor[] = [];
  for (const rendition of RENDITIONS) {
    const playlistIdentifier = `${rendition.id}.m3u8`;
    const parsed = parsePlaintextMediaPlaylist(
      await readBounded(join(rootPath, playlistIdentifier), 1_048_576),
    );
    const playlist = descriptor(
      rootPath,
      playlistIdentifier,
      await inspectAndHash(join(rootPath, playlistIdentifier)),
    );
    const init = descriptor(
      rootPath,
      parsed.mapIdentifier,
      await inspectAndHash(join(rootPath, parsed.mapIdentifier)),
    );
    const segments: SegmentDescriptor[] = [];
    for (const segment of parsed.segments) {
      segments.push({
        ...descriptor(
          rootPath,
          segment.identifier,
          await inspectAndHash(join(rootPath, segment.identifier)),
        ),
        contentType: AUDIO_CONTENT_TYPE,
        sequence: segment.sequence,
        durationMs: segment.durationMs,
      });
    }
    renditions.push({
      id: rendition.id,
      codec: "mp4a.40.2",
      nominalBitrate: rendition.nominalBitrate,
      ...calculateBandwidth(segments),
      sampleRateHz: request.prepared.sampleRateHz,
      channels: 2,
      playlist,
      init,
      segments,
    });
  }
  const masterPlaylist = descriptor(
    rootPath,
    "master.m3u8",
    await inspectAndHash(join(rootPath, "master.m3u8")),
  );
  const files = [
    masterPlaylist,
    ...renditions.flatMap((item) => [
      item.playlist,
      item.init,
      ...item.segments,
    ]),
  ];
  return {
    transcodeDigest,
    rootPath,
    segmentTargetMs: request.prepared.segmentTargetMs,
    masterPlaylist,
    files,
    renditions,
    toolchain: request.prepared.toolchain,
    audio: request.prepared.audio,
  };
};

const transcodeIdentity = async (request: FinalizeRequest): Promise<string> => {
  const hash = createHash("sha256");
  hash.update("miso.transcoder.hls-artifact/1\0");
  hash.update(request.prepared.resultDigest);
  for (const rendition of RENDITIONS) {
    const parsed = parsePlaintextMediaPlaylist(
      await readBounded(
        join(request.prepared.rootPath, `${rendition.id}.m3u8`),
        1_048_576,
      ),
    );
    for (const identifier of [
      `${rendition.id}.m3u8`,
      parsed.mapIdentifier,
      ...parsed.segments.map((item) => item.identifier),
    ]) {
      const value = await inspectAndHash(
        join(request.prepared.rootPath, identifier),
      );
      hash.update(`\0${identifier}\0${value.bytes}\0${value.sha256}`);
    }
  }
  return hash.digest("hex");
};

const finalizeUnsafe = async (
  request: FinalizeRequest,
  concurrency: number,
  signal: AbortSignal,
): Promise<TranscodeArtifact> => {
  throwIfAborted(signal);
  const transcodeDigest = await transcodeIdentity(request);
  const generations = join(
    request.prepared.rootPath,
    "..",
    "..",
    "generations",
  );
  await assertNoSymlinkComponentsPromise(join(generations, ".."));
  await mkdir(generations, { recursive: true, mode: 0o700 });
  await chmod(generations, 0o700);
  const target = join(generations, transcodeDigest);
  try {
    const existing = await buildArtifact(target, transcodeDigest, request);
    if (request.fresh === true)
      throw failure(target, "Fresh transcode requires explicit cleanup");
    return await Effect.runPromise(verifyArtifact(existing));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const temporary = join(
    generations,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    const copyIdentifiers: string[] = [];
    const descriptors: RenditionDescriptor[] = [];
    for (const rendition of RENDITIONS) {
      const playlistIdentifier = `${rendition.id}.m3u8`;
      const playlistBytes = await readBounded(
        join(request.prepared.rootPath, playlistIdentifier),
        1_048_576,
      );
      const parsed = parsePlaintextMediaPlaylist(playlistBytes);
      copyIdentifiers.push(
        parsed.mapIdentifier,
        ...parsed.segments.map((item) => item.identifier),
      );
      await atomicWriteFilePromise(
        join(temporary, playlistIdentifier),
        playlistBytes,
      );
      // Only the master renderer needs rendition metadata; hashes are rebuilt after promotion.
      const segments = await Effect.runPromise(
        Effect.forEach(
          parsed.segments,
          (segment) =>
            Effect.promise(async () => ({
              sequence: segment.sequence,
              identifier: segment.identifier,
              path: join(target, segment.identifier),
              contentType: AUDIO_CONTENT_TYPE,
              durationMs: segment.durationMs,
              ...(await inspectAndHash(
                join(request.prepared.rootPath, segment.identifier),
              )),
            })),
          { concurrency },
        ),
      );
      descriptors.push({
        id: rendition.id,
        codec: "mp4a.40.2",
        nominalBitrate: rendition.nominalBitrate,
        ...calculateBandwidth(segments),
        sampleRateHz: request.prepared.sampleRateHz,
        channels: 2,
        playlist: descriptor(
          target,
          playlistIdentifier,
          await inspectAndHash(
            join(request.prepared.rootPath, playlistIdentifier),
          ),
        ),
        init: descriptor(
          target,
          parsed.mapIdentifier,
          await inspectAndHash(
            join(request.prepared.rootPath, parsed.mapIdentifier),
          ),
        ),
        segments,
      });
    }
    await Effect.runPromise(
      Effect.forEach(
        copyIdentifiers,
        (identifier) =>
          Effect.promise(() =>
            copyFileAtomic(
              join(request.prepared.rootPath, identifier),
              join(temporary, identifier),
              signal,
            ),
          ),
        { concurrency },
      ),
    );
    await atomicWriteFilePromise(
      join(temporary, "master.m3u8"),
      renderMasterPlaylist(descriptors),
    );
    throwIfAborted(signal);
    await Effect.runPromise(promoteWorkspaceDirectory(temporary, target));
    return await Effect.runPromise(
      verifyArtifact(await buildArtifact(target, transcodeDigest, request)),
    );
  } catch (error) {
    await removeTree(temporary);
    throw error;
  }
};

export const finalizeTranscode = (
  request: FinalizeRequest,
): Effect.Effect<
  TranscodeArtifact,
  ArtifactValidationError | WorkspaceIoError
> =>
  Effect.suspend(() => {
    const concurrency = request.fileConcurrency ?? 4;
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_FILE_CONCURRENCY
    )
      return Effect.fail(
        failure(
          "fileConcurrency",
          "File concurrency is outside the supported range",
        ),
      );
    return Effect.callback<
      TranscodeArtifact,
      ArtifactValidationError | WorkspaceIoError
    >((resume, signal) => {
      const worker = finalizeUnsafe(request, concurrency, signal);
      void worker.then(
        (artifact) => resume(Effect.succeed(artifact)),
        (error) =>
          resume(
            Effect.fail(
              error instanceof ArtifactValidationError ||
                error instanceof WorkspaceIoError
                ? error
                : failure(
                    basename(request.prepared.rootPath),
                    "Transcode finalization failed",
                  ),
            ),
          ),
      );
      return Effect.promise(() =>
        worker.then(
          () => undefined,
          () => undefined,
        ),
      );
    });
  });
