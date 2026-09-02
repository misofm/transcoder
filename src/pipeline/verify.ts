import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { canonicalIdentifiers, sha256Hex } from "../artifact.js";
import { ArtifactValidationError } from "../errors.js";
import { validateMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import { recoverPlaintextPlaylist } from "../hls/rewrite.js";
import type { QuiltArtifact, QuiltPatch, VerifiedArtifact } from "../model.js";
import { parseQuiltIndex } from "../schema.js";

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
  const indexBytes = await readFile(join(artifact.rootPath, "index.json"));
  if (
    !Buffer.from(indexBytes).equals(Buffer.from(artifact.indexBytes)) ||
    sha256Hex(indexBytes) !== artifact.indexSha256
  ) {
    throw failure("index.json", "Index bytes or digest mismatch");
  }
  const index = parseQuiltIndex(indexBytes);
  validateMasterPlaylist(
    await readFile(join(artifact.rootPath, "master.m3u8")),
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
    const bytes = await readFile(path);
    const patch = declared.get(identifier);
    if (
      patch === undefined ||
      patch.path !== path ||
      patch.bytes !== bytes.byteLength ||
      patch.sha256 !== sha256Hex(bytes)
    ) {
      throw failure(
        identifier,
        "Patch descriptor size, path, or digest mismatch",
      );
    }
    verifiedPatches.push(patch);
  }
  for (const rendition of index.renditions) {
    const playlist = parsePlaintextMediaPlaylist(
      recoverPlaintextPlaylist(
        await readFile(join(artifact.rootPath, rendition.playlist)),
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
      const bytes = await readFile(join(artifact.rootPath, segment.identifier));
      if (
        bytes.byteLength !== segment.cipherBytes ||
        sha256Hex(bytes) !== segment.ciphertextSha256
      ) {
        throw failure(segment.identifier, "Ciphertext descriptor mismatch");
      }
    }
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
