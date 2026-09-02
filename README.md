# @misofm/transcoder

Local, deterministic AAC-LC fMP4 HLS preparation and Quilt artifact construction for Miso. The package is an Effect v4 ESM library for Node 22/24 and Bun 1.4; it does not ship a command-line binary or FFmpeg.

The pipeline has two explicit stages:

1. One direct FFmpeg invocation creates an aligned plaintext 96/160/256 kbit/s ladder from a single decoded timeline.
2. TypeScript derives rendition keys with the AAC Quilt v1 HKDF contract, encrypts every complete `.m4s` using HLS AES-128-CBC with implicit sequence IVs, rewrites playlists structurally, measures stored ciphertext bandwidth, and constructs and verifies the strict artifact.

FFmpeg and FFprobe paths must be explicit absolute paths. Every native launch uses an executable and argv array with `shell: false`, `detached: false`, ignored stdin, bounded concurrently drained output pipes, and scoped SIGTERM-to-SIGKILL interruption. Key material is never sent to FFmpeg or placed in argv, environments, logs, filenames, or checkpoints.

## Package exports

- `@misofm/transcoder` — models, typed errors, schema validation, and the `Transcoder` service.
- `@misofm/transcoder/node` — the live Node layer.
- `@misofm/transcoder/schema` — the vendored schema and strict cross-field validator.
- `@misofm/transcoder/package.json` — package metadata.

See [the normative AAC Quilt v1 contract](docs/aac-transcode-quilt-v1.md). `finalize` consumes the supplied root-key array and overwrites that exact array on success, failure, defect, or interruption. JavaScript zeroization is best effort because aliases and runtime-internal copies cannot be controlled.

## Security and scope

This package performs local computation only. It does not use Sui, Seal, Walrus, Quilt publication/certification, or on-chain pointer mutation; `keySeal` is opaque bytes. The current `miso_record_seal_policy` remains fail-closed with `EOwnershipUnprovable`, so generated artifacts must not be presented as protected-playback-ready.

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
