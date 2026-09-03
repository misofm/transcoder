import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { Effect } from "effect";

import { ArtifactValidationError } from "../errors.js";
import { calculateBandwidth } from "../hls/bandwidth.js";
import { validateMasterPlaylist } from "../hls/master.js";
import { parsePlaintextMediaPlaylist } from "../hls/playlist.js";
import {
  RENDITIONS,
  type FileDescriptor,
  type TranscodeArtifact,
  type VerifiedArtifact,
} from "../model.js";

const failure = (subject: string, message: string) =>
  new ArtifactValidationError({
    code: "ARTIFACT_VALIDATION",
    phase: "verify",
    subject,
    message,
  });

const inspect = async (
  path: string,
  maximum = 256 * 1024 * 1024,
): Promise<{ bytes: number; sha256: string }> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum)
      throw failure(path, "Artifact file is outside its byte limit");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size)
        throw failure(path, "Artifact file grew during verification");
      hash.update(chunk);
    }
    if (bytes !== metadata.size)
      throw failure(path, "Artifact file changed during verification");
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};

const read = async (path: string): Promise<Uint8Array> => {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1_048_576)
      throw failure(path, "Playlist is outside its byte limit");
    const bytes = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (result.bytesRead === 0)
        throw failure(path, "Playlist changed during verification");
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const sameDescriptor = (
  actual: FileDescriptor,
  expected: FileDescriptor,
): boolean =>
  actual.identifier === expected.identifier &&
  actual.path === expected.path &&
  actual.contentType === expected.contentType &&
  actual.bytes === expected.bytes &&
  actual.sha256 === expected.sha256;

