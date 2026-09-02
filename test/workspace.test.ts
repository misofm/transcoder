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
  atomicWriteFilePromise,
} from "../src/workspace/atomic-file.js";
import {
  acquireWorkspaceLockPromise,
  releaseWorkspaceLockPromise,
} from "../src/workspace/lock.js";
import {
  initializeWorkspacePromise,
  cleanupWorkspaceTemporaries,
  parseWorkspaceState,
  promoteWorkspaceDirectory,
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

test("removes only abandoned crash staging names", async () => {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  await mkdir(join(workspace, ".tmp-123-deadbeef"));
  await mkdir(join(workspace, "generations", ".tmp-456-cafebabe"));
  await Bun.write(join(workspace, ".workspace.json.tmp-123-deadbeef"), "x");
  await Bun.write(
    join(workspace, "generations", `${"a".repeat(64)}.json.tmp-7-feedface`),
    "x",
  );
  await Bun.write(join(workspace, "keep.txt"), "keep");
  await Effect.runPromise(cleanupWorkspaceTemporaries(workspace));
  expect(await Bun.file(join(workspace, "keep.txt")).text()).toBe("keep");
  expect(await Bun.file(join(workspace, ".tmp-123-deadbeef")).exists()).toBe(
    false,
  );
  expect(
    await Bun.file(
      join(workspace, "generations", ".tmp-456-cafebabe"),
    ).exists(),
  ).toBe(false);
  expect(
    await Bun.file(
      join(workspace, "generations", `${"a".repeat(64)}.json.tmp-7-feedface`),
    ).exists(),
  ).toBe(false);
});

test("faults after every atomic-file transition leave old or complete new bytes", async () => {
  for (const transition of ["file-fsync", "rename", "parent-fsync"] as const) {
    const root = await temporaryDirectory();
    const workspace = join(root, "workspace");
    await initializeWorkspacePromise(workspace);
    const path = join(workspace, "workspace.json");
    await atomicWriteFilePromise(path, "old\n");
    await expect(
      atomicWriteFilePromise(path, "new\n", {
        afterTransition: (current) => {
          if (current === transition) throw new Error("injected crash");
        },
      }),
    ).rejects.toBeInstanceOf(WorkspaceIoError);
    expect(["old\n", "new\n"]).toContain(await readFile(path, "utf8"));
    expect(Array.from(new Bun.Glob(".*.tmp-*").scanSync(workspace))).toEqual(
      [],
    );
    await atomicWriteFilePromise(path, "resumed\n");
    expect(await readFile(path, "utf8")).toBe("resumed\n");
  }
});

test("faults after directory promotion leave a complete resumable destination", async () => {
  for (const transition of ["rename", "parent-fsync"] as const) {
    const root = await temporaryDirectory();
    const temporary = join(root, "temporary");
    const destination = join(root, "destination");
    await mkdir(temporary, { mode: 0o700 });
    await Bun.write(join(temporary, "complete"), "bytes");
    await expect(
      Effect.runPromise(
        promoteWorkspaceDirectory(temporary, destination, {
          afterTransition: (current) => {
            if (current === transition) throw new Error("injected crash");
          },
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceIoError);
    expect(await readFile(join(destination, "complete"), "utf8")).toBe("bytes");
  }
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

test("only one concurrent stale-lock recovery claimant succeeds", async () => {
  const root = await temporaryDirectory();
  const workspace = join(root, "workspace");
  await initializeWorkspacePromise(workspace);
  await acquireWorkspaceLockPromise(workspace, "prepare", {
    now: new Date("2026-01-01T00:00:00.000Z"),
    host: "host-a",
    pid: 123,
  });
  const recover = () =>
    acquireWorkspaceLockPromise(workspace, "finalize", {
      recoverStaleLock: true,
      now: new Date("2026-01-01T01:00:00.000Z"),
      host: "host-a",
      isPidAlive: () => false,
    });
  const results = await Promise.allSettled([recover(), recover()]);
  const locks = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  expect(locks).toHaveLength(1);
  await releaseWorkspaceLockPromise(locks[0]!);
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
