# Quilt Listening Room

A static developer-only player for a local plaintext Quilt artifact directory. It validates the strict index and inventory, verifies indexed media lengths and hashes, creates temporary Blob URLs, and feeds them to hls.js.

Start the repository's local static server, then open the example:

```sh
bun run player
```

Select a generation directory containing `index.json`, `master.m3u8`, the three rendition playlists, init segments, and `.m4s` patches.

The server exposes only the static example files and the exact installed hls.js 1.6.13 browser bundle on `127.0.0.1`. It has no upload endpoint. Quilt media never leaves the page.

This is a local development and audition tool. It has no Sui, Walrus, publication, or rights-management integration.
