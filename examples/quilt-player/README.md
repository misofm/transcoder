# Quilt Listening Room

A static developer-only player for plaintext AAC Quilts. It can stream a published Quilt directly from a Walrus aggregator, or validate a local artifact directory before feeding temporary Blob URLs to hls.js.

Start the repository's local static server, then open the example:

```sh
bun run player
```

For a published Quilt, enter the aggregator origin and Quilt blob ID. The player validates the remote `index.json`, then gives hls.js the Quilt HTTP API URL for `master.m3u8`; playlists, init segments, and media fragments stream directly from the aggregator through relative URLs. The optional `?blob=<blob-id>` query parameter pre-fills the ID.

For local playback, select a generation directory containing `index.json`, `master.m3u8`, the three rendition playlists, init segments, and `.m4s` patches. Local playback verifies every indexed length and SHA-256 hash first.

The server exposes only the static example files and the exact installed hls.js 1.6.13 browser bundle on `127.0.0.1`. It has no upload endpoint.

This is a development and audition tool. Its Walrus integration is read-only HTTP playback; it has no wallet, Sui transaction, publication, or rights-management integration.
