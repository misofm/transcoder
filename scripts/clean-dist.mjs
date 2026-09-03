import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const root = resolve(process.cwd());
const target = resolve(root, "dist");

if (basename(target) !== "dist" || dirname(target) !== root)
  throw new Error("Refusing to clean an unexpected build directory");

await rm(target, { recursive: true, force: true });
