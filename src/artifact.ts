import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

import type {
  QuiltIndex,
  QuiltPatch,
  RenditionDescriptor,
  VerifiedArtifact,
} from "./model.js";
import { assertQuiltIndex } from "./schema.js";
import { parseQuiltIndex } from "./schema.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

// A 32-byte unpadded base64url value has 43 characters and two zero padding
// bits, so its final sextet must be divisible by four.
const WALRUS_BLOB_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export const R2_IMMUTABLE_CACHE_CONTROL =
  "public, max-age=31536000, immutable" as const;

export interface R2UploadObject {
  readonly key: string;
  readonly identifier: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly cacheControl: typeof R2_IMMUTABLE_CACHE_CONTROL;
}

export interface R2UploadManifest {
  readonly blobId: string;
  readonly entrypointKey: string;
  /** Evidence identifying the exact Quilt that must have produced blobId. */
  readonly quilt: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  /** Ordered so the public master playlist is uploaded last. */
  readonly objects: readonly R2UploadObject[];
}

/**
 * Map an independently verified Quilt artifact to immutable R2 object keys.
 * Walrus publication supplies `blobId`; this package performs no upload.
 */
export const createR2UploadManifest = (
  artifact: VerifiedArtifact,
  blobId: string,
): R2UploadManifest => {
  if (!WALRUS_BLOB_ID.test(blobId))
    throw new TypeError("Invalid Walrus blob ID");
  if (artifact.verified !== true)
    throw new TypeError("R2 delivery requires a verified artifact");

  const index = parseQuiltIndex(artifact.indexBytes);
  const canonical = orderPatches(index, artifact.patches);
  if (
    !isAbsolute(artifact.rootPath) ||
    artifact.patchCount !== index.patchCount ||
    canonical.length !== artifact.patchCount ||
    artifact.indexPath !== join(artifact.rootPath, "index.json") ||
    artifact.indexBytes.byteLength !== canonical[0]?.bytes ||
    artifact.indexSha256 !== sha256Hex(artifact.indexBytes) ||
    artifact.indexSha256 !== canonical[0]?.sha256 ||
    artifact.quilt.path !== join(artifact.rootPath, "quilt.blob") ||
    !Number.isSafeInteger(artifact.quilt.bytes) ||
    artifact.quilt.bytes < 1 ||
    !SHA256.test(artifact.quilt.sha256)
  )
    throw new TypeError("Verified artifact metadata is inconsistent");

  for (const patch of canonical) {
    const expectedContentType =
      patch.identifier === "index.json"
        ? "application/json; charset=utf-8"
        : patch.identifier.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "audio/mp4";
    if (
      patch.path !== join(artifact.rootPath, patch.identifier) ||
      !Number.isSafeInteger(patch.bytes) ||
      patch.bytes < 1 ||
      !SHA256.test(patch.sha256) ||
      Object.keys(patch.tags).length !== 1 ||
      patch.tags["content-type"] !== expectedContentType
    )
      throw new TypeError("Verified patch metadata is inconsistent");
  }

  const master = canonical.filter(
    (patch) => patch.identifier === "master.m3u8",
  );
  if (master.length !== 1)
    throw new TypeError("Verified artifact has no unique master playlist");

  const ordered = [
    ...canonical.filter((patch) => patch.identifier !== "master.m3u8"),
    master[0]!,
  ];
  const objects = ordered.map((patch): R2UploadObject => {
    const contentType = patch.tags["content-type"]!;
    return {
      key: `${blobId}/${patch.identifier}`,
      identifier: patch.identifier,
      path: patch.path,
      bytes: patch.bytes,
      sha256: patch.sha256,
      contentType,
      cacheControl: R2_IMMUTABLE_CACHE_CONTROL,
    };
  });

  return {
    blobId,
    entrypointKey: `${blobId}/master.m3u8`,
    quilt: {
      path: artifact.quilt.path,
      bytes: artifact.quilt.bytes,
      sha256: artifact.quilt.sha256,
    },
    objects,
  };
};

export const canonicalIndexBytes = (index: QuiltIndex): Uint8Array => {
  assertQuiltIndex(index);
  const ordered: QuiltIndex = {
    schema: index.schema,
    recordingId: index.recordingId,
    generation: index.generation,
    masterPlaylist: index.masterPlaylist,
    segmentTargetMs: index.segmentTargetMs,
    patchCount: index.patchCount,
    renditions: index.renditions.map((rendition) => ({
      id: rendition.id,
      codec: rendition.codec,
      nominalBitrate: rendition.nominalBitrate,
      averageBandwidth: rendition.averageBandwidth,
      peakBandwidth: rendition.peakBandwidth,
      sampleRateHz: rendition.sampleRateHz,
      channels: rendition.channels,
      playlist: rendition.playlist,
      init: {
        identifier: rendition.init.identifier,
        bytes: rendition.init.bytes,
        sha256: rendition.init.sha256,
      },
      segments: rendition.segments.map((segment) => ({
        sequence: segment.sequence,
        identifier: segment.identifier,
        durationMs: segment.durationMs,
        bytes: segment.bytes,
        sha256: segment.sha256,
      })),
    })),
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
};

export const canonicalIdentifiers = (index: QuiltIndex): readonly string[] => [
  "index.json",
  "master.m3u8",
  ...[...index.renditions]
    .sort((left, right) => left.nominalBitrate - right.nominalBitrate)
    .flatMap((rendition: RenditionDescriptor) => [
      rendition.playlist,
      rendition.init.identifier,
      ...[...rendition.segments]
        .sort((left, right) => left.sequence - right.sequence)
        .map((segment) => segment.identifier),
    ]),
];

export const orderPatches = (
  index: QuiltIndex,
  patches: readonly QuiltPatch[],
): readonly QuiltPatch[] => {
  const byIdentifier = new Map(
    patches.map((patch) => [patch.identifier, patch]),
  );
  const identifiers = canonicalIdentifiers(index);
  if (
    byIdentifier.size !== patches.length ||
    byIdentifier.size !== identifiers.length
  ) {
    throw new TypeError(
      "artifact inventory does not match canonical patch list",
    );
  }
  return identifiers.map((identifier) => {
    const patch = byIdentifier.get(identifier);
    if (patch === undefined)
      throw new TypeError(`missing patch: ${identifier}`);
    return patch;
  });
};
