import { describe, expect, test } from "bun:test";

import {
  decryptSegment,
  encryptSegment,
  encryptedSize,
  implicitIv,
} from "../src/crypto/aes-cbc.js";
import {
  decodeRecordingId,
  deriveRenditionKey,
  deriveRootKeyId,
} from "../src/crypto/hkdf.js";

describe("AAC Quilt v1 cryptography", () => {
  test("decodes canonical object IDs in hex byte order", () => {
    const id = `0x${Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("")}`;
    expect([...decodeRecordingId(id)]).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(() => decodeRecordingId("0x1")).toThrow();
    expect(() => decodeRecordingId(`0x${"AA".repeat(32)}`)).toThrow();
  });

  test("matches frozen HKDF-SHA256 vectors", () => {
    const root = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const recordingId = `0x${"01".repeat(32)}`;
    expect(
      Buffer.from(
        deriveRenditionKey(root, recordingId, nonce, "aac-096"),
      ).toString("hex"),
    ).toBe("19a9b924ccf6667512f7246279e8569d");
    expect(
      Buffer.from(
        deriveRenditionKey(root, recordingId, nonce, "aac-160"),
      ).toString("hex"),
    ).toBe("edd842acd930347ede310174c4f1e462");
    expect(
      Buffer.from(
        deriveRenditionKey(root, recordingId, nonce, "aac-256"),
      ).toString("hex"),
    ).toBe("c15100c0e6aaabc8e5986c018f4390c0");
  });

  test("matches the frozen root-key commitment vector", () => {
    const root = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const recordingId = `0x${"01".repeat(32)}`;
    expect(deriveRootKeyId(root, recordingId, nonce)).toBe(
      "0d37753262e83b95312fe181cb376a5adca1f15b704b1c728e3d4bd35de4f570",
    );

    const otherRoot = Uint8Array.from(root);
    otherRoot[0] = otherRoot[0]! ^ 1;
    const otherNonce = Uint8Array.from(nonce);
    otherNonce[0] = otherNonce[0]! ^ 1;
    expect(deriveRootKeyId(otherRoot, recordingId, nonce)).not.toBe(
      deriveRootKeyId(root, recordingId, nonce),
    );
    expect(deriveRootKeyId(root, recordingId, otherNonce)).not.toBe(
      deriveRootKeyId(root, recordingId, nonce),
    );
    expect(deriveRootKeyId(root, `0x${"02".repeat(32)}`, nonce)).not.toBe(
      deriveRootKeyId(root, recordingId, nonce),
    );
  });

  test("uses 16-byte big-endian implicit IVs", () => {
    expect(Buffer.from(implicitIv(0)).toString("hex")).toBe("00".repeat(16));
    expect(Buffer.from(implicitIv(1)).toString("hex")).toBe(
      `${"00".repeat(15)}01`,
    );
    expect(Buffer.from(implicitIv(0xffff_ffff)).toString("hex")).toBe(
      `${"00".repeat(12)}ffffffff`,
    );
    expect(() => implicitIv(0x1_0000_0000)).toThrow();
  });

  test("matches AES-CBC PKCS#7 vectors around block boundaries", () => {
    const key = Uint8Array.from({ length: 16 }, (_, index) => index);
    const expected = new Map([
      [1, "3bea384a5876c44c84ff2fd24ed592bd"],
      [15, "bf70c038d511f2a8b528e06691c6d42d"],
      [16, "e62a2815c64fbb24e09f0b8134764e032db3f457e9be6effa400e4ed31eb3e36"],
      [17, "e62a2815c64fbb24e09f0b8134764e03a7f491bd280af0451007909edfe9e0ce"],
    ]);
    for (const [size, hex] of expected) {
      const plaintext = Uint8Array.from({ length: size }, (_, index) => index);
      const ciphertext = encryptSegment(plaintext, key, 1);
      expect(Buffer.from(ciphertext).toString("hex")).toBe(hex);
      expect(ciphertext.byteLength).toBe(encryptedSize(size));
      expect(decryptSegment(ciphertext, key, 1)).toEqual(plaintext);
    }
  });
});
