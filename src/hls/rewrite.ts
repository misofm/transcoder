import type { RenditionId } from "../model.js";
import { parsePlaintextMediaPlaylist } from "./playlist.js";

export const keyTag = (renditionId: RenditionId): string =>
  `#EXT-X-KEY:METHOD=AES-128,URI="key.seal?rendition=${renditionId}"`;

export const rewriteMediaPlaylist = (
  bytes: Uint8Array,
  renditionId: RenditionId,
): Uint8Array => {
  const playlist = parsePlaintextMediaPlaylist(bytes);
  const output: string[] = [];
  let inserted = false;
  for (const line of playlist.lines) {
    output.push(line);
    if (line.startsWith("#EXT-X-MAP:")) {
      output.push(keyTag(renditionId));
      inserted = true;
    }
  }
  if (!inserted) throw new TypeError("cannot insert key without a map");
  return new TextEncoder().encode(`${output.join("\n")}\n`);
};

export const validateEncryptedMediaPlaylist = (
  bytes: Uint8Array,
  renditionId: RenditionId,
): void => {
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576)
    throw new RangeError("invalid playlist size");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = source.trimEnd().split("\n");
  const maps = lines.flatMap((line, index) =>
    line.startsWith("#EXT-X-MAP:") ? [index] : [],
  );
  const keys = lines.flatMap((line, index) =>
    line.startsWith("#EXT-X-KEY:") ? [index] : [],
  );
  if (maps.length !== 1 || keys.length !== 1 || keys[0] !== maps[0]! + 1) {
    throw new TypeError(
      "playlist requires exactly one key immediately after its map",
    );
  }
  if (lines[keys[0]!] !== keyTag(renditionId))
    throw new TypeError("unexpected key method, URI, or IV");
  if (!lines.includes("#EXT-X-MEDIA-SEQUENCE:0"))
    throw new TypeError("media sequence must be zero");
};

export const recoverPlaintextPlaylist = (
  bytes: Uint8Array,
  renditionId: RenditionId,
): Uint8Array => {
  validateEncryptedMediaPlaylist(bytes, renditionId);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = source
    .trimEnd()
    .split("\n")
    .filter((line) => !line.startsWith("#EXT-X-KEY:"));
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
};
