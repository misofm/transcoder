import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
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
import { recoverPlaintextPlaylist } from "../hls/rewrite.js";
import type { QuiltArtifact, QuiltPatch, VerifiedArtifact } from "../model.js";
import { parseQuiltIndex } from "../schema.js";

const MAX_INDEX_BYTES = 4_194_304;
const MAX_PLAYLIST_BYTES = 1_048_576;
const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;

const readBounded = async (path: string, maximum: number): Promise<Buffer> => {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximum
  )
    throw failure(path, "Artifact file is outside its byte limit");
  return readFile(path);
};

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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
  const actual = (await readdir(artifact.rootPath)).sort();
  if (actual.join("\0") !== [...identifiers].sort().join("\0"))
    throw failure(artifact.rootPath, "Artifact inventory mismatch");
  if (
    artifact.patchCount !== identifiers.length ||
    index.patchCount !== identifiers.length
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
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw failure(identifier, "Patch must be a regular non-symlink file");
    const patch = declared.get(identifier);
    if (
      patch === undefined ||
      patch.path !== path ||
      metadata.size < 1 ||
      metadata.size > MAX_ARTIFACT_FILE_BYTES ||
      patch.bytes !== metadata.size ||
      patch.sha256 !== (await hashFile(path))
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
      recoverPlaintextPlaylist(
        await readBounded(
          join(artifact.rootPath, rendition.playlist),
          MAX_PLAYLIST_BYTES,
        ),
        rendition.id,
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
      if (
        patch?.bytes !== segment.cipherBytes ||
        patch.sha256 !== segment.ciphertextSha256
      ) {
        throw failure(segment.identifier, "Ciphertext descriptor mismatch");
      }
    }
  }
  const keyPatch = declared.get(index.key.identifier);
  if (
    keyPatch?.bytes !== index.key.bytes ||
    keyPatch.sha256 !== index.key.sha256
  ) {
    throw failure(index.key.identifier, "Key envelope descriptor mismatch");
  }
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
