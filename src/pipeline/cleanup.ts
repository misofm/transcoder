import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { InvalidRequestError, WorkspaceIoError } from "../errors.js";
import type { PreparedTranscode, TranscodeArtifact } from "../model.js";
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
        const checkpointPath = join(prepared.rootPath, "prepared.json");
        const handle = await open(
          checkpointPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        let checkpointBytes: Buffer;
        try {
          const checkpointMetadata = await handle.stat();
          if (
            !checkpointMetadata.isFile() ||
            checkpointMetadata.size < 1 ||
            checkpointMetadata.size > 4_194_304
          )
            throw io(checkpointPath, "Cleanup checkpoint exceeds its limit");
          checkpointBytes = Buffer.allocUnsafe(checkpointMetadata.size);
          let offset = 0;
          while (offset < checkpointBytes.byteLength) {
            const result = await handle.read(
              checkpointBytes,
              offset,
              checkpointBytes.byteLength - offset,
              null,
            );
            if (result.bytesRead === 0)
              throw io(
                checkpointPath,
                "Cleanup checkpoint changed during read",
              );
            offset += result.bytesRead;
          }
          if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0)
            throw io(checkpointPath, "Cleanup checkpoint changed during read");
        } finally {
          await handle.close();
        }
        const checkpoint = JSON.parse(
          checkpointBytes.toString("utf8"),
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

/** Explicitly removes only a canonical verified transcode generation directory. */
export const cleanupTranscodeArtifact = (
  artifact: TranscodeArtifact,
): Effect.Effect<void, InvalidRequestError | WorkspaceIoError> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        if (
          !isAbsolute(artifact.rootPath) ||
          !/^[0-9a-f]{64}$/u.test(artifact.transcodeDigest) ||
          basename(artifact.rootPath) !== artifact.transcodeDigest ||
          basename(dirname(artifact.rootPath)) !== "generations"
        )
          throw invalid(
            artifact.rootPath,
            "Cleanup target is not a canonical transcode directory",
          );
        await assertNoSymlinkComponentsPromise(dirname(artifact.rootPath));
        try {
          const metadata = await lstat(artifact.rootPath);
          if (!metadata.isDirectory() || metadata.isSymbolicLink())
            throw io(
              artifact.rootPath,
              "Cleanup target is not a safe directory",
            );
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw error;
        }
        await rm(artifact.rootPath, { recursive: true });
      },
      catch: (error) =>
        error instanceof InvalidRequestError ||
        error instanceof WorkspaceIoError
          ? error
          : io(artifact.rootPath, "Transcode cleanup failed"),
    }),
  );
