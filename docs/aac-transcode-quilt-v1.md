# Miso AAC transcode Quilt contract

Status: pre-launch normative contract.

This document defines the canonical public-playback artifact produced by `@misofm/transcoder`. It is a local, deterministic, plaintext AAC-LC fragmented-MP4 HLS ladder serialized as a Walrus Quilt. Publication, certification, Sui transactions, pointer mutation, and rights policy are caller responsibilities.

## Toolchain and execution

The implementation accepts explicit absolute paths to FFmpeg and FFprobe and requires the exact pinned 8.1.2 toolchain fingerprint. A version, build configuration, library version, or required-capability mismatch fails before media processing.

Every process launch MUST pass the executable and an argv array directly with `shell: false`, `detached: false`, ignored stdin, and bounded independently drained stdout/stderr. The library MUST NOT construct a shell command. Unstable Effect process APIs remain internal to `NativeProcess`.

FFmpeg creates the full ladder from one decoded timeline:

- AAC-LC (`mp4a.40.2`), stereo, 44.1 or 48 kHz;
- nominal rates 96, 160, and 256 kbit/s;
- fragmented MP4 HLS with one init file and complete `.m4s` files;
- media sequence zero and aligned segment boundaries;
- a target between 6,000 and 10,000 ms chosen to remain within 666 Quilt patches.

The archival input is immutable. The codec-preview/headroom policy is `miso.aac-codec-preview/1`: accept a unity-gain ladder only when every rendition is at most -1.01 dBTP and its decoded floating-point sample peak is no greater than 1.0. Otherwise apply one shared downward-only gain planned toward -1.50 dBTP, quantized downward to 0.10 dB, encode the ladder once more, and fail closed if any output still violates the ceiling.

## Finalization

`finalize(request)` accepts the prepared result, canonical recording ID, optional `fresh`, and optional `fileConcurrency` from 1 through 16. It accepts no secret material or deployment-network setting.

First, `preparedContentDigest` hashes each rendition's ordered playlist, init file, and segments as identifier, byte length, and SHA-256 tuples. The master and index are deterministic derivatives and are not part of this preimage. The generation digest is:

```text
SHA-256(
  UTF8("miso.transcoder.walrus-quilt-generation/1\0") ||
  UTF8(preparedContentDigest) ||
  UTF8(recordingId)
)
```

`index.json.generation` is the canonical unpadded base64url representation of those 32 digest bytes. `QuiltArtifact.generationDigest` is their lowercase hexadecimal representation.

The same verified preparation, recording ID, and toolchain therefore produce the same artifact bytes and generation directory. A repeated finalization verifies and resumes that directory. With `fresh: true`, an existing generation is an error. Deployment network cannot change artifact identity or bytes.

Finalization MUST:

1. verify the prepared checkpoint and every prepared file;
2. acquire the workspace lock and remove abandoned temporary entries;
3. copy segments and init files through bounded streaming reads into mode-0600 temporary files;
4. hash bytes while copying, fsync each file, re-hash the source, atomically rename, and fsync the parent directory;
5. preserve each validated media playlist byte-for-byte;
6. calculate stored-byte bandwidth, render the master playlist, and canonically serialize `index.json`;
7. assign the canonical delivery tags and serialize all patches with `@mysten/walrus` QuiltV1 using RS2 and 1,000 shards;
8. atomically include the resulting `quilt.blob` in the generation directory;
9. verify the complete promoted artifact, re-encode the Quilt, and compare its exact bytes before returning it.

Cancellation aborts outstanding work, joins cleanup, and only then releases the workspace lock. A generation directory is made visible by one atomic directory promotion. Temporary output MUST NOT be treated as resumable output.

## HLS playlists

Each media playlist MUST be UTF-8 with LF endings and contain exactly:

- `#EXTM3U`;
- HLS version 7 or later;
- the derived target duration;
- `#EXT-X-PLAYLIST-TYPE:VOD`;
- `#EXT-X-MEDIA-SEQUENCE:0`;
- exactly one `#EXT-X-MAP` before all media;
- one `#EXTINF` and safe relative `.m4s` identifier per segment;
- a final `#EXT-X-ENDLIST`.

