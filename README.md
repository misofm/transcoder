# @misofm/transcoder

Deterministic, storage-neutral AAC-LC fMP4 HLS transcoding for Node 22/24 and Bun 1.4. The Effect v4 library performs local computation only; callers choose how to package, upload, address, or publish its verified loose files.

The public service has three operations: `transcode(request)`, `verify(artifact)`, and `cleanup(artifact)`.

```ts
const artifact =
  yield *
  transcoder.transcode({
    inputPath: "/absolute/input.wav",
    workspacePath: "/absolute/workspace",
    ffmpegPath: "/absolute/ffmpeg",
    ffprobePath: "/absolute/ffprobe",
    profile: { maxSegmentsPerRendition: 219 },
  });
```

The result contains aligned 96/160/256 kbps AAC-LC renditions, media playlists, and a master playlist. `artifact.files` is stable and contains absolute paths, byte lengths, SHA-256 hashes, and content types. Verification revalidates inventory, hashes, playlists, alignment, and stored-byte bandwidth. Cleanup explicitly removes only the canonical artifact directory.

FFmpeg and FFprobe are caller-supplied and fingerprinted. Workspaces use restrictive modes, locks, durable checkpoints, atomic writes and directory promotion, interruption-safe cleanup, and deterministic `transcodeDigest` identities. The optional `maxSegmentsPerRendition` is a generic consumer constraint.

The package never shells out to publication tools and contains no network client, credentials, package index, or provider-specific metadata.
