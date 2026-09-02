import {
  chmod,
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { InvalidRequestError, WorkspaceIoError } from "../errors.js";
import {
  atomicWriteFile,
  assertNoSymlinkComponentsPromise,
} from "./atomic-file.js";

export const WORKSPACE_SCHEMA = "miso.transcoder-workspace/1" as const;

export interface WorkspaceState {
  readonly schema: typeof WORKSPACE_SCHEMA;
  readonly prepareDigest?: string;
  readonly generationDigest?: string;
}

const io = (subject: string, message: string): WorkspaceIoError =>
  new WorkspaceIoError({
    code: "WORKSPACE_IO",
    phase: "workspace",
    subject,
    message,
  });

export const initializeWorkspacePromise = async (
  workspacePath: string,
): Promise<void> => {
  if (!isAbsolute(workspacePath)) {
    throw new InvalidRequestError({
      code: "INVALID_REQUEST",
      phase: "request",
      subject: "workspace",
      message: "Workspace path must be absolute",
    });
  }
  await assertNoSymlinkComponentsPromise(join(workspacePath, ".."));
  try {
    await mkdir(workspacePath, { mode: 0o700 });
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw io(workspacePath, "Workspace directory creation failed");
    }
  }
  await assertNoSymlinkComponentsPromise(workspacePath);
  const stat = await lstat(workspacePath);
  if (!stat.isDirectory())
    throw io(workspacePath, "Workspace path is not a directory");
  await chmod(workspacePath, 0o700);
  for (const name of ["plaintext", "generations"] as const) {
    const path = join(workspacePath, name);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw io(path, "Workspace subdirectory creation failed");
      }
    }
    await assertNoSymlinkComponentsPromise(path);
    if (!(await lstat(path)).isDirectory())
      throw io(path, "Workspace subdirectory is not a directory");
    await chmod(path, 0o700);
  }
};

export const initializeWorkspace = (
  workspacePath: string,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.tryPromise({
    try: () => initializeWorkspacePromise(workspacePath),
    catch: (error) =>
      error instanceof InvalidRequestError || error instanceof WorkspaceIoError
        ? error
        : io(workspacePath, "Workspace initialization failed"),
  });

/** Removes only abandoned atomic-write and staging names while the caller holds the workspace lock. */
export const cleanupWorkspaceTemporaries = (
  workspacePath: string,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        await assertNoSymlinkComponentsPromise(workspacePath);
        const roots = [
          workspacePath,
          join(workspacePath, "plaintext"),
          join(workspacePath, "generations"),
        ];
        for (const root of roots) {
          await assertNoSymlinkComponentsPromise(root);
          for (const entry of await readdir(root, { withFileTypes: true })) {
            const stagingDirectory =
              entry.isDirectory() &&
              /^\.tmp-[0-9]+-[0-9a-f]+$/u.test(entry.name);
            const atomicFile =
              entry.isFile() &&
              /^\.?[A-Za-z0-9._-]+\.tmp-[0-9]+-[0-9a-f]+$/u.test(entry.name);
            if (stagingDirectory || atomicFile) {
              await rm(join(root, entry.name), {
                recursive: stagingDirectory,
                force: true,
              });
            }
          }
        }
      },
      catch: (error) =>
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceIoError
          ? error
          : io(workspacePath, "Abandoned workspace cleanup failed"),
    }),
  );

export const writeWorkspaceState = (
  workspacePath: string,
  state: WorkspaceState,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  atomicWriteFile(
    join(workspacePath, "workspace.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );

const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

export const parseWorkspaceState = (text: string): WorkspaceState => {
  try {
    for (const key of ["schema", "prepareDigest", "generationDigest"])
      if (
        Array.from(text.matchAll(new RegExp(`"${key}"\\s*:`, "gu"))).length > 1
      )
        throw new TypeError();
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError();
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item);
    if (
      keys.some(
        (key) => !["schema", "prepareDigest", "generationDigest"].includes(key),
      ) ||
      item["schema"] !== WORKSPACE_SCHEMA ||
      (item["prepareDigest"] !== undefined && !digest(item["prepareDigest"])) ||
      (item["generationDigest"] !== undefined &&
        !digest(item["generationDigest"]))
    ) {
      throw new TypeError();
    }
    return {
      schema: WORKSPACE_SCHEMA,
      ...(item["prepareDigest"] === undefined
        ? {}
        : { prepareDigest: item["prepareDigest"] as string }),
      ...(item["generationDigest"] === undefined
        ? {}
        : { generationDigest: item["generationDigest"] as string }),
    };
  } catch {
    throw io("workspace.json", "Workspace checkpoint is invalid");
  }
};

export const readWorkspaceState = (
  workspacePath: string,
): Effect.Effect<WorkspaceState, InvalidRequestError | WorkspaceIoError> =>
  Effect.tryPromise({
    try: async () => {
      const path = join(workspacePath, "workspace.json");
      await assertNoSymlinkComponentsPromise(path);
      const bytes = await readFile(path);
      if (bytes.byteLength > 64 * 1024)
        throw io(path, "Workspace checkpoint exceeds its byte limit");
      return parseWorkspaceState(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    },
    catch: (error) =>
      error instanceof InvalidRequestError || error instanceof WorkspaceIoError
        ? error
        : io(workspacePath, "Workspace checkpoint read failed"),
  });

export const promoteWorkspaceDirectory = (
  temporaryPath: string,
  destinationPath: string,
  hooks: {
    readonly afterTransition?: (
      transition: "rename" | "parent-fsync",
    ) => void | Promise<void>;
  } = {},
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> => {
  if (!isAbsolute(temporaryPath) || !isAbsolute(destinationPath)) {
    return Effect.fail(
      new InvalidRequestError({
        code: "INVALID_REQUEST",
        phase: "request",
        subject: "workspace-promotion",
        message: "Promotion paths must be absolute",
      }),
    );
  }
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        await assertNoSymlinkComponentsPromise(temporaryPath);
        await assertNoSymlinkComponentsPromise(destinationPath, true);
        await rename(temporaryPath, destinationPath);
        await hooks.afterTransition?.("rename");
        const parent = await import("node:fs/promises").then((fs) =>
          fs.open(join(destinationPath, ".."), "r"),
        );
        try {
          await parent.sync();
          await hooks.afterTransition?.("parent-fsync");
        } finally {
          await parent.close();
        }
      },
      catch: (error) =>
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceIoError
          ? error
          : io(destinationPath, "Atomic workspace promotion failed"),
    }),
  );
};
