# Quilt Listening Room

A static developer-only player for a local encrypted Quilt artifact directory.
It verifies the indexed patch lengths and hashes, checks the external root-key
commitment, derives rendition keys with Web Crypto, decrypts media fragments in
memory, and feeds temporary plaintext Blob URLs to hls.js.

Start the repository's local static server, then open the example:

```sh
bun run player
```

Select a generation directory containing `index.json`, `master.m3u8`, the
three rendition playlists, init segments, and encrypted `.m4s` patches. Enter
the matching 32-byte root key as 64 lowercase hexadecimal characters.

The server exposes only these static example files and the exact installed
hls.js 1.6.13 browser bundle on `127.0.0.1`. It has no upload endpoint. Quilt
media and the root key never leave the page.

This is not a production authorization client. It accepts a raw root key for
development and intentionally has no Sui, Seal, publication, or key-persistence
integration.
