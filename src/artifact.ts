import { createHash } from "node:crypto";

import type { QuiltIndex, QuiltPatch, RenditionDescriptor } from "./model.js";
import { assertQuiltIndex } from "./schema.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

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
