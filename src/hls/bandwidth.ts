export interface BandwidthSegment {
  readonly cipherBytes: number;
  readonly durationMs: number;
}

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

export const calculateBandwidth = (
  segments: readonly BandwidthSegment[],
): { readonly averageBandwidth: number; readonly peakBandwidth: number } => {
  if (segments.length === 0)
    throw new RangeError("at least one segment is required");
  let totalBytes = 0n;
  let totalDuration = 0n;
  let peak = 0n;
  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.cipherBytes) || segment.cipherBytes < 1) {
      throw new RangeError("invalid ciphertext size");
    }
    if (!Number.isSafeInteger(segment.durationMs) || segment.durationMs < 1) {
      throw new RangeError("invalid segment duration");
    }
    const bytes = BigInt(segment.cipherBytes);
    const duration = BigInt(segment.durationMs);
    totalBytes += bytes;
    totalDuration += duration;
    const bandwidth = ceilDiv(8n * bytes * 1_000n, duration);
    if (bandwidth > peak) peak = bandwidth;
  }
  const average = ceilDiv(8n * totalBytes * 1_000n, totalDuration);
  if (
    average > BigInt(Number.MAX_SAFE_INTEGER) ||
    peak > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError("bandwidth exceeds safe integer range");
  }
  return { averageBandwidth: Number(average), peakBandwidth: Number(peak) };
};
