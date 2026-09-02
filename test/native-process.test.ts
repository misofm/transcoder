import { expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";

import { Cause, Effect, Fiber } from "effect";

import { makeNodeNativeProcess } from "../src/process/node-native-process.js";

test("executes one file with an argv array, no shell, and drains all output pipes", async () => {
  const calls: Array<{
    readonly file: string;
    readonly args: ReadonlyArray<string>;
    readonly options: SpawnOptions;
  }> = [];
  const service = makeNodeNativeProcess({
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return spawn(file, args, options);
    },
  });
  const hostile = "input $(touch SHOULD_NOT_EXIST); *.wav ' quoted";
  const script = [
    "const fs = require('node:fs')",
    "process.stdout.write(JSON.stringify(process.argv[1]))",
    "process.stderr.write('safe stderr')",
    "fs.writeSync(3, 'progress=end\\n')",
  ].join(";");

  const result = await Effect.runPromise(
    service.run({
      role: "test",
      executable: process.execPath,
      args: ["-e", script, hostile],
    }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.file).toBe(process.execPath);
  expect(calls[0]?.args).toEqual(["-e", script, hostile]);
  expect(calls[0]?.options).toMatchObject({
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toBe(hostile);
  expect(new TextDecoder().decode(result.stderrTail)).toBe("safe stderr");
  expect(new TextDecoder().decode(result.progressTail)).toBe("progress=end\n");
});

test("fails with a typed error when collected stdout exceeds its ceiling", async () => {
  const service = makeNodeNativeProcess({ forceKillAfterMs: 25 });
  const exit = await Effect.runPromiseExit(
    service.run({
      role: "ffprobe",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(8192))"],
      stdoutLimitBytes: 64,
    }),
  );

  expect(exit._tag).toBe("Failure");
  expect(String(exit)).toContain("ProcessOutputLimitError");
});

test("maps synchronous spawn failures without exposing arguments", async () => {
  const service = makeNodeNativeProcess({
    spawn: () => {
      throw Object.assign(new Error("secret-looking implementation detail"), {
        code: "ENOENT",
      });
    },
  });
  const exit = await Effect.runPromiseExit(
    service.run({
      role: "ffmpeg",
      executable: "/missing/ffmpeg",
      args: ["private-input.wav"],
    }),
  );

  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    expect(reason).toBeDefined();
    if (reason === undefined || !Cause.isFailReason(reason)) return;
    const failure = reason.error;
    expect(failure).toMatchObject({ reason: "ENOENT" });
    expect(JSON.stringify(failure)).not.toContain("private-input.wav");
    expect(JSON.stringify(failure)).not.toContain("secret-looking");
  }
});

test("interruption terminates a scoped child and escalates to force-kill", async () => {
  let child: ChildProcess | undefined;
  const service = makeNodeNativeProcess({
    forceKillAfterMs: 25,
    spawn: (file, args, options) => {
      child = spawn(file, args, options);
      return child;
    },
  });
  const fiber = Effect.runFork(
    service.run({
      role: "test",
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await Effect.runPromise(Fiber.interrupt(fiber));

  expect(child).toBeDefined();
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
});
