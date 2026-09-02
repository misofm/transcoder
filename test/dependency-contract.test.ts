import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const pinnedEffectVersion = "4.0.0-rc.112";

const readJson = async (url: URL): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;

test("Effect and platform-node share one exact peer/dev version", async () => {
  const manifest = await readJson(new URL("../package.json", import.meta.url));
  const effectManifest = await readJson(
    new URL("../node_modules/effect/package.json", import.meta.url),
  );
  const platformManifest = await readJson(
    new URL(
      "../node_modules/@effect/platform-node/package.json",
      import.meta.url,
    ),
  );

  expect(manifest.peerDependencies).toEqual({
    "@effect/platform-node": pinnedEffectVersion,
    effect: pinnedEffectVersion,
  });
  expect(manifest.devDependencies).toMatchObject({
    "@effect/platform-node": pinnedEffectVersion,
    effect: pinnedEffectVersion,
  });
  expect(effectManifest.version).toBe(pinnedEffectVersion);
  expect(platformManifest.version).toBe(pinnedEffectVersion);
});

const sourceFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().filter((path) => path.endsWith(".ts"));
};

test("unstable Effect process APIs cannot escape the NativeProcess adapter", async () => {
  const root = new URL("../src", import.meta.url).pathname;
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    if (source.includes("effect/unstable/process")) {
      expect(relative(root, file)).toBe("process/native-process.ts");
    }
  }
});
