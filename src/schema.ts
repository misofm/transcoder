import schemaDocument from "../docs/aac-transcode-quilt-v1.schema.json" with { type: "json" };

import { MAX_PATCHES, patchCountForSegments } from "./profile.js";
import {
  RENDITIONS,
  SCHEMA_ID,
  type QuiltIndex,
  type RenditionDescriptor,
} from "./model.js";
import { calculateBandwidth } from "./hls/bandwidth.js";

export const aacTranscodeQuiltV1Schema = schemaDocument;

const OBJECT_ID = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const assertNoDuplicateJsonKeys = (source: string): void => {
  let position = 0;
  const whitespace = () => {
    while (/\s/u.test(source[position] ?? "")) position += 1;
  };
  const string = (): string => {
    const start = position;
    if (source[position++] !== '"') throw new SyntaxError("expected string");
    let escaped = false;
    while (position < source.length) {
      const character = source[position++]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"')
        return JSON.parse(source.slice(start, position)) as string;
      if (character < " ") throw new SyntaxError("invalid string");
    }
    throw new SyntaxError("unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new SyntaxError("JSON nesting exceeds limit");
    whitespace();
    const character = source[position];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{") {
      position += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[position] === "}") {
        position += 1;
        return;
      }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new SyntaxError("duplicate JSON object key");
        keys.add(key);
        whitespace();
        if (source[position++] !== ":") throw new SyntaxError("expected colon");
        value(depth + 1);
        whitespace();
        const delimiter = source[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",")
          throw new SyntaxError("expected object delimiter");
      }
    }
    if (character === "[") {
      position += 1;
      whitespace();
      if (source[position] === "]") {
        position += 1;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const delimiter = source[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",")
          throw new SyntaxError("expected array delimiter");
      }
    }
    const match =
      /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(
        source.slice(position),
      );
    if (match === null) throw new SyntaxError("invalid JSON value");
    position += match[0].length;
  };
  value(0);
  whitespace();
  if (position !== source.length) throw new SyntaxError("trailing JSON data");
};

const exactKeys = (value: object, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
};

const safeInteger = (
  value: unknown,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= minimum &&
  value <= maximum;

const validateFile = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  exactKeys(value, ["identifier", "bytes", "sha256"]) &&
  typeof (value as Record<string, unknown>).identifier === "string" &&
  IDENTIFIER.test((value as Record<string, unknown>).identifier as string) &&
  safeInteger((value as Record<string, unknown>).bytes, 1) &&
  typeof (value as Record<string, unknown>).sha256 === "string" &&
  SHA256.test((value as Record<string, unknown>).sha256 as string);

const validateRendition = (
  value: unknown,
  expected: (typeof RENDITIONS)[number],
): value is RenditionDescriptor => {
  if (typeof value !== "object" || value === null) return false;
  const rendition = value as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "id",
      "codec",
      "nominalBitrate",
      "averageBandwidth",
      "peakBandwidth",
      "sampleRateHz",
      "channels",
      "playlist",
      "init",
      "segments",
    ]) ||
    rendition.id !== expected.id ||
    rendition.codec !== "mp4a.40.2" ||
    rendition.nominalBitrate !== expected.nominalBitrate ||
    !safeInteger(rendition.averageBandwidth, 1, 1_000_000) ||
    !safeInteger(rendition.peakBandwidth, 1, 1_000_000) ||
    (rendition.sampleRateHz !== 44_100 && rendition.sampleRateHz !== 48_000) ||
    rendition.channels !== 2 ||
    rendition.playlist !== `${expected.id}.m3u8` ||
    !validateFile(rendition.init) ||
    (rendition.init as Record<string, unknown>).identifier !==
      `${expected.id}-init.mp4` ||
    !Array.isArray(rendition.segments) ||
    rendition.segments.length < 1 ||
    rendition.segments.length > 219
  )
    return false;
  const seen = new Set<string>();
  return rendition.segments.every((item, index) => {
    if (typeof item !== "object" || item === null) return false;
    const segment = item as Record<string, unknown>;
    const valid =
      exactKeys(item, [
        "sequence",
        "identifier",
        "durationMs",
        "bytes",
        "sha256",
      ]) &&
      segment.sequence === index &&
      segment.identifier ===
        `${expected.id}-${String(index).padStart(5, "0")}.m4s` &&
      safeInteger(segment.durationMs, 1, 10_000) &&
      safeInteger(segment.bytes, 1) &&
      typeof segment.sha256 === "string" &&
      SHA256.test(segment.sha256);
    if (!valid || seen.has(segment.identifier as string)) return false;
    seen.add(segment.identifier as string);
    return true;
  });
};

