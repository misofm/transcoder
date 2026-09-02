# AAC transcode Quilt v1

Status: proposed. This document fixes the storage and cryptographic shape before
the packager, on-chain pointer, and player adapter become public contracts.

## Decision

Store one immutable Quilt per Recording transcode generation. Put the complete
AAC bitrate ladder, its playlists, and initialization data in that Quilt. Key
custody is external: the Quilt contains neither a plaintext root key nor a key
envelope.

Do not create one Quilt per bitrate in the normal case. All renditions:

- are produced and replaced atomically;
- are authorized by the same Record gate;
- have the same retention and renewal lifecycle; and
- consist of many small, independently fetched segments.

That is the workload Quilt is designed to amortize. QuiltV1 supports at most
666 patches. With three renditions and six-second segments, a 193-second track
uses about 107 patches, including manifests and init segments. The longest
current Between the Doors track therefore uses less than
one sixth of the limit.

A generation that does not fit must fail before encoding. The packager may
first increase segment duration to at most ten seconds. It must not silently
remove a required rendition. Splitting by rendition is an explicit fallback
layout, not an automatic behavior: multiple Quilts lose atomic publication and
renewal and need a separate root descriptor.

Do not put multiple Recordings in one Quilt. Recordings can be replaced,
authorized, and retired independently, and combining them creates the lifecycle
mismatch Quilt warns against.

## Media profile

The required v1 profile is HLS VOD with AAC-LC audio in fragmented MP4:

| Property          | v1 value                                                    |
| ----------------- | ----------------------------------------------------------- |
| Codec             | AAC-LC (`mp4a.40.2`)                                        |
| Renditions        | 96, 160, and 256 kbit/s stereo                              |
| Segment container | fragmented MP4 (`.m4s`)                                     |
| Target duration   | 6 seconds by default; at most 10                            |
| Playlist type     | `VOD` with `#EXT-X-ENDLIST`                                 |
| HLS compatibility | version 7 or newer                                          |
| Segment alignment | every rendition starts and ends on the same sample boundary |

Use the Recording master's native 44.1 or 48 kHz sample rate. Do not resample a
44.1 kHz music master merely to make a round-number HLS profile.

Fragmented MP4 is intentional even though the encoded elementary stream is
AAC. RFC 8216 requires a Packed Audio `.aac` segment to begin with a specific
ID3 `PRIV` timestamp. FFmpeg's supported HLS segment outputs are MPEG-TS and
fragmented MP4; raw ADTS segmentation does not, by itself, satisfy that Packed
Audio timestamp requirement. Fragmented MP4 provides explicit decode timing,
has direct FFmpeg support, and avoids a custom ID3 segmenter. A future
Packed-Audio profile may be added only with a conformance test for the required
`com.apple.streaming.transportStreamTimestamp` frame.

The packager must measure and write `AVERAGE-BANDWIDTH` and peak `BANDWIDTH`
from the output instead of copying nominal encoder targets into the master
playlist.

## Quilt contents

Identifiers are flat, ASCII, and generated before Quilt encoding:

```text
index.json
master.m3u8
aac-096.m3u8
aac-096-init.mp4
aac-096-00000.m4s
aac-096-00001.m4s
...
aac-160.m3u8
aac-160-init.mp4
...
aac-256.m3u8
aac-256-init.mp4
...
```

Flat identifiers make relative HLS URIs work without embedding a Quilt ID in a
playlist. Embedding the ID would be circular because a Quilt's Blob ID and each
`QuiltPatchId` depend on the complete Quilt. The application persists the Quilt
Blob ID returned at publication and resolves each identifier with the Walrus
`by-quilt-id` endpoint. It must not persist individual patch IDs as the logical
media identity.

`index.json`, playlists, and init segments are public metadata. Media fragments
are encrypted. The on-chain transcode reference must bind the Quilt Blob ID and
the SHA-256 of the exact `index.json` bytes. That digest makes the descriptor
and fragment digests part of the trusted pointer instead of trusting an
arbitrary HTTP aggregator response.

