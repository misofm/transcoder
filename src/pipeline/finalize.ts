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

import { canonicalIndexBytes, sha256Hex } from "../artifact.js";
import {
  ArtifactValidationError,
  QuiltEncodingError,
  WorkspaceIoError,
} from "../errors.js";
import { calculateBandwidth } from "../hls/bandwidth.js";
import { renderMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import {
  RENDITIONS,
  SCHEMA_ID,
  type FinalizeRequest,
  type QuiltArtifact,
  type QuiltIndex,
  type QuiltPatch,
  type RenditionDescriptor,
  type WalrusQuilt,
} from "../model.js";
import { patchCountForSegments } from "../profile.js";
import {
  MAX_QUILT_SOURCE_BYTES,
  WALRUS_QUILT_ENCODING_TYPE,
  WALRUS_QUILT_NUM_SHARDS,
  encodeWalrusQuilt,
  quiltPatchTags,
} from "../quilt/encoder.js";
import { parseQuiltIndex } from "../schema.js";
import {
  assertNoSymlinkComponentsPromise,
  atomicWriteFilePromise,
} from "../workspace/atomic-file.js";
import { promoteWorkspaceDirectory } from "../workspace/state.js";
import { verifyArtifact } from "./verify.js";

const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_CONCURRENCY = 16;

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted)
    throw new DOMException("Operation interrupted", "AbortError");
};

const artifactError = (subject: string, message: string) =>
  new ArtifactValidationError({
    code: "ARTIFACT_VALIDATION",
    phase: "finalize",
    subject,
    message,
  });

const writeAtomic = async (path: string, bytes: Uint8Array): Promise<void> => {
  await atomicWriteFilePromise(path, bytes);
};

const removeTree = async (path: string): Promise<void> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await removeTree(child);
      else await unlink(child);
    }
    await rmdir(path);
  } catch {
    // Cleanup must not replace the original typed failure.
  }
};

const generationDigest = (
  request: FinalizeRequest,
  contentDigest: string,
): string => {
  const hash = createHash("sha256");
  hash.update("miso.transcoder.walrus-quilt-generation/1\0");
  hash.update(contentDigest, "utf8");
  hash.update(request.recordingId, "utf8");
  return hash.digest("hex");
};

const generationIdentity = (digest: string): string =>
  Buffer.from(digest, "hex").toString("base64url");

