# Quilt Listening Room

A static developer-only player for plaintext AAC Quilts. It can stream an R2 delivery copy addressed by its canonical Walrus blob ID, or validate a local artifact directory before feeding temporary Blob URLs to hls.js.

Start the repository's local static server, then open the example:

```sh
bun run player
```

For a published Quilt, enter the delivery origin and Quilt blob ID. The default origin is `https://stream.miso.fm`. The player validates `{blobId}/index.json`, then gives hls.js `{blobId}/master.m3u8`; playlists, init segments, and media fragments resolve relative to that immutable prefix. The optional `?blob=<blob-id>` query parameter pre-fills the ID.

The R2 custom domain must allow cross-origin `GET` and `HEAD`, accept `Range`, and expose `ETag`, `Content-Length`, `Content-Range`, and `Accept-Ranges`. Configure a cache rule for all immutable `{blobId}/*` objects; do not depend on extension-default caching for playlists or JSON.

For local playback, select a generation directory containing `index.json`, `master.m3u8`, the three rendition playlists, init segments, and `.m4s` patches. Local playback verifies every indexed length and SHA-256 hash first.

The server exposes only the static example files and the exact installed hls.js 1.6.13 browser bundle on `127.0.0.1`. It has no upload endpoint.

This is a development and audition tool. Its delivery integration is read-only HTTP playback; it has no R2 credentials, wallet, Sui transaction, publication, or rights-management integration.
