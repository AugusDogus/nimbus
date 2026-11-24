import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReleaseCopy } from "./release-copy";

let scratch: string;
let staged: string;
let copy: string;
const owner = process.getuid?.() ?? 0;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "nimbus-copy-"));
  staged = path.join(scratch, "staged");
  copy = path.join(scratch, "releases/copy");
  await mkdir(path.join(staged, "apps/web/server"), { recursive: true });
  await mkdir(path.join(scratch, "releases"));
  await writeFile(path.join(staged, "apps/web/server/start.ts"), "start\n");
  await writeFile(path.join(staged, "apps/web/run.sh"), "#!/bin/sh\n", {
    mode: 0o700,
  });
  await symlink("server/start.ts", path.join(staged, "apps/web/entry.ts"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const copied = (limits?: Partial<typeof ReleaseCopy.limits>) =>
  ReleaseCopy.copy(staged, copy, {
    owner,
    limits: { ...ReleaseCopy.limits, ...limits },
  });

test("files, folders and links inside are copied with fixed modes, links as links", async () => {
  expect(await copied()).toEqual({ ok: true, entries: 6 });
  expect(
    await readFile(path.join(copy, "apps/web/server/start.ts"), "utf8"),
  ).toBe("start\n");
  expect((await stat(path.join(copy, "apps/web/run.sh"))).mode & 0o7777).toBe(
    0o755,
  );
  expect(
    (await stat(path.join(copy, "apps/web/server/start.ts"))).mode & 0o7777,
  ).toBe(0o644);
  expect((await stat(path.join(copy, "apps/web"))).mode & 0o7777).toBe(0o755);
  expect(
    (await lstat(path.join(copy, "apps/web/entry.ts"))).isSymbolicLink(),
  ).toBe(true);
  expect(await readlink(path.join(copy, "apps/web/entry.ts"))).toBe(
    "server/start.ts",
  );
});

test("anything but plain files, folders and links inside is refused, and the partial copy removed", async () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    [
      "hard link",
      () =>
        link(
          path.join(staged, "apps/web/server/start.ts"),
          path.join(staged, "apps/web/twin.ts"),
        ),
      "hard link",
    ],
    [
      "pipe",
      async () => Bun.spawnSync(["mkfifo", path.join(staged, "apps/web/pipe")]),
      "not a file",
    ],
    [
      "set-id bit",
      () => chmod(path.join(staged, "apps/web/run.sh"), 0o4755),
      "set-id",
    ],
    [
      "absolute link",
      () => symlink("/etc/passwd", path.join(staged, "apps/web/out")),
      "outside",
    ],
    [
      "link out of the tree",
      () => symlink("../../../..", path.join(staged, "apps/web/up")),
      "outside",
    ],
    [
      "dangling link",
      () => symlink("nowhere.ts", path.join(staged, "apps/web/gone")),
      "leads nowhere",
    ],
  ];
  for (const [what, plant, message] of cases) {
    await plant();
    const result = await copied();
    expect({ what, ok: result.ok }).toEqual({ what, ok: false });
    if (!result.ok) expect(result.message).toContain(message);
    expect(await stat(copy).catch(() => null)).toBeNull();
    await rm(staged, { recursive: true, force: true });
    await mkdir(path.join(staged, "apps/web/server"), { recursive: true });
    await writeFile(path.join(staged, "apps/web/server/start.ts"), "start\n");
    await writeFile(path.join(staged, "apps/web/run.sh"), "#!/bin/sh\n");
  }
});

test("what another user owns is refused", async () => {
  const result = await ReleaseCopy.copy(staged, copy, {
    owner: owner + 1,
    limits: ReleaseCopy.limits,
  });
  expect(result.ok || result.message).toContain("belongs to user");
  expect(await stat(copy).catch(() => null)).toBeNull();
});

test("the archive's caps hold again: entries, depth, file and total size", async () => {
  for (const [limits, message] of [
    [{ maxEntries: 3 }, "entries"],
    [{ maxDepth: 2 }, "deep"],
    [{ maxFileBytes: 4 }, "larger"],
    [{ maxTotalBytes: 12 }, "in all"],
  ] as const) {
    const result = await copied(limits);
    expect({ limits, ok: result.ok }).toEqual({ limits, ok: false });
    if (!result.ok) expect(result.message).toContain(message);
    expect(await stat(copy).catch(() => null)).toBeNull();
  }
});

test("a staged tree that is itself a link is not followed", async () => {
  const linked = path.join(scratch, "linked");
  await symlink(staged, linked);
  const result = await ReleaseCopy.copy(linked, copy, {
    owner,
    limits: ReleaseCopy.limits,
  });
  expect(result.ok).toBe(false);
});

test("modes are fixed whatever the umask, so the servers can traverse the copy", async () => {
  const before = process.umask(0o077);
  try {
    expect((await copied()).ok).toBe(true);
  } finally {
    process.umask(before);
  }
  for (const folder of [
    copy,
    path.join(copy, "apps"),
    path.join(copy, "apps/web"),
  ])
    expect((await stat(folder)).mode & 0o7777).toBe(0o755);
  expect(
    (await stat(path.join(copy, "apps/web/server/start.ts"))).mode & 0o7777,
  ).toBe(0o644);
});
