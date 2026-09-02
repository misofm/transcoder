import { Parser } from "m3u8-parser";

export const MAX_PLAYLIST_BYTES = 1_048_576;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MediaSegment {
  readonly sequence: number;
  readonly durationMs: number;
  readonly identifier: string;
}

export interface MediaPlaylist {
  readonly version: number;
  readonly targetDuration: number;
  readonly mapIdentifier: string;
  readonly segments: readonly MediaSegment[];
  readonly lines: readonly string[];
}

const parseQuotedUri = (line: string): string | undefined => {
  const attributes = line.slice(line.indexOf(":") + 1);
  const match = /(?:^|,)URI="([^"]+)"(?:,|$)/.exec(attributes);
  return match?.[1];
};

export const assertSafeIdentifier = (value: string): void => {
  if (!SAFE_IDENTIFIER.test(value) || value.includes("..")) {
    throw new TypeError(`unsafe HLS identifier: ${value}`);
  }
};

export const parsePlaintextMediaPlaylist = (
  bytes: Uint8Array,
): MediaPlaylist => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLAYLIST_BYTES) {
    throw new RangeError("playlist size is outside the supported bounds");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (source.includes("\r"))
    throw new TypeError("playlists must use LF line endings");
  const lines = source.endsWith("\n")
    ? source.slice(0, -1).split("\n")
    : source.split("\n");
  if (lines[0] !== "#EXTM3U") throw new TypeError("missing EXTM3U header");

  // An independent parser must accept the playlist before stricter v1 checks.
  const parser = new Parser();
  parser.push(source);
  parser.end();
  if (!parser.manifest || !Array.isArray(parser.manifest.segments)) {
    throw new TypeError("HLS parser rejected media playlist");
  }

  let version: number | undefined;
  let targetDuration: number | undefined;
  let mediaSequence: number | undefined;
  let mapIdentifier: string | undefined;
  let endlist = false;
  let pendingDurationMs: number | undefined;
  const segments: MediaSegment[] = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-VERSION:")) version = Number(line.slice(15));
    else if (line.startsWith("#EXT-X-TARGETDURATION:"))
      targetDuration = Number(line.slice(22));
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:"))
      mediaSequence = Number(line.slice(22));
    else if (line.startsWith("#EXT-X-MAP:")) {
      if (mapIdentifier !== undefined)
        throw new TypeError("playlist must contain exactly one map");
      mapIdentifier = parseQuotedUri(line);
      if (mapIdentifier === undefined)
        throw new TypeError("map URI must be quoted");
      assertSafeIdentifier(mapIdentifier);
    } else if (line.startsWith("#EXTINF:")) {
      if (pendingDurationMs !== undefined)
        throw new TypeError("EXTINF has no media URI");
      const seconds = Number(line.slice(8).split(",", 1)[0]);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new TypeError("invalid EXTINF duration");
      pendingDurationMs = Math.round(seconds * 1_000);
    } else if (line === "#EXT-X-ENDLIST") endlist = true;
    else if (
      line.startsWith("#EXT-X-KEY:") ||
      line.startsWith("#EXT-X-BYTERANGE:") ||
      line === "#EXT-X-DISCONTINUITY"
    ) {
      throw new TypeError(
        `forbidden plaintext playlist tag: ${line.split(":", 1)[0]}`,
      );
    } else if (line !== "" && !line.startsWith("#")) {
      if (pendingDurationMs === undefined)
        throw new TypeError("media URI has no EXTINF");
      assertSafeIdentifier(line);
      if (!line.endsWith(".m4s"))
        throw new TypeError("media segments must use .m4s identifiers");
      segments.push({
        sequence: segments.length,
        durationMs: pendingDurationMs,
        identifier: line,
      });
      pendingDurationMs = undefined;
    }
  }
  if (version === undefined || !Number.isInteger(version) || version < 7)
    throw new TypeError("HLS v7+ required");
  if (
    targetDuration === undefined ||
    !Number.isInteger(targetDuration) ||
    targetDuration < 1
  ) {
    throw new TypeError("invalid target duration");
  }
  if (mediaSequence !== 0) throw new TypeError("media sequence must be zero");
  if (mapIdentifier === undefined)
    throw new TypeError("playlist map is required");
  if (!endlist) throw new TypeError("VOD playlist must end with ENDLIST");
  if (pendingDurationMs !== undefined || segments.length === 0)
    throw new TypeError("incomplete media playlist");
  const identifiers = new Set(segments.map((segment) => segment.identifier));
  if (identifiers.size !== segments.length)
    throw new TypeError("segment identifiers must be unique");
  return { version, targetDuration, mapIdentifier, segments, lines };
};
