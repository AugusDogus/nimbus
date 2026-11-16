import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDirectory } from "./file-browser";

let root: string;
let previousRoot: string | undefined;
const everyone = { canBrowse: () => true };

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-browser-"));
  process.env.NIMBUS_DATA_ROOT = root;
  await mkdir(path.join(root, "docs/inner"), { recursive: true });
  await writeFile(path.join(root, "docs/a.txt"), "abc");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

test("lists files and folders with their sizes, skipping what safe paths refuse", async () => {
  await symlink(path.join(root, "docs/a.txt"), path.join(root, "docs/link"));
  await symlink(root, path.join(root, "docs/escape"));
  await writeFile(path.join(root, "docs/back\\slash"), "x");
  await writeFile(path.join(root, "docs/line\nbreak"), "x");
  await mkdir(path.join(root, "docs/.NIMBUS"));
  const entries = await readDirectory("docs", everyone);
  expect(
    entries
      .map(({ name, path, type, size }) => ({ name, path, type, size }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual([
    { name: "a.txt", path: "docs/a.txt", type: "file", size: 3 },
    { name: "inner", path: "docs/inner", type: "dir", size: 0 },
  ]);
});

test("only lists what the caller may browse, and refuses symlinked folders", async () => {
  expect(
    (await readDirectory("docs", { canBrowse: (p) => p === "docs/inner" })).map(
      (entry) => entry.name,
    ),
  ).toEqual(["inner"]);
  await symlink(path.join(root, "docs"), path.join(root, "alias"));
  await expect(readDirectory("alias", everyone)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
