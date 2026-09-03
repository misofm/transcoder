import { describe, expect, test } from "bun:test";

import { calculateBandwidth } from "../src/hls/bandwidth.js";
import { parsePlaintextMediaPlaylist } from "../src/hls/playlist.js";
import { assertMasterPlaylistParses } from "../src/hls/master.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const valid =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="aac-096-init.mp4"\n#EXTINF:6.000,\naac-096-00000.m4s\n#EXTINF:1.500,\naac-096-00001.m4s\n#EXT-X-ENDLIST\n';

describe("strict HLS processing", () => {
  test("accepts a three-level master through an independent parser", () => {
    expect(() =>
      assertMasterPlaylistParses(
        bytes(
          '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=96000,CODECS="mp4a.40.2"\naac-096.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2"\naac-160.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"\naac-256.m3u8\n',
        ),
      ),
    ).not.toThrow();
  });
  test("parses the plaintext media playlist without rewriting it", () => {
    const playlist = parsePlaintextMediaPlaylist(bytes(valid));
    expect(playlist.segments.map((segment) => segment.durationMs)).toEqual([
      6000, 1500,
    ]);
    expect(playlist.mapIdentifier).toBe("aac-096-init.mp4");
  });

  test.each([
    [
      "key",
      valid.replace("#EXT-X-ENDLIST", "#EXT-X-KEY:METHOD=NONE\n#EXT-X-ENDLIST"),
    ],
    [
      "byte range",
      valid.replace("#EXTINF:6.000,", "#EXT-X-BYTERANGE:4@0\n#EXTINF:6.000,"),
    ],
    [
      "discontinuity",
      valid.replace("#EXTINF:6.000,", "#EXT-X-DISCONTINUITY\n#EXTINF:6.000,"),
    ],
    [
      "subdirectory",
      valid.replace("aac-096-00000.m4s", "sub/aac-096-00000.m4s"),
    ],
    ["query", valid.replace("aac-096-00000.m4s", "aac-096-00000.m4s?x=1")],
    ["duplicate", valid.replace("aac-096-00001.m4s", "aac-096-00000.m4s")],
    ["missing VOD", valid.replace("#EXT-X-PLAYLIST-TYPE:VOD\n", "")],
    [
      "duplicate VOD",
      valid.replace(
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-PLAYLIST-TYPE:VOD",
      ),
    ],
    ["missing version", valid.replace("#EXT-X-VERSION:7\n", "")],
    ["missing sequence", valid.replace("#EXT-X-MEDIA-SEQUENCE:0\n", "")],
    [
      "target duration mismatch",
      valid.replace("#EXT-X-TARGETDURATION:6", "#EXT-X-TARGETDURATION:1"),
    ],
    [
      "map after media",
      valid
        .replace('#EXT-X-MAP:URI="aac-096-init.mp4"\n', "")
        .replace(
          "aac-096-00000.m4s\n",
          'aac-096-00000.m4s\n#EXT-X-MAP:URI="aac-096-init.mp4"\n',
        ),
    ],
    [
      "endlist not last",
      valid.replace("#EXT-X-ENDLIST", "#EXT-X-ENDLIST\n#EXT-X-VERSION:7"),
    ],
    [
      "unknown tag",
      valid.replace("#EXTINF:6.000,", "#EXT-X-GAP\n#EXTINF:6.000,"),
    ],
  ])("rejects forbidden %s playlists", (_name, source) => {
    expect(() => parsePlaintextMediaPlaylist(bytes(source))).toThrow();
  });

  test("calculates integer stored-byte bandwidth", () => {
    expect(
      calculateBandwidth([
        { bytes: 101, durationMs: 1000 },
        { bytes: 99, durationMs: 333 },
      ]),
    ).toEqual({
      averageBandwidth: 1201,
      peakBandwidth: 2379,
    });
  });
});
