export const DEFAULT_SEGMENT_TARGET_MS = 6_000;
export const MAX_SEGMENT_TARGET_MS = 10_000;
export const AAC_FRAME_SAMPLES = 1_024;

export const conservativeSegmentCount = (
  durationMs: number,
  targetMs: number,
): number =>
  Math.ceil(
    (durationMs + Math.ceil((AAC_FRAME_SAMPLES * 1_000) / 44_100)) / targetMs,
  );

export const chooseSegmentTargetMs = (
  durationMs: number,
  maxSegmentsPerRendition = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(maxSegmentsPerRendition) ||
    maxSegmentsPerRendition < 1
  )
    return undefined;
  for (
    let target = DEFAULT_SEGMENT_TARGET_MS;
    target <= MAX_SEGMENT_TARGET_MS;
    target += 1
  ) {
    if (conservativeSegmentCount(durationMs, target) <= maxSegmentsPerRendition)
      return target;
  }
  return undefined;
};
