import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileAtomic } from "../src/pipeline/finalize.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

test("atomic segment copy faults leave either no file or the complete durable file", async () => {
  for (const transition of ["file-fsync", "rename", "parent-fsync"] as const) {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "transcoder-copy-fault-")),
    );
    roots.push(root);
    const source = join(root, "source.m4s");
    const destination = join(root, "copy.m4s");
    await writeFile(source, "complete fragment", { mode: 0o600 });
    await expect(
      copyFileAtomic(source, destination, new AbortController().signal, {
        afterTransition: (current) => {
          if (current === transition) throw new Error("injected crash");
        },
      }),
    ).rejects.toThrow("injected crash");
    if (transition === "file-fsync")
      expect(await Bun.file(destination).exists()).toBe(false);
    else expect(await Bun.file(destination).text()).toBe("complete fragment");
    expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  }
});

test("atomic copy detects source mutation before promotion", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "transcoder-copy-mutation-")),
  );
  roots.push(root);
  const source = join(root, "source.m4s");
  const destination = join(root, "copy.m4s");
  await writeFile(source, "complete fragment", { mode: 0o600 });
  await expect(
    copyFileAtomic(source, destination, new AbortController().signal, {
      afterTransition: async (transition) => {
        if (transition === "file-fsync")
          await writeFile(source, "corrupt fragment", { mode: 0o600 });
      },
    }),
  ).rejects.toBeDefined();
  expect(await Bun.file(destination).exists()).toBe(false);
  expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
    false,
  );
});

test("already-aborted copy creates no destination or temporary", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "transcoder-copy-cancel-")),
  );
  roots.push(root);
  const source = join(root, "source.m4s");
  const destination = join(root, "copy.m4s");
  await writeFile(source, "fragment", { mode: 0o600 });
  const controller = new AbortController();
  controller.abort();
  await expect(
    copyFileAtomic(source, destination, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await Bun.file(destination).exists()).toBe(false);
  expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
    false,
  );
});

test("in-flight cancellation removes the partial atomic copy", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "transcoder-copy-inflight-cancel-")),
  );
  roots.push(root);
  const source = join(root, "source.m4s");
  const destination = join(root, "copy.m4s");
  await writeFile(source, Buffer.alloc(256 * 1024, 7), { mode: 0o600 });
  const controller = new AbortController();
  await expect(
    copyFileAtomic(source, destination, controller.signal, {
      afterChunk: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await Bun.file(destination).exists()).toBe(false);
  expect((await readdir(root)).some((name) => name.includes(".tmp-"))).toBe(
    false,
  );
});
