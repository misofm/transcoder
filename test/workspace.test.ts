import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  StaleWorkspaceError,
  WorkspaceIoError,
  WorkspaceLockedError,
} from "../src/errors.js";
import {
  assertRegularFilePromise,
  atomicWriteFile,
} from "../src/workspace/atomic-file.js";
import {
  acquireWorkspaceLockPromise,
  releaseWorkspaceLockPromise,
} from "../src/workspace/lock.js";
import {
  initializeWorkspacePromise,
  parseWorkspaceState,
  WORKSPACE_SCHEMA,
} from "../src/workspace/state.js";

const temporaryDirectories: Array<string> = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(
    join("/private/tmp", "transcoder-workspace-test-"),
  );
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("atomically replaces a durable mode-0600 file without temp leakage", async () => {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  const path = join(workspace, "workspace.json");

  await Effect.runPromise(atomicWriteFile(path, "first\n"));
  await Effect.runPromise(atomicWriteFile(path, "second\n"));

  expect(await readFile(path, "utf8")).toBe("second\n");
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(Array.from(new Bun.Glob(".*.tmp-*").scanSync(workspace))).toEqual([]);
});

test("exclusive lock rejects contention and release is ownership checked", async () => {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  const lock = await acquireWorkspaceLockPromise(workspace, "prepare");
  await expect(
    acquireWorkspaceLockPromise(workspace, "finalize"),
  ).rejects.toBeInstanceOf(WorkspaceLockedError);
  await releaseWorkspaceLockPromise(lock);
  const next = await acquireWorkspaceLockPromise(workspace, "finalize");
  await releaseWorkspaceLockPromise(next);
});

test("stale recovery requires explicit old same-host dead-pid proof", async () => {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  const old = new Date("2026-01-01T00:00:00.000Z");
  await acquireWorkspaceLockPromise(workspace, "prepare", {
    now: old,
    host: "host-a",
    pid: 123,
  });

  await expect(
    acquireWorkspaceLockPromise(workspace, "prepare", {
      recoverStaleLock: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
      host: "host-b",
      isPidAlive: () => false,
    }),
  ).rejects.toBeInstanceOf(StaleWorkspaceError);

  const recovered = await acquireWorkspaceLockPromise(workspace, "prepare", {
    recoverStaleLock: true,
    now: new Date("2026-01-01T01:00:00.000Z"),
    host: "host-a",
    isPidAlive: () => false,
  });
  await releaseWorkspaceLockPromise(recovered);
});

test("rejects symlinked workspace and output components", async () => {
  const root = await temporaryDirectory();
  const actual = join(root, "actual");
  await mkdir(actual, { mode: 0o700 });
  const linked = join(root, "linked");
  await symlink(actual, linked);
  await expect(initializeWorkspacePromise(linked)).rejects.toBeInstanceOf(
    WorkspaceIoError,
  );

  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  const target = join(root, "outside");
  await Bun.write(target, "outside");
  const output = join(workspace, "workspace.json");
  await symlink(target, output);
  await expect(
    Effect.runPromise(atomicWriteFile(output, "bad")),
  ).rejects.toBeInstanceOf(WorkspaceIoError);
  await chmod(target, 0o600);
});

test("regular-file preflight and strict workspace checkpoint reject unsafe shapes", async () => {
  const root = await temporaryDirectory();
  const source = join(root, "source.wav");
  await Bun.write(source, "fixture");
  await expect(assertRegularFilePromise(source)).resolves.toBeUndefined();
  await expect(assertRegularFilePromise(root)).rejects.toBeInstanceOf(
    WorkspaceIoError,
  );
  expect(
    parseWorkspaceState(
      JSON.stringify({
        schema: WORKSPACE_SCHEMA,
        prepareDigest: "a".repeat(64),
      }),
    ),
  ).toEqual({ schema: WORKSPACE_SCHEMA, prepareDigest: "a".repeat(64) });
  expect(() =>
    parseWorkspaceState(
      JSON.stringify({ schema: WORKSPACE_SCHEMA, extra: true }),
    ),
  ).toThrow(WorkspaceIoError);
});
