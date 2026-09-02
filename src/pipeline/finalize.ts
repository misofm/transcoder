import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
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
  CryptoError,
  ArtifactValidationError,
  WorkspaceIoError,
} from "../errors.js";
import { encryptedSize, implicitIv } from "../crypto/aes-cbc.js";
import { deriveRenditionKey } from "../crypto/hkdf.js";
import { calculateBandwidth } from "../hls/bandwidth.js";
import { renderMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import {
  rewriteMediaPlaylist,
  validateEncryptedMediaPlaylist,
} from "../hls/rewrite.js";
import {
  RENDITIONS,
  SCHEMA_ID,
  type FinalizeRequest,
  type GenerationMaterial,
  type QuiltArtifact,
  type QuiltIndex,
  type QuiltPatch,
  type RenditionDescriptor,
} from "../model.js";
import { patchCountForSegments } from "../profile.js";
import { parseQuiltIndex } from "../schema.js";
import { assertNoSymlinkComponentsPromise } from "../workspace/atomic-file.js";
import { atomicWriteFilePromise } from "../workspace/atomic-file.js";
import { promoteWorkspaceDirectory } from "../workspace/state.js";
import { verifyArtifact } from "./verify.js";

const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const MAX_KEY_SEAL_BYTES = 1024 * 1024;
const MAX_ENCRYPTION_CONCURRENCY = 16;

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

const cryptoError = (subject: string, message: string) =>
  new CryptoError({
    code: "CRYPTO",
    phase: "encrypt",
    subject,
    message,
  });

const writeAtomic = async (path: string, bytes: Uint8Array): Promise<void> => {
  await atomicWriteFilePromise(path, bytes);
};

const removeEmptyTree = async (path: string): Promise<void> => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await removeEmptyTree(child);
      else await unlink(child);
    }
    await rmdir(path);
  } catch {
    // Cleanup must not replace the original typed failure.
  }
};

