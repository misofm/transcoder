import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const readJson = async (url: URL): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;

test("Effect peers are exact and the runtime dependency is storage-neutral", async () => {
  const manifest = await readJson(new URL("../package.json", import.meta.url));
  expect(manifest.peerDependencies).toEqual({
    "@effect/platform-node": "4.0.0-rc.112",
    effect: "4.0.0-rc.112",
  });
  expect(manifest.dependencies).toEqual({ "m3u8-parser": "7.2.0" });
});

const files = async (root: string): Promise<readonly string[]> =>
  (
    await Promise.all(
      (await readdir(root, { withFileTypes: true })).map((entry) =>
        entry.isDirectory()
          ? files(join(root, entry.name))
          : Promise.resolve([join(root, entry.name)]),
      ),
    )
  ).flat();

test("source and package contract contain no storage-provider integration", async () => {
  const manifest = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const source = await Promise.all(
    (await files(new URL("../src", import.meta.url).pathname)).map((path) =>
      readFile(path, "utf8"),
    ),
  );
  for (const text of [manifest, ...source])
    expect(text).not.toMatch(
      /@mysten|walrus|quilt|\bR2\b|recordingId|blobId|generationDigest/iu,
    );
});
