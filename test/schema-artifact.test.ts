import { expect, test } from "bun:test";

import { canonicalIdentifiers, canonicalIndexBytes } from "../src/artifact.js";
import {
  RENDITIONS,
  SCHEMA_ID,
  type QuiltIndex,
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
        plainBytes: 16,
        cipherBytes: 32,
        ciphertextSha256: hash,
      },
    ],
  }),
);

const index: QuiltIndex = {
  schema: SCHEMA_ID,
  network: "testnet",
  recordingId: `0x${hash}`,
  generation: "A".repeat(43),
  masterPlaylist: "master.m3u8",
  segmentTargetMs: 6000,
  patchCount: 11,
  encryption: {
    scheme: "hls-aes-128-cbc-hkdf/1",
    kdf: "hkdf-sha256",
    rootKeyBytes: 32,
    keyId: hash,
  },
  renditions,
};

test("serializes strict index and canonical patch ordering", () => {
  const bytes = canonicalIndexBytes(index);
  expect(new TextDecoder().decode(bytes).endsWith("\n")).toBe(true);
  expect(parseQuiltIndex(bytes)).toEqual(index);
  expect(canonicalIdentifiers(index)).toEqual([
    "index.json",
    "master.m3u8",
    "aac-096.m3u8",
    "aac-096-init.mp4",
    "aac-096-00000.m4s",
    "aac-160.m3u8",
    "aac-160-init.mp4",
    "aac-160-00000.m4s",
    "aac-256.m3u8",
    "aac-256-init.mp4",
    "aac-256-00000.m4s",
  ]);
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
