import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { InvalidRequestError, WorkspaceIoError } from "../errors.js";

const ioError = (subject: string, message: string): WorkspaceIoError =>
  new WorkspaceIoError({
    code: "WORKSPACE_IO",
    phase: "workspace",
    subject,
    message,
  });

const invalidPath = (subject: string): InvalidRequestError =>
  new InvalidRequestError({
    code: "INVALID_REQUEST",
    phase: "request",
    subject,
    message: "Workspace paths must be absolute",
  });

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const assertNoSymlinkComponentsPromise = async (
  targetPath: string,
  allowMissingLeaf = false,
): Promise<void> => {
  if (!isAbsolute(targetPath)) throw invalidPath(targetPath);
  const components: Array<string> = [];
  let cursor = targetPath;
  while (dirname(cursor) !== cursor) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.reverse();
  for (const [index, component] of components.entries()) {
    try {
      const stat = await lstat(component);
      if (stat.isSymbolicLink())
        throw ioError(targetPath, "Symlinked workspace paths are not allowed");
      if (index < components.length - 1 && !stat.isDirectory()) {
        throw ioError(
          targetPath,
          "A workspace path component is not a directory",
        );
      }
    } catch (error) {
      if (
        allowMissingLeaf &&
        index === components.length - 1 &&
        errorCode(error) === "ENOENT"
      )
        return;
      if (
        error instanceof WorkspaceIoError ||
        error instanceof InvalidRequestError
      )
        throw error;
      throw ioError(targetPath, "Workspace path inspection failed");
    }
  }
};

export const assertNoSymlinkComponents = (
  targetPath: string,
  allowMissingLeaf = false,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.tryPromise({
    try: () => assertNoSymlinkComponentsPromise(targetPath, allowMissingLeaf),
    catch: (error) =>
      error instanceof InvalidRequestError || error instanceof WorkspaceIoError
        ? error
        : ioError(targetPath, "Workspace path inspection failed"),
  });

export const assertRegularFilePromise = async (path: string): Promise<void> => {
  await assertNoSymlinkComponentsPromise(path);
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw ioError(path, "Source path must be a regular local file");
  } catch (error) {
    if (
      error instanceof InvalidRequestError ||
      error instanceof WorkspaceIoError
    )
      throw error;
    throw ioError(path, "Source file inspection failed");
  }
};

export const assertRegularFile = (
  path: string,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.tryPromise({
    try: () => assertRegularFilePromise(path),
    catch: (error) =>
      error instanceof InvalidRequestError || error instanceof WorkspaceIoError
        ? error
        : ioError(path, "Source file inspection failed"),
  });

const syncParent = async (path: string): Promise<void> => {
  const handle = await open(dirname(path), constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const atomicWriteFilePromise = async (
  path: string,
  bytes: Uint8Array | string,
  hooks: {
    readonly afterTransition?: (
      transition: "file-fsync" | "rename" | "parent-fsync",
    ) => void | Promise<void>;
  } = {},
): Promise<void> => {
  if (!isAbsolute(path)) throw invalidPath(path);
  await assertNoSymlinkComponentsPromise(dirname(path));
  await assertNoSymlinkComponentsPromise(path, true);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw ioError(
        path,
        "Atomic destination must be a regular file or absent",
      );
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      if (error instanceof WorkspaceIoError) throw error;
      throw ioError(path, "Atomic destination inspection failed");
    }
  }

  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await hooks.afterTransition?.("file-fsync");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await hooks.afterTransition?.("rename");
    await syncParent(path);
    await hooks.afterTransition?.("parent-fsync");
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (
      error instanceof InvalidRequestError ||
      error instanceof WorkspaceIoError
    )
      throw error;
    throw ioError(path, "Atomic durable file write failed");
  }
};

export const atomicWriteFile = (
  path: string,
  bytes: Uint8Array | string,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => atomicWriteFilePromise(path, bytes),
      catch: (error) =>
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceIoError
          ? error
          : ioError(path, "Atomic durable file write failed"),
    }),
  );
