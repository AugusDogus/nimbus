import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseTree } from "./release-tree";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-tree-"));
  await mkdir(path.join(root, "apps/web/server"), { recursive: true });
  await writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n");
  await writeFile(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("apps/web", path.join(root, "web"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the same tree always has the same digest, and every kind of change shows", async () => {
  const before = await ReleaseTree.digest(root);
  expect(await ReleaseTree.digest(root)).toEqual(before);
  expect(before.entries).toBe(6);
  const changes: [string, () => Promise<void>, () => Promise<void>][] = [
    [
      "content",
      () =>
        writeFile(path.join(root, "apps/web/server/start.ts"), "// changed\n"),
      () =>
        writeFile(path.join(root, "apps/web/server/start.ts"), "// server\n"),
    ],
    [
      "mode",
      () => chmod(path.join(root, "run.sh"), 0o644),
      () => chmod(path.join(root, "run.sh"), 0o755),
    ],
    [
      "an extra file",
      () => writeFile(path.join(root, "extra.js"), ""),
      () => unlink(path.join(root, "extra.js")),
    ],
    [
      "a missing file",
      () => unlink(path.join(root, "run.sh")),
      () =>
        writeFile(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 }),
    ],
    [
      "a link target",
      async () => {
        await unlink(path.join(root, "web"));
        await symlink("apps", path.join(root, "web"));
      },
      async () => {
        await unlink(path.join(root, "web"));
        await symlink("apps/web", path.join(root, "web"));
      },
    ],
  ];
  for (const [what, change, undo] of changes) {
    await change();
    expect({
      what,
      same: (await ReleaseTree.digest(root)).sha256 === before.sha256,
    }).toEqual({
      what,
      same: false,
    });
    await undo();
    expect((await ReleaseTree.digest(root)).sha256).toBe(before.sha256);
  }
});

test("entries the installer adds can be left out", async () => {
  const before = await ReleaseTree.digest(root);
  await writeFile(path.join(root, "release-manifest.json"), "{}");
  expect(
    (await ReleaseTree.digest(root, new Set(["release-manifest.json"]))).sha256,
  ).toBe(before.sha256);
});
