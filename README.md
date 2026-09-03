# @misofm/transcoder

Local, deterministic plaintext AAC-LC fMP4 HLS preparation and Quilt artifact construction for Miso. The package is an Effect v4 ESM library for Node 22/24 and Bun 1.4; it does not ship a command-line binary or FFmpeg.

This package is experimental and pre-launch. Install it with an exact version together with its exact Effect v4 peers:

```sh
npm install --save-exact @misofm/transcoder@0.2.0 effect@4.0.0-rc.112 @effect/platform-node@4.0.0-rc.112
```

The pipeline has two explicit stages:

1. A codec-preview pass creates one unity-gain aligned plaintext 96/160/256 kbit/s ladder from a single decoded timeline. If every decoded rendition already satisfies the delivery ceiling it is promoted unchanged. Otherwise the largest measured true peak determines one shared, downward-only gain and the complete ladder is encoded once more in fresh staging.
2. TypeScript atomically copies and hashes the media, preserves the validated plaintext playlists, calculates bandwidth from the stored segment bytes, constructs the strict index and master playlist, and verifies the complete artifact.

FFmpeg and FFprobe paths must be explicit absolute paths. Every native launch uses an executable and argv array with `shell: false`, `detached: false`, ignored stdin, bounded concurrently drained output pipes, and scoped SIGTERM-to-SIGKILL interruption.

The archival input is never rewritten or loudness-normalized. FFmpeg 8.1.2 `loudnorm` is used only as a pinned BS.1770 analysis meter. Finite codec-preview samples above full scale are measurement evidence, not an immediate failure. Final media must report at most `-1.01 dBTP` and have an exact decoded floating-point sample peak no greater than `1.0` in every rendition. A retry plans toward `-1.50 dBTP`, quantizes the shared gain downward to `0.10 dB`, applies `volume=<fixed>dB:precision=double` once before the three-way split, and fails closed if that single retry misses. `PreparedTranscode.audio` records source, preview, and output evidence in integer centi-units; silence is represented by `null` rather than a non-finite JSON value.

## Usage

```ts
import { Effect } from "effect";
import { Transcoder } from "@misofm/transcoder";
import { TranscoderNodeLive } from "@misofm/transcoder/node";

const artifact = await Effect.runPromise(
  Effect.gen(function* () {
    const transcoder = yield* Transcoder;
    const prepared = yield* transcoder.prepare({
      inputPath: "/absolute/path/master.flac",
      workspacePath: "/absolute/path/workspace",
      ffmpegPath: "/absolute/path/ffmpeg",
      ffprobePath: "/absolute/path/ffprobe",
    });
    return yield* transcoder.finalize({
      prepared,
      recordingId: `0x${"00".repeat(32)}`,
    });
  }).pipe(Effect.provide(TranscoderNodeLive)),
);
```

`finalize` requires no key or nonce. Its generation identity is deterministically derived from the prepared result and recording ID. Repeating the same request verifies and resumes the same generation. `fresh: true` instead fails if that generation already exists. The artifact is independent of any deployment network.

## Package exports

- `@misofm/transcoder` — models, typed errors, schema validation, artifact helpers, and the `Transcoder` service.
- `@misofm/transcoder/node` — the live Node layer.
- `@misofm/transcoder/schema` — the vendored schema and strict cross-field validator.
- `@misofm/transcoder/package.json` — package metadata.

See [the normative AAC Quilt contract](docs/aac-transcode-quilt-v1.md).

## Security and scope

This package performs local computation only. It does not use deployment SDKs, publish or certify Quilts, or mutate pointers. Public playback policy and any machine-learning rights reservation belong to the publishing layer, not the transcoder.

FFmpeg is a native parser, not a hostile-media sandbox. Production systems processing untrusted input need an OS/container isolation boundary. This package neither distributes nor links FFmpeg.

The schema caps segment duration at 10,000 ms while the prose permits target plus one AAC frame. At a 10-second target the implementation fails closed if the rounded duration cannot be represented. Public `verify` validates the complete inventory, canonical index, descriptors, playlists, sizes, and hashes.

## Development

```sh
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

FFmpeg and FFprobe 8.1.2 are required and rejected if their versions, build lines, configurations, or libav versions do not match. CI structural, plaintext playback, and byte-level golden conformance run only in LinuxServer's `8.1.2-cli-ls76` image pinned by OCI digest.

Run `bun run player` to open the local-only [Quilt Listening Room](examples/quilt-player/README.md), select a plaintext artifact directory, verify it, and audition its three renditions. The example is not included in the npm package and does not add a browser runtime to the server library.