const generationDigest = (
  request: FinalizeRequest,
  material: GenerationMaterial,
): string => {
  const hash = createHash("sha256");
  hash.update("miso.transcoder.generation/1\0");
  hash.update(request.prepared.prepareDigest, "utf8");
  hash.update(request.recordingId, "utf8");
  hash.update(request.network, "utf8");
  hash.update(material.generationNonce);
  hash.update(createHash("sha256").update(material.keySeal).digest());
  return hash.digest("hex");
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
      metadata.size > MAX_SEGMENT_BYTES
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

export type SegmentEncryptionTransition =
  | "file-fsync"
  | "rename"
  | "parent-fsync";

/** @internal Exported only for durable-transition fault injection. */
export const encryptFileAtomic = async (
  plaintextPath: string,
  destinationPath: string,
  key: Uint8Array,
  sequence: number,
  signal: AbortSignal,
  hooks: {
    readonly afterTransition?: (
      transition: SegmentEncryptionTransition,
    ) => void | Promise<void>;
  } = {},
): Promise<{
  readonly plainBytes: number;
  readonly cipherBytes: number;
  readonly ciphertextSha256: string;
}> => {
  throwIfAborted(signal);
  const input = await open(
    plaintextPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const metadata = await input.stat();
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_SEGMENT_BYTES
  ) {
    await input.close();
    throw new RangeError("segment size outside supported bounds");
  }
  const temporary = `${destinationPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let cipherBytes = 0;
  let plainBytesRead = 0;
  try {
    output = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const cipher = createCipheriv("aes-128-cbc", key, implicitIv(sequence));
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
      plainBytesRead += bytesRead;
      if (plainBytesRead > metadata.size)
        throw new RangeError("segment grew during encryption");
      const encrypted = cipher.update(buffer.subarray(0, bytesRead));
      if (encrypted.byteLength > 0) {
        await output.write(encrypted);
        hash.update(encrypted);
        cipherBytes += encrypted.byteLength;
      }
    }
    const final = cipher.final();
    await output.write(final);
    hash.update(final);
    cipherBytes += final.byteLength;
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
    if (cipherBytes !== encryptedSize(metadata.size))
      throw new Error("CBC size invariant failed");
    const encryptedInput = await open(temporary, constants.O_RDONLY);
    const plainInput = await open(
      plaintextPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const comparisonMetadata = await plainInput.stat();
      if (
        comparisonMetadata.dev !== metadata.dev ||
        comparisonMetadata.ino !== metadata.ino ||
        comparisonMetadata.size !== metadata.size
      )
        throw new Error("plaintext changed during encryption");
      const decipher = createDecipheriv(
        "aes-128-cbc",
        key,
        implicitIv(sequence),
      );
      const compare = async (decoded: Uint8Array): Promise<void> => {
        const expected = Buffer.allocUnsafe(decoded.byteLength);
        let offset = 0;
        while (offset < expected.byteLength) {
          const { bytesRead } = await plainInput.read(
            expected,
            offset,
            expected.byteLength - offset,
            null,
          );
          if (bytesRead === 0) throw new Error("decrypted segment is longer");
          offset += bytesRead;
        }
        if (!Buffer.from(decoded).equals(expected))
          throw new Error("CBC verification failed");
        expected.fill(0);
      };
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        throwIfAborted(signal);
        const { bytesRead } = await encryptedInput.read(
          buffer,
          0,
          buffer.byteLength,
          null,
        );
        if (bytesRead === 0) break;
        await compare(decipher.update(buffer.subarray(0, bytesRead)));
      }
      await compare(decipher.final());
      const extra = Buffer.allocUnsafe(1);
      if ((await plainInput.read(extra, 0, 1, null)).bytesRead !== 0)
        throw new Error("decrypted segment is shorter");
    } finally {
      await encryptedInput.close();
      await plainInput.close();
    }
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
    return {
      plainBytes: metadata.size,
      cipherBytes,
      ciphertextSha256: hash.digest("hex"),
    };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const loadExistingArtifact = async (
  rootPath: string,
  digest: string,
  request: FinalizeRequest,
  material: GenerationMaterial,
): Promise<QuiltArtifact | undefined> => {
  try {
    const indexBytes = await readBounded(
      join(rootPath, "index.json"),
      4_194_304,
    );
    const index = parseQuiltIndex(indexBytes);
    if (
      index.generation !==
        Buffer.from(material.generationNonce).toString("base64url") ||
      index.recordingId !== request.recordingId ||
      index.network !== request.network ||
      index.key.sha256 !== sha256Hex(material.keySeal)
    ) {
      throw artifactError(
        rootPath,
        "Existing generation does not match supplied generation material",
      );
    }
    const identifiers = [
      "index.json",
      "master.m3u8",
      "key.seal",
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
        bytes: inspected.bytes,
        sha256: inspected.sha256,
      });
    }
    const artifact: QuiltArtifact = {
      generationDigest: digest,
      rootPath,
      indexPath: join(rootPath, "index.json"),
      indexBytes,
      indexSha256: sha256Hex(indexBytes),
      patchCount: identifiers.length,
      patches,
      toolchain: request.prepared.toolchain,
    };
    const verified = await Effect.runPromise(verifyArtifact(artifact));
    try {
      const checkpoint = await readBounded(
        join(rootPath, "..", `${digest}.json`),
        4_194_304,
      );
      const expectedCheckpoint = generationCheckpointBytes(
        digest,
        request,
        material,
        verified.patches,
      );
      if (!Buffer.from(checkpoint).equals(Buffer.from(expectedCheckpoint)))
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

const generationCheckpointBytes = (
  digest: string,
  request: FinalizeRequest,
  material: GenerationMaterial,
  patches: readonly QuiltPatch[],
): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify(
      {
        schema: "miso.transcoder-generation/1",
        generationDigest: digest,
        prepareDigest: request.prepared.prepareDigest,
        generationNonce: Buffer.from(material.generationNonce).toString(
          "base64url",
        ),
        keySealSha256: sha256Hex(material.keySeal),
        toolchainSha256: request.prepared.toolchain.sha256,
        patches: patches.map(({ identifier, bytes, sha256 }) => ({
          identifier,
          bytes,
          sha256,
        })),
      },
      null,
      2,
    )}\n`,
  );

const finalizeUnsafe = async (
  request: FinalizeRequest,
  material: GenerationMaterial,
  concurrency: number,
  signal: AbortSignal,
): Promise<QuiltArtifact> => {
  throwIfAborted(signal);
  if (
    material.rootKey.byteLength !== 32 ||
    material.generationNonce.byteLength !== 32
  ) {
    throw cryptoError(
      "generationMaterial",
      "Root key and generation nonce must each contain exactly 32 bytes",
    );
  }
  if (
    material.keySeal.byteLength < 1 ||
    material.keySeal.byteLength > MAX_KEY_SEAL_BYTES
  ) {
    throw artifactError(
      "key.seal",
      "Opaque key envelope size is outside supported bounds",
    );
  }
  const ownedRootKey = Uint8Array.from(material.rootKey);
  try {
    const digest = generationDigest(request, material);
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
    const nonce = Buffer.from(material.generationNonce).toString("base64url");
    for (const entry of await readdir(generations, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f]{64}$/u.test(entry.name) ||
        entry.name === digest
      )
        continue;
      const priorIndex = parseQuiltIndex(
        await readBounded(
          join(generations, entry.name, "index.json"),
          4_194_304,
        ),
      );
      if (priorIndex.generation === nonce)
        throw artifactError(
          "generationNonce",
          "Generation nonce was already used by another generation",
        );
    }
    const existing = await loadExistingArtifact(
      target,
      digest,
      request,
      material,
    );
    if (existing !== undefined) {
      if (request.fresh === true)
        throw artifactError(
          target,
          "Fresh finalization requires unused generation material",
        );
      await writeAtomic(
        join(generations, `${digest}.json`),
        generationCheckpointBytes(digest, request, material, existing.patches),
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
      await writeAtomic(join(temporary, "key.seal"), material.keySeal);
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
        const key = deriveRenditionKey(
          ownedRootKey,
          request.recordingId,
          material.generationNonce,
          rendition.id,
        );
        try {
          const records = await Effect.runPromise(
            Effect.forEach(
              playlist.segments,
              (segment) =>
                Effect.tryPromise({
                  try: async () => {
                    const encrypted = await encryptFileAtomic(
                      join(request.prepared.rootPath, segment.identifier),
                      join(temporary, segment.identifier),
                      key,
                      segment.sequence,
                      signal,
                    );
                    return {
                      sequence: segment.sequence,
                      identifier: segment.identifier,
                      durationMs: segment.durationMs,
                      ...encrypted,
                    } as const;
                  },
                  catch: () =>
                    cryptoError(
                      segment.identifier,
                      "Segment encryption or verification failed",
                    ),
                }),
              { concurrency },
            ),
          );
          const initBytes = await readBounded(
            join(request.prepared.rootPath, playlist.mapIdentifier),
            MAX_SEGMENT_BYTES,
          );
          await writeAtomic(join(temporary, playlist.mapIdentifier), initBytes);
          const rewritten = rewriteMediaPlaylist(playlistBytes, rendition.id);
          validateEncryptedMediaPlaylist(rewritten, rendition.id);
          await writeAtomic(join(temporary, playlistName), rewritten);
          const bandwidth = calculateBandwidth(records);
          renditionDescriptors.push({
            id: rendition.id,
            codec: "mp4a.40.2",
            nominalBitrate: rendition.nominalBitrate,
            ...bandwidth,
            sampleRateHz: request.prepared.sampleRateHz,
            channels: 2,
            playlist: playlistName,
            init: {
              identifier: playlist.mapIdentifier,
              bytes: initBytes.byteLength,
              sha256: sha256Hex(initBytes),
            },
            segments: records,
          });
        } finally {
          key.fill(0);
        }
      }
      const segmentCounts = renditionDescriptors.map(
        (rendition) => rendition.segments.length,
      );
      if (!segmentCounts.every((count) => count === segmentCounts[0]))
        throw artifactError("renditions", "Segment counts are not aligned");
      const patchCount = patchCountForSegments(segmentCounts[0] ?? 0);
      const index: QuiltIndex = {
        schema: SCHEMA_ID,
        network: request.network,
        recordingId: request.recordingId,
        generation: Buffer.from(material.generationNonce).toString("base64url"),
        masterPlaylist: "master.m3u8",
        key: {
          identifier: "key.seal",
          bytes: material.keySeal.byteLength,
          sha256: sha256Hex(material.keySeal),
        },
        segmentTargetMs: request.prepared.segmentTargetMs,
        patchCount,
        encryption: {
          scheme: "hls-aes-128-cbc-hkdf/1",
          kdf: "hkdf-sha256",
          sealPlaintextBytes: 32,
        },
        renditions: renditionDescriptors,
      };
      const masterBytes = renderMasterPlaylist(renditionDescriptors);
      await writeAtomic(join(temporary, "master.m3u8"), masterBytes);
      const indexBytes = canonicalIndexBytes(index);
      await writeAtomic(join(temporary, "index.json"), indexBytes);
      const expected = [
        "index.json",
        "master.m3u8",
        "key.seal",
        ...renditionDescriptors.flatMap((rendition) => [
          rendition.playlist,
          rendition.init.identifier,
          ...rendition.segments.map((segment) => segment.identifier),
        ]),
      ];
      const actual = (await readdir(temporary)).sort();
      if (actual.join("\0") !== [...expected].sort().join("\0"))
        throw artifactError(temporary, "Artifact has missing or extra files");
      const patches: QuiltPatch[] = [];
      for (const identifier of expected) {
        const inspected = await inspectAndHash(join(temporary, identifier));
        patches.push({
          identifier,
          path: join(target, identifier),
          bytes: inspected.bytes,
          sha256: inspected.sha256,
        });
      }
      throwIfAborted(signal);
      await Effect.runPromise(promoteWorkspaceDirectory(temporary, target));
      await writeAtomic(
        join(generations, `${digest}.json`),
        generationCheckpointBytes(digest, request, material, patches),
      );
      const artifact: QuiltArtifact = {
        generationDigest: digest,
        rootPath: target,
        indexPath: join(target, "index.json"),
        indexBytes,
        indexSha256: sha256Hex(indexBytes),
        patchCount,
        patches,
        toolchain: request.prepared.toolchain,
      };
      return await Effect.runPromise(verifyArtifact(artifact));
    } catch (error) {
      await removeEmptyTree(temporary);
      throw error;
    }
  } finally {
    ownedRootKey.fill(0);
  }
};

