import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { calculateBandwidth } from "../src/hls/bandwidth.js";
import { renderMasterPlaylist } from "../src/hls/master.js";
import {
  RENDITIONS,
  type FileDescriptor,
  type RenditionDescriptor,
  type TranscodeArtifact,
} from "../src/model.js";
import { verifyArtifact } from "../src/pipeline/verify.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const audio = {
  policyId: "miso.aac-codec-preview/1" as const,
  appliedGainCentiDb: 0,
  source: {
    integratedLoudnessCentiLufs: null,
    truePeakCentiDbtp: null,
    samplePeakCentiDbfs: null,
  },
  preview: [],
  output: [],
};
const toolchain = {
  ffmpegPath: "/ffmpeg",
  ffprobePath: "/ffprobe",
  ffmpegVersion: "test",
  ffmpegBuild: "test",
  ffprobeVersion: "test",
  ffprobeBuild: "test",
  configuration: "test",
  libavcodecVersion: "test",
  libavformatVersion: "test",
  capabilities: [],
  sha256: "b".repeat(64),
};

test("loose artifact verification enforces stable descriptors and detects tampering", async () => {
  const rootPath = await realpath(
    await mkdtemp(join(tmpdir(), "transcoder-artifact-")),
  );
  roots.push(rootPath);
  const describe = async (
    identifier: string,
    bytes: Uint8Array,
  ): Promise<FileDescriptor> => {
    const path = join(rootPath, identifier);
    await writeFile(path, bytes);
    return {
      identifier,
      path,
      contentType: identifier.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "audio/mp4",
      bytes: bytes.length,
      sha256: digest(bytes),
    };
  };
  const renditions: RenditionDescriptor[] = [];
  for (const rendition of RENDITIONS) {
    const init = await describe(
      `${rendition.id}-init.mp4`,
      new Uint8Array([0, 1, 2]),
    );
    const segmentFile = await describe(
      `${rendition.id}-00000.m4s`,
      new Uint8Array([3, 4, 5, 6]),
    );
    const segment = {
      ...segmentFile,
      contentType: "audio/mp4" as const,
      sequence: 0,
      durationMs: 6000,
    };
    const playlistBytes = new TextEncoder().encode(
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="${init.identifier}"\n#EXTINF:6.000,\n${segment.identifier}\n#EXT-X-ENDLIST\n`,
    );
    const playlist = await describe(`${rendition.id}.m3u8`, playlistBytes);
    renditions.push({
      id: rendition.id,
      codec: "mp4a.40.2",
      nominalBitrate: rendition.nominalBitrate,
      ...calculateBandwidth([segment]),
      sampleRateHz: 48000,
      channels: 2,
      playlist,
      init,
      segments: [segment],
    });
  }
  const masterPlaylist = await describe(
    "master.m3u8",
    renderMasterPlaylist(renditions),
  );
  const artifact: TranscodeArtifact = {
    transcodeDigest: "a".repeat(64),
    rootPath,
    segmentTargetMs: 6000,
    masterPlaylist,
    files: [
      masterPlaylist,
      ...renditions.flatMap((item) => [
        item.playlist,
        item.init,
        ...item.segments,
      ]),
    ],
    renditions,
    toolchain,
    audio,
  };
  const verified = await Effect.runPromise(verifyArtifact(artifact));
  expect(verified.verified).toBe(true);
  expect(verified.files.map((file) => file.identifier)).toEqual([
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
  const invalid = async (mutate: (copy: TranscodeArtifact) => void) => {
    const copy = structuredClone(artifact);
    mutate(copy);
    await expect(Effect.runPromise(verifyArtifact(copy))).rejects.toMatchObject(
      {
        _tag: "ArtifactValidationError",
      },
    );
  };
  await invalid((copy) => {
    (copy.masterPlaylist as { sha256: string }).sha256 = "f".repeat(64);
  });
  await invalid((copy) => {
    (copy.renditions[0]!.playlist as { bytes: number }).bytes += 1;
  });
  await invalid((copy) => {
    (copy.renditions[0]!.init as { path: string }).path = join(
      rootPath,
      "..",
      "outside.mp4",
    );
  });
  await invalid((copy) => {
    (copy.renditions[0]!.segments[0] as { sha256: string }).sha256 = "f".repeat(
      64,
    );
  });
  await invalid((copy) => {
    (copy.renditions[0] as { codec: string }).codec = "mp4a.40.5";
  });
  await invalid((copy) => {
    (copy.renditions[0] as { sampleRateHz: number }).sampleRateHz = 32_000;
  });
  await invalid((copy) => {
    (copy.renditions[0] as { channels: number }).channels = 1;
  });
  await writeFile(renditions[0]!.segments[0]!.path, "tampered");
  await expect(
    Effect.runPromise(verifyArtifact(artifact)),
  ).rejects.toMatchObject({ _tag: "ArtifactValidationError" });
});
