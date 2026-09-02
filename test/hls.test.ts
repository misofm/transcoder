import { describe, expect, test } from "bun:test";

import { calculateBandwidth } from "../src/hls/bandwidth.js";
import { parsePlaintextMediaPlaylist } from "../src/hls/playlist.js";
import {
  rewriteMediaPlaylist,
  validateEncryptedMediaPlaylist,
} from "../src/hls/rewrite.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const valid =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI="aac-096-init.mp4"\n#EXTINF:6.000,\naac-096-00000.m4s\n#EXTINF:1.500,\naac-096-00001.m4s\n#EXT-X-ENDLIST\n';

describe("strict HLS processing", () => {
  test("parses plaintext and inserts exactly one implicit-IV key after map", () => {
    const playlist = parsePlaintextMediaPlaylist(bytes(valid));
    expect(playlist.segments.map((segment) => segment.durationMs)).toEqual([
      6000, 1500,
    ]);
    const rewritten = rewriteMediaPlaylist(bytes(valid), "aac-096");
    const text = new TextDecoder().decode(rewritten);
    expect(text).toContain(
      '#EXT-X-MAP:URI="aac-096-init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key.seal?rendition=aac-096"\n',
    );
    expect(text).not.toContain("IV=");
    expect(() =>
      validateEncryptedMediaPlaylist(rewritten, "aac-096"),
    ).not.toThrow();
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
  ])("rejects forbidden %s playlists", (_name, source) => {
    expect(() => parsePlaintextMediaPlaylist(bytes(source))).toThrow();
  });

  test("calculates integer ciphertext bandwidth", () => {
    expect(
      calculateBandwidth([
        { cipherBytes: 101, durationMs: 1000 },
        { cipherBytes: 99, durationMs: 333 },
      ]),
    ).toEqual({
      averageBandwidth: 1201,
      peakBandwidth: 2379,
    });
  });
});
