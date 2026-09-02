import { createHash, hkdfSync } from "node:crypto";

import type { RenditionId } from "../model.js";

const DOMAIN = new TextEncoder().encode("miso.aac-transcode-quilt/1\0");
const INFO_PREFIX = "hls-aes-128\0";

export const decodeRecordingId = (value: string): Uint8Array => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(
      "recordingId must be a canonical 32-byte lowercase Sui object ID",
    );
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
};

export const deriveRenditionKey = (
  rootKey: Uint8Array,
  recordingId: string,
  generationNonce: Uint8Array,
  renditionId: RenditionId,
): Uint8Array => {
  if (rootKey.byteLength !== 32)
    throw new TypeError("rootKey must contain exactly 32 bytes");
  if (generationNonce.byteLength !== 32) {
    throw new TypeError("generationNonce must contain exactly 32 bytes");
  }
  const recordingIdBytes = decodeRecordingId(recordingId);
  const salt = createHash("sha256")
    .update(DOMAIN)
    .update(recordingIdBytes)
    .update(generationNonce)
    .digest();
  const info = new TextEncoder().encode(`${INFO_PREFIX}${renditionId}`);
  return new Uint8Array(hkdfSync("sha256", rootKey, salt, info, 16));
};
