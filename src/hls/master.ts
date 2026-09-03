import type { RenditionDescriptor } from "../model.js";
import { Parser } from "m3u8-parser";

export const assertMasterPlaylistParses = (bytes: Uint8Array): void => {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\r") || !source.endsWith("\n"))
    throw new TypeError("master playlist must use LF and end with LF");
  const parser = new Parser();
  parser.push(source);
  parser.end();
  if (
    !parser.manifest ||
    !Array.isArray(parser.manifest.playlists) ||
    parser.manifest.playlists.length !== 3
  )
    throw new TypeError("independent HLS parser rejected master playlist");
};

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
      rendition.playlist.identifier,
    );
  }
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
};

export const validateMasterPlaylist = (
  bytes: Uint8Array,
  renditions: readonly RenditionDescriptor[],
): void => {
  assertMasterPlaylistParses(bytes);
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
