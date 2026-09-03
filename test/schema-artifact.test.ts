import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  canonicalIdentifiers,
  canonicalIndexBytes,
  createR2UploadManifest,
  R2_IMMUTABLE_CACHE_CONTROL,
} from "../src/artifact.js";
import {
  RENDITIONS,
  SCHEMA_ID,
  type QuiltIndex,
  type VerifiedArtifact,
  type RenditionDescriptor,
} from "../src/model.js";
import { assertQuiltIndex, parseQuiltIndex } from "../src/schema.js";

const hash = "00".repeat(32);
const renditions = RENDITIONS.map(
  (profile): RenditionDescriptor => ({
    id: profile.id,
    codec: "mp4a.40.2",
    nominalBitrate: profile.nominalBitrate,
    averageBandwidth: 43,
    peakBandwidth: 43,
    sampleRateHz: 48_000,
    channels: 2,
    playlist: `${profile.id}.m3u8`,
    init: { identifier: `${profile.id}-init.mp4`, bytes: 1, sha256: hash },
    segments: [
      {
        sequence: 0,
        identifier: `${profile.id}-00000.m4s`,
        durationMs: 6000,
        bytes: 32,
        sha256: hash,
      },
    ],
  }),
);

const index: QuiltIndex = {
  schema: SCHEMA_ID,
  recordingId: `0x${hash}`,
  generation: "A".repeat(43),
  masterPlaylist: "master.m3u8",
  segmentTargetMs: 6000,
  patchCount: 11,
  renditions,
};

test("JSON schema permits canonical unpadded rendition identifiers", async () => {
  const schema = await readFile(
    new URL("../docs/aac-transcode-quilt-v1.schema.json", import.meta.url),
    "utf8",
  );
  expect(schema).toContain('"pattern": "^aac-[1-9][0-9]{0,4}$"');
  expect(schema).not.toContain('"pattern": "^aac-[0-9]{3}$"');
});

test("serializes strict index and canonical patch ordering", () => {
  const bytes = canonicalIndexBytes(index);
  expect(new TextDecoder().decode(bytes).endsWith("\n")).toBe(true);
  expect(parseQuiltIndex(bytes)).toEqual(index);
  expect(canonicalIdentifiers(index)).toEqual([
    "index.json",
    "master.m3u8",
    "aac-96.m3u8",
    "aac-96-init.mp4",
    "aac-96-00000.m4s",
    "aac-160.m3u8",
    "aac-160-init.mp4",
    "aac-160-00000.m4s",
    "aac-256.m3u8",
    "aac-256-init.mp4",
    "aac-256-00000.m4s",
  ]);
});

test("maps a verified artifact to blob-addressed R2 keys with master last", () => {
  const blobId = "D3hKmYKIYcI_MYjGgBRUc91HqVbUPajk680zsWmmj8I";
  const patches = canonicalIdentifiers(index).map((identifier) => ({
    identifier,
    path: `/artifact/${identifier}`,
    bytes: 1,
    sha256: hash,
    tags: {
      "content-type": identifier.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : identifier.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "audio/mp4",
    },
  }));
  const artifact = {
    verified: true,
    rootPath: "/artifact",
    indexPath: "/artifact/index.json",
    indexBytes: canonicalIndexBytes(index),
    indexSha256: "",
    patchCount: index.patchCount,
    patches,
    quilt: {
      path: "/artifact/quilt.blob",
      bytes: 2,
      sha256: hash,
    },
  } as unknown as VerifiedArtifact;
  Object.assign(artifact, {
    indexSha256: new Bun.CryptoHasher("sha256")
      .update(artifact.indexBytes)
      .digest("hex"),
  });
  patches[0] = {
    ...patches[0]!,
    bytes: artifact.indexBytes.byteLength,
    sha256: artifact.indexSha256,
  };
  const manifest = createR2UploadManifest(artifact, blobId);

  expect(manifest.entrypointKey).toBe(`${blobId}/master.m3u8`);
  expect(manifest.objects).toHaveLength(index.patchCount);
  expect(manifest.objects[0]?.key).toBe(`${blobId}/index.json`);
  expect(manifest.objects.at(-1)?.key).toBe(`${blobId}/master.m3u8`);
  expect(
    manifest.objects.every(
      (object) => object.cacheControl === R2_IMMUTABLE_CACHE_CONTROL,
    ),
  ).toBe(true);
  expect(
    manifest.objects.some((object) => object.key.endsWith("quilt.blob")),
  ).toBe(false);
  expect(manifest.quilt).toEqual(artifact.quilt);
  expect(() => createR2UploadManifest(artifact, "not-a-blob-id")).toThrow();
  expect(() =>
    createR2UploadManifest(artifact, `${"A".repeat(42)}B`),
  ).toThrow();
  expect(() =>
    createR2UploadManifest(
      {
        ...artifact,
        patches: [
          ...artifact.patches,
          {
            identifier: "../overwrite",
            path: "/artifact/../overwrite",
            bytes: -1,
            sha256: "bad",
            tags: { "content-type": "application/octet-stream" },
          },
        ],
      },
      blobId,
    ),
  ).toThrow();
});

test("rejects unknown keys and cross-field mismatches", () => {
  expect(() => assertQuiltIndex({ ...index, extra: true })).toThrow();
  expect(() => assertQuiltIndex({ ...index, patchCount: 12 })).toThrow();
  expect(() =>
    assertQuiltIndex({ ...index, renditions: renditions.slice(0, 2) }),
  ).toThrow();
  expect(() =>
    assertQuiltIndex({ ...index, recordingId: `0x${"AA".repeat(32)}` }),
  ).toThrow();
  expect(() =>
    assertQuiltIndex({
      ...index,
      renditions: renditions.map((rendition, position) =>
        position === 1 ? { ...rendition, sampleRateHz: 44_100 } : rendition,
      ),
    }),
  ).toThrow();
  const twoSegments = renditions.map((rendition) => ({
    ...rendition,
    segments: [
      { ...rendition.segments[0]!, durationMs: 5_900 },
      {
        ...rendition.segments[0]!,
        sequence: 1,
        identifier: `${rendition.id}-00001.m4s`,
        durationMs: 100,
      },
    ],
  }));
  expect(() =>
    assertQuiltIndex({ ...index, patchCount: 14, renditions: twoSegments }),
  ).toThrow();
  expect(() =>
    assertQuiltIndex({
      ...index,
      renditions: renditions.map((rendition) => ({
        ...rendition,
        averageBandwidth: 26,
        peakBandwidth: 26,
        segments: [{ ...rendition.segments[0]!, durationMs: 10_000 }],
      })),
    }),
  ).toThrow();
  const duplicate = new TextEncoder().encode(
    new TextDecoder()
      .decode(canonicalIndexBytes(index))
      .replace(
        '"schema": "miso.aac-transcode-quilt/1",',
        '"schema": "miso.aac-transcode-quilt/1",\n  "schema": "miso.aac-transcode-quilt/1",',
      ),
  );
  expect(() => parseQuiltIndex(duplicate)).toThrow();
});
