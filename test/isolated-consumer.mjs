import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const [runtime, tarballArgument] = process.argv.slice(2);
if ((runtime !== "node" && runtime !== "bun") || tarballArgument === undefined)
  process.exit(64);
const tarball = resolve(tarballArgument);
const directory = await mkdtemp(join(tmpdir(), `transcoder-${runtime}-`));
await writeFile(
  join(directory, "package.json"),
  '{"type":"module","private":true}\n',
);

const run = (file, args) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: directory,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 && signal === null
        ? resolvePromise()
        : reject(new Error(`${file} failed`)),
    );
  });

if (runtime === "node") {
  await run("npm", [
    "install",
    "--ignore-scripts",
    tarball,
    "effect@4.0.0-rc.112",
    "@effect/platform-node@4.0.0-rc.112",
  ]);
  await run("node", [
    "--input-type=module",
    "-e",
    'await import("@misofm/transcoder"); await import("@misofm/transcoder/node"); await import("@misofm/transcoder/schema")',
  ]);
} else {
  await run("bun", [
    "add",
    "--ignore-scripts",
    tarball,
    "effect@4.0.0-rc.112",
    "@effect/platform-node@4.0.0-rc.112",
  ]);
  await run("bun", [
    "-e",
    'await import("@misofm/transcoder"); await import("@misofm/transcoder/node"); await import("@misofm/transcoder/schema")',
  ]);
}

const installed = join(directory, "node_modules", "@misofm", "transcoder");
const manifest = JSON.parse(await readFile(join(installed, "package.json")));
const expectedExports = [".", "./node", "./package.json", "./schema"];
if (
  JSON.stringify(Object.keys(manifest.exports).sort()) !==
  JSON.stringify(expectedExports)
)
  throw new Error("installed package export surface changed");
const files = [];
const walk = async (root, prefix = "") => {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative =
      prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await walk(join(root, entry.name), relative);
    else files.push(relative);
  }
};
await walk(installed);
if (
  files.some(
    (file) =>
      file.startsWith("src/") ||
      file.startsWith("test/") ||
      file.startsWith("dist/crypto/") ||
      file.startsWith("dist/hls/rewrite.") ||
      file.endsWith(".map") ||
      (file.endsWith(".ts") && !file.endsWith(".d.ts")),
  )
)
  throw new Error(
    "installed package leaked source, tests, source maps, or removed crypto output",
  );