export const finalizeTranscode = (
  request: FinalizeRequest,
  material: GenerationMaterial,
): Effect.Effect<
  QuiltArtifact,
  CryptoError | ArtifactValidationError | WorkspaceIoError
> => {
  const configured = request.prepared.segmentTargetMs;
  const concurrency = request.encryptionConcurrency ?? 4;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_ENCRYPTION_CONCURRENCY ||
    configured < 6_000
  ) {
    material.rootKey.fill(0);
    return Effect.fail(
      artifactError(
        "encryptionConcurrency",
        "Encryption concurrency is outside the supported range",
      ),
    );
  }
  const mapFailure = (
    error: unknown,
  ): CryptoError | ArtifactValidationError | WorkspaceIoError =>
    error instanceof CryptoError ||
    error instanceof ArtifactValidationError ||
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
            "Finalization failed without exposing sensitive details",
          );
  return Effect.callback<
    QuiltArtifact,
    CryptoError | ArtifactValidationError | WorkspaceIoError
  >((resume, signal) => {
    const worker = finalizeUnsafe(request, material, concurrency, signal);
    void worker.then(
      (artifact) => resume(Effect.succeed(artifact)),
      (error) => resume(Effect.fail(mapFailure(error))),
    );
    // Interruption aborts the worker and waits for its cleanup/commit
    // reconciliation before the surrounding workspace lock may be released.
    return Effect.promise(async () => {
      await worker.then(
        () => undefined,
        () => undefined,
      );
    });
  }).pipe(Effect.ensuring(Effect.sync(() => material.rootKey.fill(0))));
};
