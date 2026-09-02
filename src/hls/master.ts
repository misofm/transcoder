import type { RenditionDescriptor } from "../model.js";

export const renderMasterPlaylist = (
  renditions: readonly RenditionDescriptor[],
): Uint8Array => {
  const sorted = [...renditions].sort(
    (left, right) => left.nominalBitrate - right.nominalBitrate,
  );
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const rendition of sorted) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.peakBandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth},CODECS="mp4a.40.2"`,
      rendition.playlist,
    );
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
};

export const validateMasterPlaylist = (
  bytes: Uint8Array,
  renditions: readonly RenditionDescriptor[],
): void => {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    !Buffer.from(renderMasterPlaylist(renditions)).equals(Buffer.from(bytes))
  ) {
    throw new TypeError(
      "master playlist does not match measured rendition descriptors",
    );
  }
  if (!source.endsWith("\n"))
    throw new TypeError("master playlist must end with LF");
};
