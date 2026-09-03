import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  canonicalIdentifiers,
  canonicalIndexBytes,
  sha256Hex,
} from "../artifact.js";
import { ArtifactValidationError } from "../errors.js";
import { validateMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import type { QuiltArtifact, QuiltPatch, VerifiedArtifact } from "../model.js";
import {
  MAX_QUILT_SOURCE_BYTES,
  WALRUS_QUILT_ENCODING_TYPE,
  WALRUS_QUILT_NUM_SHARDS,
  encodeWalrusQuilt,
  quiltPatchTags,
} from "../quilt/encoder.js";
import { parseQuiltIndex } from "../schema.js";

const MAX_INDEX_BYTES = 4_194_304;
const MAX_PLAYLIST_BYTES = 1_048_576;
const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_QUILT_BYTES = 512 * 1024 * 1024;

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
    if (entry.isSymbolicLink())
      throw failure(identifier, "Artifact must not contain symlinks");
    if (entry.isDirectory())
      files.push(...(await listRegularFiles(rootPath, identifier)));
    else if (entry.isFile()) files.push(identifier);
    else throw failure(identifier, "Artifact entry must be a regular file");
  }
  return files.sort();
};

const sameTags = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean =>
  JSON.stringify(Object.entries(left).sort()) ===
  JSON.stringify(Object.entries(right).sort());

const readBounded = async (path: string, maximum: number): Promise<Buffer> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
      throw failure(path, "Artifact file is outside its byte limit");
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
        throw failure(path, "Artifact file shrank during verification");
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
      throw failure(path, "Artifact file grew during verification");
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
      throw failure(path, "Patch must be a bounded regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size)
        throw failure(path, "Patch grew during verification");
      hash.update(chunk);
    }
    if (bytes !== metadata.size)
      throw failure(path, "Patch changed during verification");
    return { bytes: metadata.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};

const failure = (subject: string, message: string) =>
  new ArtifactValidationError({
    code: "ARTIFACT_VALIDATION",
    phase: "verify",
    subject,
    message,
  });

