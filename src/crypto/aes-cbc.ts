import { createCipheriv, createDecipheriv } from "node:crypto";

export const implicitIv = (sequence: number): Uint8Array => {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > 0xffff_ffff
  ) {
    throw new RangeError("media sequence must be an unsigned 32-bit integer");
  }
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence, false);
  return iv;
};

export const encryptedSize = (plainBytes: number): number => {
  if (!Number.isSafeInteger(plainBytes) || plainBytes < 1)
    throw new RangeError("invalid plaintext size");
  return 16 * (Math.floor(plainBytes / 16) + 1);
};

export const encryptSegment = (
  plaintext: Uint8Array,
  key: Uint8Array,
  sequence: number,
): Uint8Array => {
  if (key.byteLength !== 16)
    throw new TypeError("AES-128 key must contain exactly 16 bytes");
  const cipher = createCipheriv("aes-128-cbc", key, implicitIv(sequence));
  return Uint8Array.from(
    Buffer.concat([cipher.update(plaintext), cipher.final()]),
  );
};

export const decryptSegment = (
  ciphertext: Uint8Array,
  key: Uint8Array,
  sequence: number,
): Uint8Array => {
  if (key.byteLength !== 16)
    throw new TypeError("AES-128 key must contain exactly 16 bytes");
  const decipher = createDecipheriv("aes-128-cbc", key, implicitIv(sequence));
  return Uint8Array.from(
    Buffer.concat([decipher.update(ciphertext), decipher.final()]),
  );
};
