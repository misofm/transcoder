export const RENDITIONS = [
  { id: "aac-96", nominalBitrate: 96_000 },
  { id: "aac-160", nominalBitrate: 160_000 },
  { id: "aac-256", nominalBitrate: 256_000 },
] as const;

export type RenditionId = (typeof RENDITIONS)[number]["id"];

export interface TranscodeProfile {
  readonly segmentTargetMs?: number;
  /** Optional consumer bound; it is not tied to any packaging format. */
  readonly maxSegmentsPerRendition?: number;
}

export interface TranscodeRequest {
  readonly inputPath: string;
  readonly workspacePath: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly profile?: TranscodeProfile;
  readonly fresh?: boolean;
  readonly recoverStaleLock?: boolean;
  readonly fileConcurrency?: number;
}

/** @internal Preparation is an implementation checkpoint, not publication metadata. */
export interface PrepareRequest
  extends Omit<TranscodeRequest, "fileConcurrency"> {}

/** @internal */
export interface FinalizeRequest {
  readonly prepared: PreparedTranscode;
  readonly fresh?: boolean;
  readonly fileConcurrency?: number;
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

export interface AudioMeasurement {
  readonly integratedLoudnessCentiLufs: number | null;
  readonly truePeakCentiDbtp: number | null;
  readonly samplePeakCentiDbfs: number | null;
}

export interface RenditionAudioMeasurement extends AudioMeasurement {
  readonly id: RenditionId;
}

export interface PreparedAudioEvidence {
  readonly policyId: "miso.aac-codec-preview/1";
  readonly appliedGainCentiDb: number;
  readonly source: AudioMeasurement;
  readonly preview: readonly RenditionAudioMeasurement[];
  readonly output: readonly RenditionAudioMeasurement[];
}

export interface PreparedTranscode {
  readonly prepareDigest: string;
  readonly resultDigest: string;
  readonly rootPath: string;
  readonly sourceSha256: string;
  readonly durationMs: number;
  readonly sampleRateHz: 44100 | 48000;
  readonly segmentTargetMs: number;
  readonly toolchain: ToolchainFingerprint;
  readonly audio: PreparedAudioEvidence;
}

export interface FileDescriptor {
  readonly identifier: string;
  readonly path: string;
  readonly contentType: "application/vnd.apple.mpegurl" | "audio/mp4";
  readonly bytes: number;
  readonly sha256: string;
}

export interface SegmentDescriptor extends FileDescriptor {
  readonly sequence: number;
  readonly durationMs: number;
  readonly contentType: "audio/mp4";
}

export interface RenditionDescriptor {
  readonly id: RenditionId;
  readonly codec: "mp4a.40.2";
  readonly nominalBitrate: 96000 | 160000 | 256000;
  readonly averageBandwidth: number;
  readonly peakBandwidth: number;
  readonly sampleRateHz: 44100 | 48000;
  readonly channels: 2;
  readonly playlist: FileDescriptor;
  readonly init: FileDescriptor;
  readonly segments: readonly SegmentDescriptor[];
}

export interface TranscodeArtifact {
  readonly transcodeDigest: string;
  readonly rootPath: string;
  readonly segmentTargetMs: number;
  readonly masterPlaylist: FileDescriptor;
  /** Stable order: master, then each rendition's playlist, init, and segments. */
  readonly files: readonly FileDescriptor[];
  readonly renditions: readonly RenditionDescriptor[];
  readonly toolchain: ToolchainFingerprint;
  readonly audio: PreparedAudioEvidence;
}

export interface VerifiedArtifact extends TranscodeArtifact {
  readonly verified: true;
}
