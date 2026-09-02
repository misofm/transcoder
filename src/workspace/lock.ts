import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import {
  InvalidRequestError,
  StaleWorkspaceError,
  WorkspaceIoError,
  WorkspaceLockedError,
} from "../errors.js";
import { assertNoSymlinkComponentsPromise } from "./atomic-file.js";

const LOCK_NAME = ".transcoder.lock";
const LOCK_LIMIT_BYTES = 16 * 1024;
export const DEFAULT_STALE_LOCK_AGE_MS = 5 * 60 * 1_000;

export interface WorkspaceLockRecord {
  readonly pid: number;
  readonly host: string;
  readonly operation: string;
  readonly time: string;
  readonly token: string;
}

export interface WorkspaceLock {
  readonly path: string;
  readonly record: WorkspaceLockRecord;
}

export interface AcquireWorkspaceLockOptions {
  readonly recoverStaleLock?: boolean;
  readonly staleAfterMs?: number;
  readonly now?: Date;
  readonly host?: string;
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
}

const locked = (path: string, message: string): WorkspaceLockedError =>
  new WorkspaceLockedError({
    code: "WORKSPACE_LOCKED",
    phase: "workspace",
    subject: path,
    message,
  });

const stale = (path: string, message: string): StaleWorkspaceError =>
  new StaleWorkspaceError({
    code: "STALE_WORKSPACE",
    phase: "workspace",
    subject: path,
    message,
  });

const io = (path: string, message: string): WorkspaceIoError =>
  new WorkspaceIoError({
    code: "WORKSPACE_IO",
    phase: "workspace",
    subject: path,
    message,
  });

const code = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== "ESRCH";
  }
};

const parseLock = (path: string, text: string): WorkspaceLockRecord => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError();
    const item = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item["pid"]) ||
      (item["pid"] as number) <= 0 ||
      typeof item["host"] !== "string" ||
      typeof item["operation"] !== "string" ||
      typeof item["time"] !== "string" ||
      !Number.isFinite(Date.parse(item["time"] as string)) ||
      typeof item["token"] !== "string"
    ) {
      throw new TypeError();
    }
    return item as unknown as WorkspaceLockRecord;
  } catch {
    throw stale(
      path,
      "Existing workspace lock is invalid and cannot be recovered safely",
    );
  }
};

const readLock = async (path: string): Promise<WorkspaceLockRecord> => {
  await assertNoSymlinkComponentsPromise(path);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LOCK_LIMIT_BYTES) {
      throw stale(path, "Existing workspace lock is not a safe regular file");
    }
    return parseLock(path, await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const acquireWorkspaceLockPromise = async (
  workspacePath: string,
  operation: string,
  options: AcquireWorkspaceLockOptions = {},
): Promise<WorkspaceLock> => {
  if (
    !isAbsolute(workspacePath) ||
    operation.trim().length === 0 ||
    operation.length > 128
  ) {
    throw new InvalidRequestError({
      code: "INVALID_REQUEST",
      phase: "request",
      subject: "workspace-lock",
      message: "Workspace path and lock operation are invalid",
    });
  }
  await assertNoSymlinkComponentsPromise(workspacePath);
  const path = join(workspacePath, LOCK_NAME);
  const currentHost = options.host ?? hostname();
  const now = options.now ?? new Date();
  const pid = options.pid ?? process.pid;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new InvalidRequestError({
      code: "INVALID_REQUEST",
      phase: "request",
      subject: "staleAfterMs",
      message: "Stale lock age must be a positive safe integer",
    });
  }

  const record: WorkspaceLockRecord = {
    pid,
    host: currentHost,
    operation,
    time: now.toISOString(),
    token: randomBytes(16).toString("hex"),
  };

  const create = async (): Promise<WorkspaceLock> => {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(workspacePath);
      return { path, record };
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      throw error;
    }
  };

  try {
    return await create();
  } catch (error) {
    if (code(error) !== "EEXIST") {
      if (
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceLockedError ||
        error instanceof StaleWorkspaceError ||
        error instanceof WorkspaceIoError
      )
        throw error;
      throw io(path, "Workspace lock creation failed");
    }
  }

  if (options.recoverStaleLock !== true)
    throw locked(path, "Workspace is already locked");
  const existing = await readLock(path);
  if (existing.host !== currentHost) {
    throw stale(path, "A lock from another host cannot be proven stale");
  }
  if (now.getTime() - Date.parse(existing.time) < staleAfterMs) {
    throw locked(path, "Workspace lock is not old enough for stale recovery");
  }
  if ((options.isPidAlive ?? defaultPidAlive)(existing.pid)) {
    throw locked(path, "Workspace lock owner is still alive");
  }
  await unlink(path);
  await syncDirectory(workspacePath);
  try {
    return await create();
  } catch (error) {
    if (code(error) === "EEXIST")
      throw locked(path, "Workspace was locked during stale recovery");
    throw io(path, "Workspace lock recovery failed");
  }
};

export const releaseWorkspaceLockPromise = async (
  lock: WorkspaceLock,
): Promise<void> => {
  const current = await readLock(lock.path);
  if (current.token !== lock.record.token) {
    throw locked(lock.path, "Workspace lock ownership changed before release");
  }
  await unlink(lock.path);
  await syncDirectory(join(lock.path, ".."));
};

type LockError =
  | InvalidRequestError
  | WorkspaceLockedError
  | StaleWorkspaceError
  | WorkspaceIoError;

const mapLockError = (path: string, error: unknown): LockError =>
  error instanceof InvalidRequestError ||
  error instanceof WorkspaceLockedError ||
  error instanceof StaleWorkspaceError ||
  error instanceof WorkspaceIoError
    ? error
    : io(path, "Workspace lock operation failed");

export const acquireWorkspaceLock = (
  workspacePath: string,
  operation: string,
  options: AcquireWorkspaceLockOptions = {},
): Effect.Effect<WorkspaceLock, LockError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => acquireWorkspaceLockPromise(workspacePath, operation, options),
      catch: (error) => mapLockError(workspacePath, error),
    }),
  );

export const releaseWorkspaceLock = (
  lock: WorkspaceLock,
): Effect.Effect<void, LockError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => releaseWorkspaceLockPromise(lock),
      catch: (error) => mapLockError(lock.path, error),
    }),
  );

export const withWorkspaceLock = <A, E, R>(
  workspacePath: string,
  operation: string,
  use: () => Effect.Effect<A, E, R>,
  options: AcquireWorkspaceLockOptions = {},
): Effect.Effect<A, E | LockError, R> =>
  Effect.acquireUseRelease(
    acquireWorkspaceLock(workspacePath, operation, options),
    use,
    (lock) => releaseWorkspaceLock(lock).pipe(Effect.orDie),
  );
