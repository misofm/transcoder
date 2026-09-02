# @misofm/transcoder

Local, deterministic AAC-LC fMP4 HLS preparation and Quilt artifact construction for Miso. The package is an Effect v4 ESM library for Node 22/24 and Bun 1.4; it does not ship a command-line binary or FFmpeg.

This package is experimental and pre-launch. Install it with an exact version together with its exact Effect v4 peers:

```sh
npm install --save-exact @misofm/transcoder@0.1.0 effect@4.0.0-rc.112 @effect/platform-node@4.0.0-rc.112
```

The pipeline has two explicit stages:

1. A codec-preview pass creates one unity-gain aligned plaintext 96/160/256 kbit/s ladder from a single decoded timeline. If every decoded rendition already satisfies the delivery ceiling it is promoted unchanged. Otherwise the largest measured true peak determines one shared, downward-only gain and the complete ladder is encoded once more in fresh staging.
2. TypeScript derives rendition keys with the AAC Quilt v1 HKDF contract, encrypts every complete `.m4s` using HLS AES-128-CBC with implicit sequence IVs, rewrites playlists structurally, measures stored ciphertext bandwidth, and constructs and verifies the strict artifact.

FFmpeg and FFprobe paths must be explicit absolute paths. Every native launch uses an executable and argv array with `shell: false`, `detached: false`, ignored stdin, bounded concurrently drained output pipes, and scoped SIGTERM-to-SIGKILL interruption. Key material is never sent to FFmpeg or placed in argv, environments, logs, filenames, or checkpoints.

The archival input is never rewritten or loudness-normalized. FFmpeg 8.1.2 `loudnorm` is used only as a pinned BS.1770 analysis meter. Finite codec-preview samples above full scale are measurement evidence, not an immediate failure. Final plaintext must report at most `-1.01 dBTP` and have an exact decoded floating-point sample peak no greater than `1.0` in every rendition. A retry plans toward `-1.50 dBTP`, quantizes the shared gain downward to `0.10 dB`, applies `volume=<fixed>dB:precision=double` once before the three-way split, and fails closed if that single retry misses. `PreparedTranscode.audio` records source, preview, and output evidence in integer centi-units; silence is represented by `null` rather than a non-finite JSON value.

## Package exports

- `@misofm/transcoder` — models, typed errors, schema validation, key-derivation/commitment helpers, and the `Transcoder` service.
- `@misofm/transcoder/node` — the live Node layer.
- `@misofm/transcoder/schema` — the vendored schema and strict cross-field validator.
- `@misofm/transcoder/package.json` — package metadata.

See [the normative AAC Quilt v1 contract](docs/aac-transcode-quilt-v1.md). The caller generates and durably protects a fresh 32-byte root key and generation nonce before finalization, then passes a disposable working copy such as `rootKey: retainedRootKey.slice()`. `finalize` consumes the supplied root-key array and overwrites that exact array on success, failure, defect, or interruption; it returns only the artifact. JavaScript zeroization is best effort because aliases and runtime-internal copies cannot be controlled.

## Security and scope

This package performs local computation only. It does not protect or persist the root key, use deployment SDKs, publish/certify Quilts, or mutate pointers. External key custody and authorization belong to the caller. The Quilt contains encrypted media and a non-secret `keyId` commitment, never a key envelope or plaintext key.

FFmpeg is a native parser, not a hostile-media sandbox. Production systems processing untrusted input need an OS/container isolation boundary. This package neither distributes nor links FFmpeg.

The v1 schema caps segment duration at 10,000 ms while the prose permits target plus one AAC frame. At a 10-second target the implementation fails closed if the rounded duration cannot be represented. Public `verify` validates the complete no-key inventory, descriptors, playlists, sizes, and hashes; decrypt/byte-compare validation occurs during `finalize`, while key material is still available.

## Development

```sh
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

FFmpeg and FFprobe 8.1.2 are required and rejected if their versions, build lines, configurations, or libav versions do not match. CI structural, encrypted-playback, and byte-level golden conformance run only in LinuxServer's `8.1.2-cli-ls76` image pinned by OCI digest.

Run `bun run player` to open the local-only [Quilt Listening Room](examples/quilt-player/README.md), select an encrypted artifact directory, and audition it with a disposable external root-key copy. The example is not included in the npm package and does not add a browser runtime to the server library.