const readBounded = async (
  path: string,
  ceiling: number,
  signal?: AbortSignal,
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
    while (offset < bytes.byteLength) {
      if (signal !== undefined) throwIfAborted(signal);
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

const inspectAndHash = async (
  path: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> => {
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
      throw new RangeError("patch outside bounds");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size)
        throw new RangeError("patch grew while hashing");
      hash.update(chunk);
    }
    if (bytes !== metadata.size)
      throw new RangeError("patch changed while hashing");
    return { bytes: metadata.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};

const listRegularFiles = async (
  rootPath: string,
  prefix = "",
): Promise<readonly string[]> => {
  const entries = await readdir(join(rootPath, prefix), {
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    const identifier = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new TypeError("symlink in artifact");
    if (entry.isDirectory())
      files.push(...(await listRegularFiles(rootPath, identifier)));
    else if (entry.isFile()) files.push(identifier);
    else throw new TypeError("non-regular artifact entry");
  }
  return files.sort();
};

const encodeArtifactQuilt = async (
  rootPath: string,
  patches: readonly QuiltPatch[],
  signal: AbortSignal,
): Promise<{
  readonly bytes: Uint8Array;
  readonly descriptor: WalrusQuilt;
}> => {
  const sourceBytes = patches.reduce((total, patch) => total + patch.bytes, 0);
  if (
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes > MAX_QUILT_SOURCE_BYTES
  )
    throw new QuiltEncodingError({
      code: "QUILT_ENCODING",
      phase: "quilt",
      subject: "quilt.blob",
      message: "Walrus Quilt source exceeds the aggregate byte limit",
      patchCount: patches.length,
      sourceBytes,
    });
  const blobs = [];
  for (const patch of patches) {
    throwIfAborted(signal);
    const contents = await readBounded(
      join(rootPath, patch.identifier),
      MAX_ARTIFACT_FILE_BYTES,
      signal,
    );
    if (
      contents.byteLength !== patch.bytes ||
      sha256Hex(contents) !== patch.sha256
    )
      throw artifactError(
        patch.identifier,
        "Patch changed before Quilt encoding",
      );
    blobs.push({ identifier: patch.identifier, contents, tags: patch.tags });
  }
  throwIfAborted(signal);
  const encoded = await Effect.runPromise(encodeWalrusQuilt(blobs));
  throwIfAborted(signal);
  return {
    bytes: encoded.bytes,
    descriptor: {
      path: join(rootPath, "quilt.blob"),
      bytes: encoded.bytes.byteLength,
      sha256: sha256Hex(encoded.bytes),
      encodingType: WALRUS_QUILT_ENCODING_TYPE,
      numShards: WALRUS_QUILT_NUM_SHARDS,
      patches: encoded.patches,
    },
  };
};

const preparedContentDigest = async (
  rootPath: string,
  signal: AbortSignal,
): Promise<string> => {
  const identifiers: string[] = [];
  for (const rendition of RENDITIONS) {
    const playlistName = `${rendition.id}.m3u8`;
    const playlist = parsePlaintextMediaPlaylist(
      await readBounded(join(rootPath, playlistName), 1_048_576),
    );
    identifiers.push(
      playlistName,
      playlist.mapIdentifier,
      ...playlist.segments.map((segment) => segment.identifier),
    );
  }
  const hash = createHash("sha256");
  hash.update("miso.transcoder.prepared-content/1\0");
  for (const identifier of identifiers) {
    throwIfAborted(signal);
    const file = await inspectAndHash(join(rootPath, identifier));
    hash.update(identifier, "utf8");
    hash.update("\0");
    hash.update(String(file.bytes), "utf8");
    hash.update("\0");
    hash.update(file.sha256, "utf8");
  }
  return hash.digest("hex");
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
      const { bytesRead } = await input.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
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
        if (result.bytesWritten === 0)
          throw new RangeError("destination accepted a short write");
        written += result.bytesWritten;
      }
    }
    if (copiedBytes !== metadata.size)
      throw new RangeError("source shrank during copy");
    await output.sync();
    await hooks.afterTransition?.("file-fsync");
  } catch (error) {
    await output?.close().catch(() => undefined);
    output = undefined;
    await input.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await input.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
  }
  try {
    const copied = { bytes: copiedBytes, sha256: hash.digest("hex") };
    const currentSource = await inspectAndHash(sourcePath);
    if (
      currentSource.bytes !== copied.bytes ||
      currentSource.sha256 !== copied.sha256
    )
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

const generationCheckpointBytes = (
  digest: string,
  contentDigest: string,
  request: FinalizeRequest,
  patches: readonly QuiltPatch[],
  quilt: WalrusQuilt,
): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify(
      {
        schema: "miso.transcoder-generation/1",
        generationDigest: digest,
        prepareDigest: request.prepared.prepareDigest,
        resultDigest: request.prepared.resultDigest,
        contentDigest,
        generation: generationIdentity(digest),
        recordingId: request.recordingId,
        toolchainSha256: request.prepared.toolchain.sha256,
        patches: patches.map(({ identifier, bytes, sha256 }) => ({
          identifier,
          bytes,
          sha256,
        })),
        quilt: {
          bytes: quilt.bytes,
          sha256: quilt.sha256,
          encodingType: quilt.encodingType,
          numShards: quilt.numShards,
          patches: quilt.patches,
        },
      },
      null,
      2,
    )}\n`,
  );

const loadExistingArtifact = async (
  rootPath: string,
  digest: string,
  contentDigest: string,
  request: FinalizeRequest,
  signal: AbortSignal,
): Promise<QuiltArtifact | undefined> => {
  try {
    const indexBytes = await readBounded(
      join(rootPath, "index.json"),
      4_194_304,
    );
    const index = parseQuiltIndex(indexBytes);
    if (
      index.generation !== generationIdentity(digest) ||
      index.recordingId !== request.recordingId
    )
      throw artifactError(
        rootPath,
        "Existing generation does not match this finalization request",
      );
    const identifiers = [
      "index.json",
      "master.m3u8",
      ...index.renditions.flatMap((rendition) => [
        rendition.playlist,
        rendition.init.identifier,
        ...rendition.segments.map((segment) => segment.identifier),
      ]),
    ];
    const patches: QuiltPatch[] = [];
    for (const identifier of identifiers) {
      const path = join(rootPath, identifier);
      const inspected = await inspectAndHash(path);
      patches.push({
        identifier,
        path,
        ...inspected,
        tags: quiltPatchTags(identifier),
      });
    }
    const encoded = await encodeArtifactQuilt(rootPath, patches, signal);
    const quiltFile = await inspectAndHash(join(rootPath, "quilt.blob"));
    if (
      quiltFile.bytes !== encoded.descriptor.bytes ||
      quiltFile.sha256 !== encoded.descriptor.sha256
    )
      throw artifactError(
        "quilt.blob",
        "Existing Quilt bytes do not match patches",
      );
    const quilt: WalrusQuilt = {
      ...encoded.descriptor,
      path: join(rootPath, "quilt.blob"),
    };
    const artifact: QuiltArtifact = {
      generationDigest: digest,
      rootPath,
      indexPath: join(rootPath, "index.json"),
      indexBytes,
      indexSha256: sha256Hex(indexBytes),
      patchCount: identifiers.length,
      patches,
      quilt,
      toolchain: request.prepared.toolchain,
    };
    const verified = await Effect.runPromise(verifyArtifact(artifact));
    try {
      const checkpoint = await readBounded(
        join(rootPath, "..", `${digest}.json`),
        4_194_304,
      );
      const expected = generationCheckpointBytes(
        digest,
        contentDigest,
        request,
        verified.patches,
        verified.quilt,
      );
      if (!Buffer.from(checkpoint).equals(Buffer.from(expected)))
        throw artifactError(
          rootPath,
          "Existing generation checkpoint does not match artifact bytes",
        );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    return verified;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

const finalizeUnsafe = async (
  request: FinalizeRequest,
  concurrency: number,
  signal: AbortSignal,
): Promise<QuiltArtifact> => {
  throwIfAborted(signal);
  const contentDigest = await preparedContentDigest(
    request.prepared.rootPath,
    signal,
  );
  const digest = generationDigest(request, contentDigest);
  const generations = join(
    request.prepared.rootPath,
    "..",
    "..",
    "generations",
  );
  await assertNoSymlinkComponentsPromise(join(generations, ".."));
  await mkdir(generations, { recursive: true, mode: 0o700 });
  await chmod(generations, 0o700);
  await assertNoSymlinkComponentsPromise(generations);
  const target = join(generations, digest);
  const existing = await loadExistingArtifact(
    target,
    digest,
    contentDigest,
    request,
    signal,
  );
  if (existing !== undefined) {
    if (request.fresh === true)
      throw artifactError(target, "Fresh finalization requires a new request");
    await writeAtomic(
      join(generations, `${digest}.json`),
      generationCheckpointBytes(
        digest,
        contentDigest,
        request,
        existing.patches,
        existing.quilt,
      ),
    );
    return existing;
  }
  const temporary = join(
    generations,
    `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  const renditionDescriptors: RenditionDescriptor[] = [];
  try {
    for (const rendition of RENDITIONS) {
      const playlistName = `${rendition.id}.m3u8`;
      const playlistBytes = await readBounded(
        join(request.prepared.rootPath, playlistName),
        1_048_576,
      );
      const playlist = parsePlaintextMediaPlaylist(playlistBytes);
      if (playlist.mapIdentifier !== `${rendition.id}-init.mp4`)
        throw artifactError(playlistName, "Unexpected init identifier");
      throwIfAborted(signal);
      const records = await Effect.runPromise(
        Effect.forEach(
          playlist.segments,
          (segment) =>
            Effect.tryPromise({
              try: async () => ({
                sequence: segment.sequence,
                identifier: segment.identifier,
                durationMs: segment.durationMs,
                ...(await copyFileAtomic(
                  join(request.prepared.rootPath, segment.identifier),
                  join(temporary, segment.identifier),
                  signal,
                )),
              }),
              catch: () =>
                artifactError(
                  segment.identifier,
                  "Segment copy or verification failed",
                ),
            }),
          { concurrency },
        ),
      );
      const init = await copyFileAtomic(
        join(request.prepared.rootPath, playlist.mapIdentifier),
        join(temporary, playlist.mapIdentifier),
        signal,
      );
      await writeAtomic(join(temporary, playlistName), playlistBytes);
      const bandwidth = calculateBandwidth(records);
      renditionDescriptors.push({
        id: rendition.id,
        codec: "mp4a.40.2",
        nominalBitrate: rendition.nominalBitrate,
        ...bandwidth,
        sampleRateHz: request.prepared.sampleRateHz,
        channels: 2,
        playlist: playlistName,
        init: { identifier: playlist.mapIdentifier, ...init },
        segments: records,
      });
    }
    const segmentCounts = renditionDescriptors.map(
      (rendition) => rendition.segments.length,
    );
    if (!segmentCounts.every((count) => count === segmentCounts[0]))
      throw artifactError("renditions", "Segment counts are not aligned");
    if (
      (await preparedContentDigest(request.prepared.rootPath, signal)) !==
      contentDigest
    )
      throw artifactError(
        request.prepared.rootPath,
        "Prepared content changed during finalization",
      );
    const patchCount = patchCountForSegments(segmentCounts[0] ?? 0);
    const index: QuiltIndex = {
      schema: SCHEMA_ID,
      recordingId: request.recordingId,
      generation: generationIdentity(digest),
      masterPlaylist: "master.m3u8",
      segmentTargetMs: request.prepared.segmentTargetMs,
      patchCount,
      renditions: renditionDescriptors,
    };
    const masterBytes = renderMasterPlaylist(renditionDescriptors);
    await writeAtomic(join(temporary, "master.m3u8"), masterBytes);
    const indexBytes = canonicalIndexBytes(index);
    await writeAtomic(join(temporary, "index.json"), indexBytes);
    const expected = [
      "index.json",
      "master.m3u8",
      ...renditionDescriptors.flatMap((rendition) => [
        rendition.playlist,
        rendition.init.identifier,
        ...rendition.segments.map((segment) => segment.identifier),
      ]),
    ];
    const actual = await listRegularFiles(temporary);
    if (actual.join("\0") !== [...expected].sort().join("\0"))
      throw artifactError(temporary, "Artifact has missing or extra files");
    const patches: QuiltPatch[] = [];
    for (const identifier of expected) {
      const inspected = await inspectAndHash(join(temporary, identifier));
      patches.push({
        identifier,
        path: join(target, identifier),
        ...inspected,
        tags: quiltPatchTags(identifier),
      });
    }
    const encoded = await encodeArtifactQuilt(temporary, patches, signal);
    await writeAtomic(join(temporary, "quilt.blob"), encoded.bytes);
    const quilt: WalrusQuilt = {
      ...encoded.descriptor,
      path: join(target, "quilt.blob"),
    };
    throwIfAborted(signal);
    await Effect.runPromise(promoteWorkspaceDirectory(temporary, target));
    await writeAtomic(
      join(generations, `${digest}.json`),
      generationCheckpointBytes(digest, contentDigest, request, patches, quilt),
    );
    const artifact: QuiltArtifact = {
      generationDigest: digest,
      rootPath: target,
      indexPath: join(target, "index.json"),
      indexBytes,
      indexSha256: sha256Hex(indexBytes),
      patchCount,
      patches,
      quilt,
      toolchain: request.prepared.toolchain,
    };
    return await Effect.runPromise(verifyArtifact(artifact));
  } catch (error) {
    await removeTree(temporary);
    throw error;
  }
};

