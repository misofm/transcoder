import { encodeQuilt } from "@mysten/walrus";
import { Effect } from "effect";

import { QuiltEncodingError } from "../errors.js";
import type { WalrusQuiltPatch } from "../model.js";

export const WALRUS_QUILT_NUM_SHARDS = 1000 as const;
export const WALRUS_QUILT_ENCODING_TYPE = "RS2" as const;
export const MAX_QUILT_SOURCE_BYTES = 256 * 1024 * 1024;

export interface QuiltBlob {
  readonly identifier: string;
  readonly contents: Uint8Array;
  readonly tags: Readonly<Record<string, string>>;
}

export interface EncodedWalrusQuilt {
  readonly bytes: Uint8Array;
  readonly patches: readonly WalrusQuiltPatch[];
}

const tagsForContentType = (
  contentType: string,
): Readonly<Record<string, string>> => ({ "content-type": contentType });

export const quiltPatchTags = (
  identifier: string,
): Readonly<Record<string, string>> => {
  if (identifier === "index.json")
    return tagsForContentType("application/json; charset=utf-8");
  if (identifier.endsWith(".m3u8"))
    return tagsForContentType("application/vnd.apple.mpegurl");
  if (identifier.endsWith(".mp4") || identifier.endsWith(".m4s"))
    return tagsForContentType("audio/mp4");
  throw new TypeError(`unsupported Quilt patch media type: ${identifier}`);
};

export const encodeWalrusQuilt = (
  blobs: readonly QuiltBlob[],
): Effect.Effect<EncodedWalrusQuilt, QuiltEncodingError> =>
  Effect.try({
    try: () => {
      const sourceBytes = blobs.reduce(
        (total, blob) => total + blob.contents.byteLength,
        0,
      );
      if (
        blobs.length === 0 ||
        blobs.length > 666 ||
        !Number.isSafeInteger(sourceBytes) ||
        sourceBytes > MAX_QUILT_SOURCE_BYTES
      ) {
        throw new RangeError("Quilt source is outside supported bounds");
      }
      const encoded = encodeQuilt({
        blobs: blobs.map((blob) => ({
          identifier: blob.identifier,
          contents: blob.contents,
          tags: { ...blob.tags },
        })),
        numShards: WALRUS_QUILT_NUM_SHARDS,
        encodingType: WALRUS_QUILT_ENCODING_TYPE,
      });
      return {
        bytes: encoded.quilt,
        patches: encoded.index.patches.map((patch) => ({
          identifier: patch.identifier,
          startIndex: patch.startIndex,
          endIndex: patch.endIndex,
          tags:
            patch.tags instanceof Map
              ? Object.fromEntries(patch.tags)
              : { ...patch.tags },
        })),
      };
    },
    catch: () =>
      new QuiltEncodingError({
        code: "QUILT_ENCODING",
        phase: "quilt",
        subject: "quilt.blob",
        message: "Walrus Quilt encoding failed",
        patchCount: blobs.length,
        sourceBytes: blobs.reduce(
          (total, blob) => total + blob.contents.byteLength,
          0,
        ),
      }),
  });
