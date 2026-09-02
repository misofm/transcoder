export const SCHEMA_ID = "miso.aac-transcode-quilt/1" as const;
export const RENDITIONS = [
  { id: "aac-096", nominalBitrate: 96_000 },
  { id: "aac-160", nominalBitrate: 160_000 },
  { id: "aac-256", nominalBitrate: 256_000 },
] as const;

export type RenditionId = (typeof RENDITIONS)[number]["id"];
export type Network = "testnet" | "mainnet";

export interface GenerationMaterial {
  readonly generationNonce: Uint8Array;
  readonly rootKey: Uint8Array;
}

export interface TranscodeProfile {
  readonly segmentTargetMs?: number;
  readonly encryptionConcurrency?: number;
}

export interface PrepareRequest {
  readonly inputPath: string;
  readonly workspacePath: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly profile?: TranscodeProfile;
  readonly fresh?: boolean;
  readonly recoverStaleLock?: boolean;
}

export interface FinalizeRequest {
  readonly prepared: PreparedTranscode;
  readonly recordingId: string;
  readonly network: Network;
  readonly fresh?: boolean;
  readonly encryptionConcurrency?: number;
}

export interface ToolchainFingerprint {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly ffmpegVersion: string;
  readonly ffmpegBuild: string;
  readonly ffprobeVersion: string;
  readonly ffprobeBuild: string;
  readonly configuration: string;
  readonly libavcodecVersion: string;
  readonly libavformatVersion: string;
  readonly capabilities: readonly string[];
  readonly sha256: string;
}

export interface PreparedTranscode {
  readonly prepareDigest: string;
  readonly rootPath: string;
  readonly sourceSha256: string;
  readonly durationMs: number;
  readonly sampleRateHz: 44100 | 48000;
  readonly segmentTargetMs: number;
  readonly toolchain: ToolchainFingerprint;
}

export interface FileDescriptor {
  readonly identifier: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SegmentDescriptor {
  readonly sequence: number;
  readonly identifier: string;
  readonly durationMs: number;
  readonly plainBytes: number;
  readonly cipherBytes: number;
  readonly ciphertextSha256: string;
}

export interface RenditionDescriptor {
  readonly id: RenditionId;
  readonly codec: "mp4a.40.2";
  readonly nominalBitrate: 96000 | 160000 | 256000;
  readonly averageBandwidth: number;
  readonly peakBandwidth: number;
  readonly sampleRateHz: 44100 | 48000;
  readonly channels: 2;
  readonly playlist: string;
  readonly init: FileDescriptor;
  readonly segments: readonly SegmentDescriptor[];
}

export interface QuiltIndex {
  readonly schema: typeof SCHEMA_ID;
  readonly network: Network;
  readonly recordingId: string;
  readonly generation: string;
  readonly masterPlaylist: "master.m3u8";
  readonly segmentTargetMs: number;
  readonly patchCount: number;
  readonly encryption: {
    readonly scheme: "hls-aes-128-cbc-hkdf/1";
    readonly kdf: "hkdf-sha256";
    readonly rootKeyBytes: 32;
    readonly keyId: string;
  };
  readonly renditions: readonly RenditionDescriptor[];
}

export interface QuiltPatch {
  readonly identifier: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface QuiltArtifact {
  readonly generationDigest: string;
  readonly rootPath: string;
  readonly indexPath: string;
  readonly indexBytes: Uint8Array;
  readonly indexSha256: string;
  readonly patchCount: number;
  readonly patches: readonly QuiltPatch[];
  readonly toolchain: ToolchainFingerprint;
}

export interface VerifiedArtifact extends QuiltArtifact {
  readonly verified: true;
}
