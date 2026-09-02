export const MAX_PATCHES = 666;
export const FIXED_PATCHES = 2;
export const RENDITION_FIXED_PATCHES = 2;
export const MAX_SEGMENTS_PER_RENDITION = 219;
export const DEFAULT_SEGMENT_TARGET_MS = 6_000;
export const MAX_SEGMENT_TARGET_MS = 10_000;
export const AAC_FRAME_SAMPLES = 1_024;

/** Conservative count includes one encoder-delay/rounding segment. */
export const conservativeSegmentCount = (
  durationMs: number,
  targetMs: number,
): number =>
  Math.ceil(
    (durationMs + Math.ceil((AAC_FRAME_SAMPLES * 1_000) / 44_100)) / targetMs,
  );

export const patchCountForSegments = (segmentsPerRendition: number): number =>
  FIXED_PATCHES + 3 * (RENDITION_FIXED_PATCHES + segmentsPerRendition);

export const chooseSegmentTargetMs = (
  durationMs: number,
): number | undefined => {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return undefined;
  for (
    let target = DEFAULT_SEGMENT_TARGET_MS;
    target <= MAX_SEGMENT_TARGET_MS;
    target += 1
  ) {
    const count = conservativeSegmentCount(durationMs, target);
    if (
      count <= MAX_SEGMENTS_PER_RENDITION &&
      patchCountForSegments(count) <= MAX_PATCHES
    ) {
      return target;
    }
  }
  return undefined;
};