Media playlists MUST NOT contain `#EXT-X-KEY`, byte ranges, discontinuities, subdirectories, query strings, unknown tags, duplicate identifiers, or trailing content after `#EXT-X-ENDLIST`.

Non-final durations across all renditions MUST align and remain within one AAC frame of the selected target. The final duration MUST not exceed the target plus one AAC frame or the schema's 10,000 ms ceiling, whichever is smaller.

The master playlist contains exactly three variants in ascending nominal-bitrate order. `AVERAGE-BANDWIDTH` and `BANDWIDTH` are derived from stored media bytes, not nominal encoder settings.

For segment `i`:

```text
instantBandwidth(i) = ceil(8 * bytes(i) * 1000 / durationMs(i))
peakBandwidth       = max(instantBandwidth(i))
averageBandwidth    = ceil(8 * sum(bytes) * 1000 / sum(durationMs))
```

All arithmetic is exact integer arithmetic and the results must fit JavaScript safe integers.

## Artifact inventory and index

The canonical patch order is:

1. `index.json`
2. `master.m3u8`
3. for 96, 160, then 256 kbit/s: media playlist, init file, then segments in sequence order

For `N` aligned segments per rendition, `patchCount = 2 + 3 * (2 + N)` and MUST be at most 666.

`quilt.blob` is stored beside the flat patch files in the generation directory but is not itself a Quilt patch. `QuiltArtifact.patches` retains the canonical playback order above. The pinned Walrus encoder sorts the binary Quilt index lexicographically by identifier; this distinct order is exposed as `QuiltArtifact.quilt.patches` with exact start/end columns.

Patch identifiers deliberately contain no `/`. Walrus accepts slash-bearing identifiers and retrieves them when each slash is percent-encoded, but the Quilt-by-identifier HTTP route treats raw slashes as route separators. Standard relative HLS resolution therefore does not produce retrievable URLs for hierarchical identifiers. Flat identifiers allow `master.m3u8`, rendition playlists, init files, and segments to resolve directly through the aggregator without application-specific playlist rewriting.

The strict top-level index fields, in serialization order, are:

```json
{
  "schema": "miso.aac-transcode-quilt/1",
  "recordingId": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "generation": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "masterPlaylist": "master.m3u8",
  "segmentTargetMs": 6000,
  "patchCount": 11,
  "renditions": []
}
```

There are exactly three rendition descriptors. Each has `id`, `codec`, `nominalBitrate`, `averageBandwidth`, `peakBandwidth`, `sampleRateHz`, `channels`, `playlist`, `init`, and `segments`. An init descriptor has `identifier`, `bytes`, and lowercase `sha256`. A segment descriptor has exactly:

```json
{
  "sequence": 0,
  "identifier": "aac-96-00000.m4s",
  "durationMs": 6000,
  "bytes": 72192,
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

Unknown properties, duplicate JSON keys, unsafe identifiers, duplicate artifact identifiers, noncanonical generation encoding, mismatched patch counts, timelines, bandwidth, sizes, hashes, or rendition ordering are errors.

## Walrus-native metadata

Every patch has exactly one immutable tag. `content-type` is `application/json; charset=utf-8` for the index, `application/vnd.apple.mpegurl` for playlists, and `audio/mp4` for init/media fragments. Mainnet aggregator testing confirms this tag controls the response media type. Cache policy is not tagged because the aggregator applies its own cache-control header.

No recording, rendition, sequence, hash, network, rights, or deployment metadata is duplicated into tags. Those fields are either already canonical in identifiers and `index.json`, or belong to the publishing layer. Keeping tags delivery-only avoids contradictory metadata while allowing aggregators to return useful HTTP headers.

## Verification and scope

Public `verify` is independent of preparation. It checks the real-directory root, bounded regular files with no symlink traversal, canonical index bytes, exact recursive inventory, deterministic patch order and tags, every patch size/hash, master and media playlist structure, index descriptors, aligned timelines, calculated bandwidth, Quilt configuration and offsets, and a byte-for-byte deterministic re-encoding of `quilt.blob`.

The artifact is intentionally suitable for public playback and caching. This contract does not grant machine-learning, redistribution, synchronization, or other downstream rights. Machine-readable rights reservations and licensing metadata belong beside the published artifact and are outside transcoding.