const verifyUnsafe = async (
  artifact: TranscodeArtifact,
): Promise<VerifiedArtifact> => {
  if (!/^[0-9a-f]{64}$/u.test(artifact.transcodeDigest))
    throw failure("transcodeDigest", "Transcode digest is invalid");
  if (
    !isAbsolute(artifact.rootPath) ||
    resolve(artifact.rootPath) !== artifact.rootPath ||
    (await realpath(artifact.rootPath)) !== artifact.rootPath
  )
    throw failure(artifact.rootPath, "Artifact root path is not canonical");
  const root = await lstat(artifact.rootPath);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw failure(artifact.rootPath, "Artifact root must be a real directory");
  const expectedIdentifiers = [
    "master.m3u8",
    ...artifact.renditions.flatMap((item) => [
      item.playlist.identifier,
      item.init.identifier,
      ...item.segments.map((segment) => segment.identifier),
    ]),
  ];
  if (
    new Set(expectedIdentifiers).size !== expectedIdentifiers.length ||
    artifact.files.length !== expectedIdentifiers.length
  )
    throw failure(
      artifact.rootPath,
      "Artifact descriptors are duplicated or incomplete",
    );
  const actualEntries = (
    await readdir(artifact.rootPath, { withFileTypes: true })
  )
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw failure(entry.name, "Artifact entries must be regular files");
      return entry.name;
    })
    .sort();
  if (actualEntries.join("\0") !== [...expectedIdentifiers].sort().join("\0"))
    throw failure(artifact.rootPath, "Artifact inventory mismatch");
  if (artifact.renditions.length !== RENDITIONS.length)
    throw failure("renditions", "Rendition set is incomplete");
  const verifiedFiles: FileDescriptor[] = [];
  for (let index = 0; index < expectedIdentifiers.length; index += 1) {
    const identifier = expectedIdentifiers[index]!;
    const declared = artifact.files[index];
    if (
      declared?.identifier !== identifier ||
      declared.path !== join(artifact.rootPath, identifier)
    )
      throw failure(identifier, "File order or path is not canonical");
    const measured = await inspect(
      declared.path,
      identifier.endsWith(".m3u8") ? 1_048_576 : undefined,
    );
    const expected: FileDescriptor = { ...declared, ...measured };
    if (!sameDescriptor(declared, expected))
      throw failure(identifier, "File size or digest mismatch");
    const contentType = identifier.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "audio/mp4";
    if (declared.contentType !== contentType)
      throw failure(identifier, "File content type mismatch");
    verifiedFiles.push(declared);
  }
  const canonicalFiles = new Map(
    verifiedFiles.map((descriptor) => [descriptor.identifier, descriptor]),
  );
  const canonicalMaster = canonicalFiles.get("master.m3u8");
  if (
    canonicalMaster === undefined ||
    !sameDescriptor(artifact.masterPlaylist, canonicalMaster)
  )
    throw failure("master.m3u8", "Master descriptor is not canonical");
  validateMasterPlaylist(
    await read(join(artifact.rootPath, "master.m3u8")),
    artifact.renditions,
  );
  const segmentCounts: number[] = [];
  for (let position = 0; position < artifact.renditions.length; position += 1) {
    const rendition = artifact.renditions[position]!;
    const expected = RENDITIONS[position]!;
    if (
      rendition.id !== expected.id ||
      rendition.nominalBitrate !== expected.nominalBitrate ||
      rendition.codec !== "mp4a.40.2" ||
      (rendition.sampleRateHz !== 44_100 &&
        rendition.sampleRateHz !== 48_000) ||
      rendition.channels !== 2
    )
      throw failure(rendition.id, "Rendition ladder metadata mismatch");
    const canonicalPlaylist = canonicalFiles.get(`${rendition.id}.m3u8`);
    const canonicalInit = canonicalFiles.get(`${rendition.id}-init.mp4`);
    if (
      canonicalPlaylist === undefined ||
      canonicalInit === undefined ||
      !sameDescriptor(rendition.playlist, canonicalPlaylist) ||
      !sameDescriptor(rendition.init, canonicalInit)
    )
      throw failure(
        rendition.id,
        "Nested rendition descriptors are not canonical",
      );
    const playlist = parsePlaintextMediaPlaylist(
      await read(rendition.playlist.path),
    );
    if (
      playlist.mapIdentifier !== rendition.init.identifier ||
      playlist.segments.length !== rendition.segments.length
    )
      throw failure(rendition.id, "Playlist descriptor mismatch");
    for (let sequence = 0; sequence < playlist.segments.length; sequence += 1) {
      const parsed = playlist.segments[sequence]!;
      const segment = rendition.segments[sequence]!;
      const canonicalSegment = canonicalFiles.get(segment.identifier);
      if (
        canonicalSegment === undefined ||
        !sameDescriptor(segment, canonicalSegment) ||
        segment.sequence !== sequence ||
        segment.identifier !==
          `${rendition.id}-${String(sequence).padStart(5, "0")}.m4s` ||
        parsed.sequence !== segment.sequence ||
        parsed.identifier !== segment.identifier ||
        parsed.durationMs !== segment.durationMs
      )
        throw failure(segment.identifier, "Segment timeline mismatch");
    }
    const bandwidth = calculateBandwidth(rendition.segments);
    if (
      bandwidth.averageBandwidth !== rendition.averageBandwidth ||
      bandwidth.peakBandwidth !== rendition.peakBandwidth
    )
      throw failure(rendition.id, "Stored-byte bandwidth mismatch");
    segmentCounts.push(rendition.segments.length);
  }
  if (!segmentCounts.every((count) => count === segmentCounts[0]))
    throw failure("renditions", "Rendition segment counts differ");
  if (
    !artifact.renditions.every(
      (rendition) =>
        rendition.sampleRateHz === artifact.renditions[0]?.sampleRateHz,
    )
  )
    throw failure("renditions", "Rendition sample rates differ");
  for (let sequence = 0; sequence < (segmentCounts[0] ?? 0); sequence += 1) {
    const durations = artifact.renditions.map(
      (item) => item.segments[sequence]?.durationMs,
    );
    if (!durations.every((duration) => duration === durations[0]))
      throw failure("renditions", "Rendition timelines differ");
  }
  return { ...artifact, files: verifiedFiles, verified: true };
};

export const verifyArtifact = (
  artifact: TranscodeArtifact,
): Effect.Effect<VerifiedArtifact, ArtifactValidationError> =>
  Effect.tryPromise({
    try: () => verifyUnsafe(artifact),
    catch: (error) =>
      error instanceof ArtifactValidationError
        ? error
        : failure(artifact.rootPath, "Artifact verification failed"),
  });
