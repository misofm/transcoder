import { lstat, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { InvalidRequestError, WorkspaceIoError } from "../errors.js";
import type { PreparedTranscode } from "../model.js";
import { assertNoSymlinkComponentsPromise } from "../workspace/atomic-file.js";

const invalid = (subject: string, message: string) =>
  new InvalidRequestError({
    code: "INVALID_REQUEST",
    phase: "request",
    subject,
    message,
  });

const io = (subject: string, message: string) =>
  new WorkspaceIoError({
    code: "WORKSPACE_IO",
    phase: "workspace",
    subject,
    message,
  });

/** Explicitly removes only a validated prepared plaintext checkpoint. */
export const cleanupPreparedTranscode = (
  prepared: PreparedTranscode,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        if (
          !isAbsolute(prepared.rootPath) ||
          !/^[0-9a-f]{64}$/u.test(prepared.prepareDigest) ||
          basename(prepared.rootPath) !== prepared.prepareDigest ||
          basename(dirname(prepared.rootPath)) !== "plaintext"
        ) {
          throw invalid(
            prepared.rootPath,
            "Cleanup target is not a canonical prepared plaintext directory",
          );
        }
        try {
          await assertNoSymlinkComponentsPromise(prepared.rootPath);
        } catch (error) {
          if (error instanceof WorkspaceIoError) {
            // The strict component checker intentionally hides OS details, so
            // establish idempotence through the canonical parent below.
            await assertNoSymlinkComponentsPromise(dirname(prepared.rootPath));
            try {
              await lstat(prepared.rootPath);
            } catch (missing) {
              if (
                missing instanceof Error &&
                "code" in missing &&
                missing.code === "ENOENT"
              )
                return;
            }
          }
          throw error;
        }
        const metadata = await lstat(prepared.rootPath);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw io(prepared.rootPath, "Cleanup target is not a safe directory");
        }
        const checkpoint = JSON.parse(
          await readFile(join(prepared.rootPath, "prepared.json"), "utf8"),
        ) as Record<string, unknown>;
        if (
          checkpoint["schema"] !== "miso.transcoder-prepared/1" ||
          checkpoint["prepareDigest"] !== prepared.prepareDigest ||
          checkpoint["rootPath"] !== prepared.rootPath
        ) {
          throw io(
            prepared.rootPath,
            "Cleanup checkpoint does not match its target",
          );
        }
        await rm(prepared.rootPath, { recursive: true });
      },
      catch: (error) =>
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceIoError
          ? error
          : io(prepared.rootPath, "Prepared plaintext cleanup failed"),
    }),
  );