const verifyUnsafe = async (
  artifact: QuiltArtifact,
): Promise<VerifiedArtifact> => {
  const root = await lstat(artifact.rootPath);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw failure(artifact.rootPath, "Artifact root must be a real directory");
  if (artifact.indexBytes.byteLength > MAX_INDEX_BYTES)
    throw failure("index.json", "Supplied index bytes exceed their limit");
  const indexBytes = await readBounded(
    join(artifact.rootPath, "index.json"),
    MAX_INDEX_BYTES,
  );
  if (
    !Buffer.from(indexBytes).equals(Buffer.from(artifact.indexBytes)) ||
    sha256Hex(indexBytes) !== artifact.indexSha256
  ) {
    throw failure("index.json", "Index bytes or digest mismatch");
  }
  const index = parseQuiltIndex(indexBytes);
  if (!Buffer.from(indexBytes).equals(Buffer.from(canonicalIndexBytes(index))))
    throw failure("index.json", "Index bytes are not canonically serialized");
  validateMasterPlaylist(
    await readBounded(
      join(artifact.rootPath, "master.m3u8"),
      MAX_PLAYLIST_BYTES,
    ),
    index.renditions,
  );
  const identifiers = canonicalIdentifiers(index);
  const actual = await listRegularFiles(artifact.rootPath);
  if (actual.join("\0") !== [...identifiers, "quilt.blob"].sort().join("\0"))
    throw failure(artifact.rootPath, "Artifact inventory mismatch");
  if (
    artifact.patchCount !== identifiers.length ||
    index.patchCount !== identifiers.length ||
    artifact.patches.length !== identifiers.length
  ) {
    throw failure("patchCount", "Patch count mismatch");
  }
  const declared = new Map(
    artifact.patches.map((patch) => [patch.identifier, patch]),
  );
  if (declared.size !== identifiers.length)
    throw failure("patches", "Patch descriptors are incomplete or duplicated");
  const verifiedPatches: QuiltPatch[] = [];
  for (const identifier of identifiers) {
    const path = join(artifact.rootPath, identifier);
    const inspected = await inspectAndHash(path);
    const patch = declared.get(identifier);
    if (
      patch === undefined ||
      patch.path !== path ||
      patch.bytes !== inspected.bytes ||
      patch.sha256 !== inspected.sha256 ||
      !sameTags(patch.tags, quiltPatchTags(identifier))
    ) {
      throw failure(
        identifier,
        "Patch descriptor size, path, or digest mismatch",
      );
    }
    verifiedPatches.push(patch);
  }
  for (const rendition of index.renditions) {
    const initPatch = declared.get(rendition.init.identifier);
    if (
      initPatch?.bytes !== rendition.init.bytes ||
      initPatch.sha256 !== rendition.init.sha256
    ) {
      throw failure(rendition.init.identifier, "Init descriptor mismatch");
    }
    const playlist = parsePlaintextMediaPlaylist(
      await readBounded(
        join(artifact.rootPath, rendition.playlist),
        MAX_PLAYLIST_BYTES,
      ),
    );
    if (
      playlist.mapIdentifier !== rendition.init.identifier ||
      playlist.segments.length !== rendition.segments.length ||
      playlist.segments.some(
        (segment, position) =>
          segment.identifier !== rendition.segments[position]?.identifier ||
          segment.durationMs !== rendition.segments[position]?.durationMs,
      )
    ) {
      throw failure(
        rendition.playlist,
        "Playlist does not agree with its index descriptor",
      );
    }
    for (const segment of rendition.segments) {
      const patch = declared.get(segment.identifier);
      if (patch?.bytes !== segment.bytes || patch.sha256 !== segment.sha256) {
        throw failure(segment.identifier, "Segment descriptor mismatch");
      }
    }
  }
  if (
    artifact.quilt.path !== join(artifact.rootPath, "quilt.blob") ||
    artifact.quilt.encodingType !== WALRUS_QUILT_ENCODING_TYPE ||
    artifact.quilt.numShards !== WALRUS_QUILT_NUM_SHARDS
  )
    throw failure("quilt.blob", "Quilt descriptor configuration mismatch");
  const quiltSourceBytes = verifiedPatches.reduce(
    (total, patch) => total + patch.bytes,
    0,
  );
  if (
    !Number.isSafeInteger(quiltSourceBytes) ||
    quiltSourceBytes > MAX_QUILT_SOURCE_BYTES
  )
    throw failure("quilt.blob", "Quilt source exceeds aggregate byte limit");
  const blobs = [];
  for (const patch of verifiedPatches) {
    blobs.push({
      identifier: patch.identifier,
      contents: await readBounded(patch.path, MAX_ARTIFACT_FILE_BYTES),
      tags: patch.tags,
    });
  }
  const encoded = await Effect.runPromise(encodeWalrusQuilt(blobs));
  const quiltBytes = await readBounded(artifact.quilt.path, MAX_QUILT_BYTES);
  if (
    quiltBytes.byteLength !== artifact.quilt.bytes ||
    sha256Hex(quiltBytes) !== artifact.quilt.sha256 ||
    !Buffer.from(quiltBytes).equals(Buffer.from(encoded.bytes)) ||
    encoded.patches.length !== artifact.quilt.patches.length ||
    encoded.patches.some((patch, position) => {
      const declaredPatch = artifact.quilt.patches[position];
      return (
        declaredPatch === undefined ||
        patch.identifier !== declaredPatch.identifier ||
        patch.startIndex !== declaredPatch.startIndex ||
        patch.endIndex !== declaredPatch.endIndex ||
        !sameTags(patch.tags, declaredPatch.tags)
      );
    })
  )
    throw failure(
      "quilt.blob",
      "Serialized Walrus Quilt does not match patches",
    );
  return { ...artifact, patches: verifiedPatches, verified: true };
};

export const verifyArtifact = (
  artifact: QuiltArtifact,
): Effect.Effect<VerifiedArtifact, ArtifactValidationError> =>
  Effect.tryPromise({
    try: () => verifyUnsafe(artifact),
    catch: (error) =>
      error instanceof ArtifactValidationError
        ? error
        : failure(artifact.rootPath, "Artifact verification failed"),
  });
