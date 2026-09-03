import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const pinnedEffectVersion = "4.0.0-rc.112";
const pinnedFfmpegImage =
  "ghcr.io/linuxserver/ffmpeg:8.1.2-cli-ls76@sha256:2e7000921be8de2704a4f27dfd3d988562697a346eaabb937a81046c306f0af7";

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

test("FFmpeg conformance uses one digest-pinned reference image", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain(`image: ${pinnedFfmpegImage}`);
  expect(workflow).not.toMatch(
    /FFMPEG_812_BTBN_URL|apt-get install --yes ffmpeg|:latest/u,
  );
});

test("the library contract is plaintext and has no key custody", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const contract = await readFile(
    new URL("../docs/aac-transcode-quilt-v1.md", import.meta.url),
    "utf8",
  );
  for (const documentation of [readme, contract]) {
    expect(documentation).not.toMatch(
      /keySeal|key\.seal|sealPlaintextBytes|rootKey|key\.external|AES|HKDF/u,
    );
  }
  expect(readme).toContain("plaintext");
  expect(contract).toContain("MUST NOT contain `#EXT-X-KEY`");
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

test("library sources have a silent observer boundary and no deployment SDK", async () => {
  const root = new URL("../src", import.meta.url).pathname;
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(
      /console\.|process\.(?:stdout|stderr)|@mysten|keySeal|key\.seal/u,
    );
  }
});