export const finalizeTranscode = (
  request: FinalizeRequest,
): Effect.Effect<
  QuiltArtifact,
  ArtifactValidationError | QuiltEncodingError | WorkspaceIoError
> => {
  const mapFailure = (
    error: unknown,
  ): ArtifactValidationError | QuiltEncodingError | WorkspaceIoError =>
    error instanceof ArtifactValidationError ||
    error instanceof QuiltEncodingError ||
    error instanceof WorkspaceIoError
      ? error
      : error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          [
            "EACCES",
            "EIO",
            "EMFILE",
            "ENFILE",
            "ENOENT",
            "ENOSPC",
            "EROFS",
          ].includes(error.code)
        ? new WorkspaceIoError({
            code: "WORKSPACE_IO",
            phase: "workspace",
            subject: basename(request.prepared.rootPath),
            message: "Finalization workspace operation failed",
          })
        : artifactError(
            basename(request.prepared.rootPath),
            "Finalization failed",
          );
  return Effect.suspend(() => {
    const configured = request.prepared.segmentTargetMs;
    const concurrency = request.fileConcurrency ?? 4;
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > MAX_FILE_CONCURRENCY ||
      configured < 6_000
    )
      return Effect.fail(
        artifactError(
          "fileConcurrency",
          "File concurrency is outside the supported range",
        ),
      );
    return Effect.callback<
      QuiltArtifact,
      ArtifactValidationError | QuiltEncodingError | WorkspaceIoError
    >((resume, signal) => {
      const worker = finalizeUnsafe(request, concurrency, signal);
      void worker.then(
        (artifact) => resume(Effect.succeed(artifact)),
        (error) => resume(Effect.fail(mapFailure(error))),
      );
      // Interruption aborts the worker and joins cleanup before the workspace
      // lock may be released.
      return Effect.promise(async () => {
        await worker.then(
          () => undefined,
          () => undefined,
        );
      });
    });
  });
};