export const assertQuiltIndex: (
  value: unknown,
) => asserts value is QuiltIndex = (value) => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("index must be an object");
  const index = value as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "schema",
      "recordingId",
      "generation",
      "masterPlaylist",
      "segmentTargetMs",
      "patchCount",
      "renditions",
    ])
  ) {
    throw new TypeError("index contains missing or unknown fields");
  }
  if (
    index.schema !== SCHEMA_ID ||
    typeof index.recordingId !== "string" ||
    !OBJECT_ID.test(index.recordingId) ||
    typeof index.generation !== "string" ||
    !GENERATION.test(index.generation) ||
    index.masterPlaylist !== "master.m3u8" ||
    !safeInteger(index.segmentTargetMs, 1_000, 10_000) ||
    !safeInteger(index.patchCount, 11, MAX_PATCHES) ||
    !Array.isArray(index.renditions) ||
    index.renditions.length !== RENDITIONS.length
  )
    throw new TypeError("index does not satisfy the AAC Quilt v1 schema");
  const generationBytes = Buffer.from(index.generation as string, "base64url");
  if (
    generationBytes.byteLength !== 32 ||
    generationBytes.toString("base64url") !== index.generation
  ) {
    throw new TypeError("generation identity is not canonical base64url");
  }
  index.renditions.forEach((rendition, position) => {
    const expected = RENDITIONS[position];
    if (expected === undefined || !validateRendition(rendition, expected))
      throw new TypeError("invalid rendition");
  });
  const lengths = (index.renditions as readonly RenditionDescriptor[]).map(
    (rendition) => rendition.segments.length,
  );
  if (!lengths.every((length) => length === lengths[0]))
    throw new TypeError("rendition segment counts differ");
  const expectedPatchCount = patchCountForSegments(lengths[0] ?? 0);
  if (index.patchCount !== expectedPatchCount)
    throw new TypeError("derived patch count mismatch");
  const validatedRenditions =
    index.renditions as readonly RenditionDescriptor[];
  if (
    !validatedRenditions.every(
      (rendition) =>
        rendition.sampleRateHz === validatedRenditions[0]?.sampleRateHz,
    )
  )
    throw new TypeError("rendition sample rates differ");
  if (
    !validatedRenditions.every((rendition) => {
      const measured = calculateBandwidth(rendition.segments);
      return (
        rendition.averageBandwidth === measured.averageBandwidth &&
        rendition.peakBandwidth === measured.peakBandwidth
      );
    })
  )
    throw new TypeError("measured bandwidth mismatch");
  for (let sequence = 0; sequence < (lengths[0] ?? 0); sequence += 1) {
    const durations = validatedRenditions.map(
      (rendition) => rendition.segments[sequence]?.durationMs,
    );
    if (!durations.every((duration) => duration === durations[0]))
      throw new TypeError("rendition timelines differ");
    if (
      sequence < (lengths[0] ?? 0) - 1 &&
      Math.abs((durations[0] ?? 0) - (index.segmentTargetMs as number)) >
        Math.ceil(
          (1_024 * 1_000) /
            (validatedRenditions[0]?.sampleRateHz ?? Number.NaN),
        )
    )
      throw new TypeError(
        "non-final segment is outside one AAC frame of target",
      );
    if (
      sequence === (lengths[0] ?? 0) - 1 &&
      (durations[0] ?? 0) >
        Math.min(
          10_000,
          (index.segmentTargetMs as number) +
            Math.ceil(
              (1_024 * 1_000) /
                (validatedRenditions[0]?.sampleRateHz ?? Number.NaN),
            ),
        )
    )
      throw new TypeError("final segment exceeds target plus one AAC frame");
  }
  const allIdentifiers = [
    "index.json",
    "master.m3u8",
    ...(index.renditions as readonly RenditionDescriptor[]).flatMap(
      (rendition) => [
        rendition.playlist,
        rendition.init.identifier,
        ...rendition.segments.map((segment) => segment.identifier),
      ],
    ),
  ];
  if (new Set(allIdentifiers).size !== allIdentifiers.length)
    throw new TypeError("duplicate artifact identifier");
};

export const parseQuiltIndex = (bytes: Uint8Array): QuiltIndex => {
  if (bytes.byteLength === 0 || bytes.byteLength > 4_194_304)
    throw new RangeError("index size outside supported bounds");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  assertQuiltIndex(value);
  return value;
};
