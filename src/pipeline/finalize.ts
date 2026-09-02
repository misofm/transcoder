import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect } from "effect";

import { canonicalIndexBytes, sha256Hex } from "../artifact.js";
import {
  CryptoError,
  ArtifactValidationError,
  type WorkspaceIoError,
} from "../errors.js";
import {
  decryptSegment,
  encryptSegment,
  encryptedSize,
} from "../crypto/aes-cbc.js";
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
import { verifyArtifact } from "./verify.js";

const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
const MAX_KEY_SEAL_BYTES = 1024 * 1024;
const MAX_ENCRYPTION_CONCURRENCY = 16;

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
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const parent = await open(join(path, ".."), constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
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
  hash.update(material.generationNonce);
  hash.update(createHash("sha256").update(material.keySeal).digest());
  return hash.digest("hex");
};

const readBounded = async (
  path: string,
  ceiling: number,
): Promise<Uint8Array> => {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > ceiling)
    throw new RangeError("file outside bounds");
  return readFile(path);
};

const loadExistingArtifact = async (
  rootPath: string,
  digest: string,
  request: FinalizeRequest,
  material: GenerationMaterial,
): Promise<QuiltArtifact | undefined> => {
  try {
    const indexBytes = await readFile(join(rootPath, "index.json"));
    const index = parseQuiltIndex(indexBytes);
    if (
      index.generation !==
        Buffer.from(material.generationNonce).toString("base64url") ||
      index.recordingId !== request.recordingId ||
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
      const bytes = await readFile(join(rootPath, identifier));
      patches.push({
        identifier,
        path: join(rootPath, identifier),
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
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
    return await Effect.runPromise(verifyArtifact(artifact));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

const finalizeUnsafe = async (
  request: FinalizeRequest,
  material: GenerationMaterial,
  concurrency: number,
): Promise<QuiltArtifact> => {
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
  const existing = await loadExistingArtifact(
    target,
    digest,
    request,
    material,
  );
  if (existing !== undefined) return existing;
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
      const key = deriveRenditionKey(
        material.rootKey,
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
                  const plaintext = await readBounded(
                    join(request.prepared.rootPath, segment.identifier),
                    MAX_SEGMENT_BYTES,
                  );
                  const ciphertext = encryptSegment(
                    plaintext,
                    key,
                    segment.sequence,
                  );
                  if (
                    ciphertext.byteLength !==
                    encryptedSize(plaintext.byteLength)
                  )
                    throw new Error("CBC size invariant failed");
                  await writeAtomic(
                    join(temporary, segment.identifier),
                    ciphertext,
                  );
                  const roundTrip = decryptSegment(
                    ciphertext,
                    key,
                    segment.sequence,
                  );
                  if (!Buffer.from(roundTrip).equals(Buffer.from(plaintext)))
                    throw new Error("CBC verification failed");
                  roundTrip.fill(0);
                  return {
                    sequence: segment.sequence,
                    identifier: segment.identifier,
                    durationMs: segment.durationMs,
                    plainBytes: plaintext.byteLength,
                    cipherBytes: ciphertext.byteLength,
                    ciphertextSha256: sha256Hex(ciphertext),
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
      const bytes = await readFile(join(temporary, identifier));
      patches.push({
        identifier,
        path: join(target, identifier),
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
      });
    }
    await rename(temporary, target);
    await writeAtomic(
      join(generations, `${digest}.json`),
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
      ),
    );
    return {
      generationDigest: digest,
      rootPath: target,
      indexPath: join(target, "index.json"),
      indexBytes,
      indexSha256: sha256Hex(indexBytes),
      patchCount,
      patches,
      toolchain: request.prepared.toolchain,
    };
  } catch (error) {
    await removeEmptyTree(temporary);
    throw error;
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
  return Effect.tryPromise({
    try: () => finalizeUnsafe(request, material, concurrency),
    catch: (error) =>
      error instanceof CryptoError || error instanceof ArtifactValidationError
        ? error
        : artifactError(
            basename(request.prepared.rootPath),
            "Finalization failed without exposing sensitive details",
          ),
  }).pipe(Effect.ensuring(Effect.sync(() => material.rootKey.fill(0))));
};
