import { createHash } from "node:crypto";

import type { QuiltIndex, QuiltPatch, RenditionDescriptor } from "./model.js";
import { assertQuiltIndex } from "./schema.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const canonicalIndexBytes = (index: QuiltIndex): Uint8Array => {
  assertQuiltIndex(index);
  const ordered: QuiltIndex = {
    schema: index.schema,
    network: index.network,
    recordingId: index.recordingId,
    generation: index.generation,
    masterPlaylist: index.masterPlaylist,
    key: {
      identifier: index.key.identifier,
      bytes: index.key.bytes,
      sha256: index.key.sha256,
    },
    segmentTargetMs: index.segmentTargetMs,
    patchCount: index.patchCount,
    encryption: {
      scheme: index.encryption.scheme,
      kdf: index.encryption.kdf,
      sealPlaintextBytes: index.encryption.sealPlaintextBytes,
    },
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
        plainBytes: segment.plainBytes,
        cipherBytes: segment.cipherBytes,
        ciphertextSha256: segment.ciphertextSha256,
      })),
    })),
  };
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
};

export const canonicalIdentifiers = (index: QuiltIndex): readonly string[] => [
  "index.json",
  "master.m3u8",
  "key.seal",
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