All patches share the Quilt's storage lifetime. Updating any rendition creates
a new complete generation and an atomic pointer change. Published Quilts are
never edited in place.

## Encryption profile

The caller generates a fresh random 32-byte root data-encryption key and a
separate random 32-byte generation nonce for every transcode generation. It
must durably protect the root key before finalization so a crash after artifact
promotion cannot create ciphertext whose key exists only in a lost return
value. The transcoder accepts a working copy, consumes and best-effort zeroes
it, and returns only the artifact. Protection, persistence, authorization, and
recovery of the root key are outside this contract.

`index.json` records a non-secret `keyId` commitment:

```text
keyId = hex(HMAC-SHA256(
  key = rootKey,
  data = UTF8("miso.aac-transcode-quilt/key-id/1\0") || decode_hex(recordingId) || generationNonce
))
```

This binds resumability and artifact verification to the caller's key without
placing that key in the Quilt.

Derive one HLS AES-128 key per rendition:

```text
renditionKey = HKDF-SHA256(
  ikm  = rootKey,
  salt = SHA-256("miso.aac-transcode-quilt/1\0" || recordingId || generationNonce),
  info = UTF8("hls-aes-128\0" || renditionId),
  len  = 16
)
```

Encrypt each complete media fragment with the rendition key using the HLS
`METHOD=AES-128` full-segment construction (AES-128-CBC with PKCS#7 padding).
Each rendition uses its own key, so identical media sequence numbers in two
renditions cannot reuse a key/IV pair. Use media sequence zero and the standard
big-endian sequence-number IV derivation. Do not set one constant explicit IV
for every segment.

Each media playlist declares:

```m3u8
#EXT-X-KEY:METHOD=AES-128,URI="key.external?generation=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&rendition=aac-096"
```

The plaintext `#EXT-X-MAP` must appear before that key tag, so the fMP4 init
segment is not accidentally covered by the media encryption key. A validator
must reject a playlist that changes key method, URI, IV behavior, or map after
the first media segment.

FFmpeg 8.1.2 rejects `-hls_segment_type fmp4` combined with its built-in HLS
encryption as “Encrypted fmp4 not yet supported.” Packaging is therefore an
explicit two-stage operation: FFmpeg writes the final plaintext fMP4 segments
and playlists first; the Miso packager then encrypts each complete `.m4s`,
inserts the key tag after `#EXT-X-MAP`, and updates the descriptor sizes and
digests. A local conformance probe confirmed that FFmpeg can decode the
post-processed AES-128 playlist back to the original seven-second test stream.
Never ask FFmpeg to choose or write the production key.

The query binds a request to the generation and selects the HKDF rendition
domain; it does not identify a stored Quilt patch. An application key loader
obtains the protected root key through its external authorization system,
checks `keyId`, derives the requested 16-byte rendition key locally, and
supplies those bytes to the HLS engine's key-loader callback. The raw key is
never served as an ordinary public Quilt patch.

This keeps segment encryption inside HLS's interoperable AES-128 profile and
lets hls.js perform its normal fragment decryption. Access control still
requires an application loader: the virtual `key.external` URI is not an HTTP
key endpoint. Native Safari playback
cannot use this loader. Protected playback therefore requires hls.js over
MSE/Managed Media Source; supporting native HLS would require a trusted key
endpoint or FairPlay, neither of which is part of this format.

AES-CBC does not authenticate ciphertext. `index.json` therefore records the
SHA-256 and byte length of every stored ciphertext, and the Miso fragment loader
must verify both before handing bytes to hls.js. The trusted on-chain pointer to
the content-addressed Quilt Blob ID is the root of integrity. A player must not
accept a Quilt ID supplied only by the untrusted `index.json` it is fetching.

The generation nonce is part of the HKDF salt and every virtual key URI. Key and
nonce reuse across repackaging is forbidden. A publish checkpoint must bind the
nonce, `keyId`, exact patch list, each patch digest, Quilt Blob ID, and pointer
mutation. Authorization failures are application errors, not corrupt-segment
errors, and must not trigger an unbounded retry.

## `index.json`

The descriptor is strict JSON. Unknown keys, duplicate rendition IDs,
duplicate identifiers, non-canonical object IDs, unsafe integers, and any
derived count or size mismatch are errors.

[`aac-transcode-quilt-v1.schema.json`](aac-transcode-quilt-v1.schema.json)
defines the transport-level shape. Cross-field invariants in this document
(uniqueness, derived patch counts, CBC padding size, aligned timelines, and
playlist agreement) remain mandatory producer and parser checks because JSON
Schema cannot express all of them safely.

```json
{
  "schema": "miso.aac-transcode-quilt/1",
  "network": "testnet",
  "recordingId": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "generation": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "masterPlaylist": "master.m3u8",
  "segmentTargetMs": 6000,
  "patchCount": 11,
  "encryption": {
    "scheme": "hls-aes-128-cbc-hkdf/1",
    "kdf": "hkdf-sha256",
    "rootKeyBytes": 32,
    "keyId": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "renditions": [
    {
      "id": "aac-096",
      "codec": "mp4a.40.2",
      "nominalBitrate": 96000,
      "averageBandwidth": 97124,
      "peakBandwidth": 104892,
      "sampleRateHz": 44100,
      "channels": 2,
      "playlist": "aac-096.m3u8",
      "init": {
        "identifier": "aac-096-init.mp4",
        "bytes": 765,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "segments": [
        {
          "sequence": 0,
          "identifier": "aac-096-00000.m4s",
          "durationMs": 6000,
          "plainBytes": 72192,
          "cipherBytes": 72208,
          "ciphertextSha256": "0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    },
    {
      "id": "aac-160",
      "codec": "mp4a.40.2",
      "nominalBitrate": 160000,
      "averageBandwidth": 161284,
      "peakBandwidth": 171920,
      "sampleRateHz": 44100,
      "channels": 2,
      "playlist": "aac-160.m3u8",
      "init": {
        "identifier": "aac-160-init.mp4",
        "bytes": 765,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "segments": [
        {
          "sequence": 0,
          "identifier": "aac-160-00000.m4s",
          "durationMs": 6000,
          "plainBytes": 120000,
          "cipherBytes": 120016,
          "ciphertextSha256": "0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    },
    {
      "id": "aac-256",
      "codec": "mp4a.40.2",
      "nominalBitrate": 256000,
      "averageBandwidth": 257948,
      "peakBandwidth": 271104,
      "sampleRateHz": 44100,
      "channels": 2,
      "playlist": "aac-256.m3u8",
      "init": {
        "identifier": "aac-256-init.mp4",
        "bytes": 765,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      },
      "segments": [
        {
          "sequence": 0,
          "identifier": "aac-256-00000.m4s",
          "durationMs": 6000,
          "plainBytes": 192000,
          "cipherBytes": 192016,
          "ciphertextSha256": "0000000000000000000000000000000000000000000000000000000000000000"
        }
      ]
    }
  ]
}
```

The final segment may be shorter than the target. All non-final segment
durations must be within one AAC frame of the target, and corresponding
segments in every rendition must describe the same time interval.

The descriptor's `patchCount` is exactly:

```text
2 + sum(2 + rendition.segments.length)
```

The fixed two patches are `index.json` and `master.m3u8`; each rendition adds
one media playlist and one init segment. Publication fails when the result
exceeds 666.

## Read path

1. Read the trusted Quilt Blob ID from the Recording's on-chain transcode
   reference.
2. Fetch and strictly validate `index.json` from that Quilt.
3. Verify the fetched `index.json` against the trusted `indexSha256`.
4. Obtain the 32-byte root key through the application's external key-custody
   and authorization flow, keep it only in memory, and verify `keyId`.
5. Start hls.js with application playlist, fragment, and key loaders rooted at the
   trusted Quilt ID.
6. On a key request, validate its generation and rendition parameters, then
   derive and return the requested rendition key locally.
7. On a segment response, verify ciphertext length and SHA-256 before hls.js
   decrypts and appends it.
8. Zero best-effort byte copies and destroy loader/key state on sign-out,
   network change, Record change, or player teardown.

One externally authorized root key unlocks the complete bitrate ladder.
Adaptive bitrate switching requires no additional key-custody request.

## Publication invariants

- Encode every rendition from the same decoded master timeline.
- Reject clipping, channel-count drift, sample-rate drift, missing end tags,
  non-monotonic timestamps, or variant duration disagreement.
- Generate plaintext fMP4 HLS with FFmpeg, then AES-CBC-encrypt each final media
  segment with the sequence-derived IV. Insert `#EXT-X-KEY` only after the
  plaintext `#EXT-X-MAP`; do not use FFmpeg's unsupported encrypted-fMP4 path.
- Validate every playlist with an independent HLS parser and decode every
  rendition after encryption/decryption before upload.
- Encode and hash the exact final bytes before registering the Quilt.
- Store all files in one `writeFiles`/Quilt flow and retain its resumable
  publication checkpoint. Assert that every returned file has the same Quilt
  Blob ID; the Walrus SDK documentation allows future `writeFiles`
  implementations to split inputs, which would violate this format rather than
  transparently optimize it.
- Certify the Quilt before changing the on-chain Recording pointer.
- Treat an interrupted pointer mutation as `unknown` until chain inspection
  proves applied or not applied; never republish blindly.
- Keep the old generation referenced until the new Quilt is certified and its
  pointer transaction succeeds.

## Why not the alternatives?

### One Quilt per bitrate

It pays Quilt's fixed blob overhead three times, triples registration and
certification mutations, and permits a partially published ladder. It is useful
only when the 666-patch ceiling forces explicit sharding or when renditions have
genuinely different retention policies.

### One Walrus blob per segment

Six-second AAC segments are usually tens or hundreds of KiB. Separate blobs pay
Walrus's fixed per-blob metadata/erasure-coding overhead for every segment and
create hundreds of on-chain operations. Quilt exists specifically to batch
this shape while preserving individual patch reads.

### One monolithic encrypted media blob with byte ranges

Walrus aggregators support HTTP Range, but HLS wants independently cacheable
segments and adaptive rendition switching. A monolith also enlarges failure and
retry units and requires a custom byte-range playlist. Independent Quilt
patches preserve ordinary HLS scheduling and cache behavior.

### AES-256-GCM fragments outside the HLS encryption profile

GCM would authenticate every fragment, but hls.js would need a custom fragment
decryptor rather than its normal HLS AES pipeline, and native HLS would still
be unavailable because authorization is application-specific. This contract
uses the standard HLS AES-128 construction plus mandatory ciphertext hashes.
Changing the algorithm requires an explicit contract change, not an in-place
substitution.

## Sources

- [Walrus Quilt overview and decision guide](https://docs.wal.app/docs/system-overview/quilt)
- [Walrus Quilt HTTP APIs](https://docs.wal.app/docs/http-api/quilt-http-apis)
- [Walrus browser, patch, and Range behavior](https://docs.wal.app/docs/examples/browser-and-mobile)
- [Walrus TypeScript `WalrusFile` and `writeFiles` API](https://github.com/MystenLabs/ts-sdks/blob/main/packages/docs/content/walrus/index.mdx)
- [RFC 8216: HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216)
- [FFmpeg HLS muxer formats and AES-128 options](https://ffmpeg.org/ffmpeg-formats.html#hls-2)
- [hls.js custom loader API](https://github.com/video-dev/hls.js/blob/master/docs/API.md)
