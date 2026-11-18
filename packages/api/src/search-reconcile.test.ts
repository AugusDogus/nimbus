import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, fstatSync, rmSync, symlinkSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyChange,
  crawl,
  fullListingEvery,
  reconcile,
  useCrawlerEnvironmentForTest,
  type Serialize,
} from "./search-crawler";
import { createSearchIndex, type SearchIndex } from "./search-index";

let root: string;
// Trees belong on disk where there is one: /tmp is often RAM-backed.
const scratch = existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
const direct: Serialize = (work) => work();

beforeEach(async () => {
  root = await mkdtemp(path.join(scratch, "nimbus-reconcile-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every entry with its kind and byte total, in a stable order. */
function dump(index: SearchIndex) {
  const entries: string[] = [];
  const walk = (id: number, prefix: string) => {
    for (const child of index.childrenOf(id)) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      entries.push(`${relative} ${child.kind} ${index.bytesAt(relative)}`);
      if (child.kind === "dir") walk(child.id, relative);
    }
  };
  walk(0, "");
  return { total: index.bytesAt(""), entries: entries.sort() };
}

async function fresh() {
  const index = createSearchIndex();
  await crawl(index, root);
  return dump(index);
}

/** A deterministic sequence, so a failing seed can be replayed. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
}

async function listAll(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".nimbus") continue;
    const absolute = path.join(directory, entry.name);
    found.push(absolute);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      found.push(...(await listAll(absolute)));
  }
  return found;
}

/** One random change made behind the index's back. */
async function change(next: () => number, step: number) {
  const all = await listAll(root);
  const folders = [
    root,
    ...(
      await Promise.all(
        all.map(async (entry) =>
          (await stat(entry).catch(() => null))?.isDirectory() ? entry : null,
        ),
      )
    ).filter((entry) => entry !== null),
  ];
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)];
  const folder = pick(folders) ?? root;
  const target = pick(all);
  const fresh = path.join(folder, `n${step}-${Math.floor(next() * 1000)}`);
  const content = "x".repeat(Math.floor(next() * 200));
  switch (Math.floor(next() * 9)) {
    case 0:
      await writeFile(`${fresh}.txt`, content);
      return;
    case 1:
      await mkdir(fresh);
      await writeFile(path.join(fresh, "inner.txt"), content);
      return;
    case 2:
      if (target) await rm(target, { recursive: true, force: true });
      return;
    case 3:
      // Rename in place, or move into another folder unless that folder is inside it.
      if (target && !folder.startsWith(`${target}/`) && folder !== target)
        await rename(target, path.join(folder, `moved-${step}`)).catch(
          () => undefined,
        );
      return;
    case 4:
      if (target && (await stat(target)).isFile())
        await writeFile(target, content);
      return;
    case 5:
      // A file replaced by a folder of the same name.
      if (target && (await stat(target)).isFile()) {
        await rm(target);
        await mkdir(target);
        await writeFile(path.join(target, "was-a-file.txt"), content);
      }
      return;
    case 6:
      // A folder replaced by a file of the same name.
      if (target && (await stat(target)).isDirectory()) {
        await rm(target, { recursive: true });
        await writeFile(target, content);
      }
      return;
    case 7:
      // Never indexed: symlinks and Nimbus's private folder.
      await symlink(root, `${fresh}.link`).catch(() => undefined);
      await mkdir(path.join(root, ".nimbus"), { recursive: true });
      await writeFile(path.join(root, ".nimbus", `${step}.txt`), content);
      return;
    case 8:
      await writeFile(`${fresh}.txt`, content);
      await rename(`${fresh}.txt`, `${fresh}-renamed.txt`);
      return;
  }
}

test("reconciling after random changes made behind the index's back matches a fresh crawl", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    const next = random(seed);
    for (let folder = 0; folder < 6; folder++) {
      await mkdir(path.join(root, `f${folder}/sub`), { recursive: true });
      for (let file = 0; file < 5; file++)
        await writeFile(
          path.join(root, `f${folder}`, `a${file}.txt`),
          "y".repeat(file * 7),
        );
    }
    const index = createSearchIndex();
    await crawl(index, root);
    for (let round = 0; round < 6; round++) {
      for (let step = 0; step < 15; step++)
        await change(next, round * 100 + step);
      // The changes really put the index out of date, or this round proves nothing.
      expect(
        JSON.stringify(dump(index)) !== JSON.stringify(await fresh()),
      ).toBe(true);
      const report = await reconcile(index, root, direct);
      expect({ seed, round, unreadable: report.unreadable }).toEqual({
        seed,
        round,
        unreadable: 0,
      });
      expect({ seed, round, ...dump(index) }).toEqual({
        seed,
        round,
        ...(await fresh()),
      });
    }
    // Search still finds what is there after the churn, and nothing that is gone. Symlinks are
    // never indexed, so the sample is a file or folder, chosen in name order: directory order
    // differs between filesystems (ext4 lists by hash).
    const indexed = [];
    for (const entry of await listAll(root))
      if (!(await lstat(entry)).isSymbolicLink()) indexed.push(entry);
    const sample = indexed
      .map((entry) => path.basename(entry))
      .sort()
      .find((name) => name.startsWith("moved-") || name.startsWith("n"));
    if (sample)
      expect(
        index.search({
          query: sample,
          root: "",
          limit: 50,
          scope: { type: "all" },
        }).hits.length,
      ).toBeGreaterThan(0);
  }
});

test("searches during a pass keep finding unchanged entries exactly once", async () => {
  for (let folder = 0; folder < 40; folder++) {
    await mkdir(path.join(root, `f${folder}`));
    for (let file = 0; file < 20; file++)
      await writeFile(path.join(root, `f${folder}`, `file-${file}.txt`), "z");
  }
  await writeFile(path.join(root, "f7", "steady-needle.txt"), "steady");
  const index = createSearchIndex();
  await crawl(index, root);
  for (let folder = 0; folder < 40; folder += 3) {
    await rm(path.join(root, `f${folder}`, "file-3.txt"));
    await writeFile(path.join(root, `f${folder}`, "fresh-needle.txt"), "new");
  }
  const counts: number[] = [];
  const searching: Serialize = async (work) => {
    const result = await work();
    counts.push(
      index.search({
        query: "steady-needle",
        root: "",
        limit: 10,
        scope: { type: "all" },
      }).hits.length,
    );
    return result;
  };
  const report = await reconcile(index, root, searching);
  expect(report.folders).toBe(41);
  expect(new Set(counts)).toEqual(new Set([1]));
  expect(
    index.search({
      query: "fresh-needle",
      root: "",
      limit: 50,
      scope: { type: "all" },
    }).hits,
  ).toHaveLength(14);
  expect(dump(index)).toEqual(await fresh());
});

test("watcher changes interleaved with a pass leave the index matching the disk", async () => {
  for (let folder = 0; folder < 30; folder++) {
    await mkdir(path.join(root, `f${folder}`));
    await writeFile(path.join(root, `f${folder}`, "a.txt"), "a");
  }
  const index = createSearchIndex();
  await crawl(index, root);
  // Serialize like the search worker: one queue for slices and watcher changes.
  let queue = Promise.resolve();
  const serialize: Serialize = (work) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const pass = reconcile(index, root, serialize);
  const watcherChanges = [];
  for (let folder = 0; folder < 30; folder++) {
    const file = path.join(root, `f${folder}`, `during-${folder}.txt`);
    await writeFile(file, "during the pass");
    watcherChanges.push(serialize(() => applyChange(index, root, file)));
    if (folder % 5 === 0) {
      await rm(path.join(root, `f${folder}`), { recursive: true });
      watcherChanges.push(
        serialize(() =>
          applyChange(index, root, path.join(root, `f${folder}`)),
        ),
      );
    }
  }
  await Promise.all([pass, ...watcherChanges]);
  expect(dump(index)).toEqual(await fresh());
});

test("keeps files it cannot state, and counts their folder as unreadable", async () => {
  await mkdir(path.join(root, "locked"));
  await writeFile(path.join(root, "locked", "kept.txt"), "kept");
  const index = createSearchIndex();
  await crawl(index, root);
  const before = dump(index);
  // Listable but not searchable: names can be read, but not stated.
  await chmod(path.join(root, "locked"), 0o644);
  try {
    const report = await reconcile(index, root, direct);
    expect(report.unreadable).toBe(1);
    expect(dump(index)).toEqual(before);
  } finally {
    await chmod(path.join(root, "locked"), 0o755);
  }
});

const asRoot = process.getuid?.() === 0;
const rootSkip = "running as root, where folder permissions do not apply";

test.skipIf(asRoot)(
  `crawls and passes name each folder they cannot read, and why${asRoot ? ` (skipped: ${rootSkip})` : ""}`,
  async () => {
    await mkdir(path.join(root, "a/locked/inside"), { recursive: true });
    await mkdir(path.join(root, "b"));
    await mkdir(path.join(root, "c"));
    await writeFile(path.join(root, "c/file.txt"), "c");
    await chmod(path.join(root, "a/locked"), 0);
    await chmod(path.join(root, "b"), 0);
    try {
      const index = createSearchIndex();
      const crawled = await crawl(index, root);
      const named = (folders: { path: string; code: string | null }[]) =>
        [...folders].sort((x, y) => (x.path < y.path ? -1 : 1));
      const expected = [
        { path: "a/locked", code: "EACCES" },
        { path: "b", code: "EACCES" },
      ];
      expect(named(crawled.unreadableFolders)).toEqual(expected);
      const report = await reconcile(index, root, direct);
      expect(named(report.unreadableFolders)).toEqual(expected);
      expect(report.unreadable).toBe(2);
    } finally {
      await chmod(path.join(root, "a/locked"), 0o755);
      await chmod(path.join(root, "b"), 0o755);
    }
  },
);

/** `shared/docs/a.txt` inside the root, and `outside/docs/outside-secret.txt` beside it. */
async function swapTree() {
  await mkdir(path.join(root, "drive/shared/docs"), { recursive: true });
  await writeFile(path.join(root, "drive/shared/docs/a.txt"), "a");
  await mkdir(path.join(root, "outside/docs"), { recursive: true });
  await writeFile(path.join(root, "outside/docs/outside-secret.txt"), "12345");
  await writeFile(path.join(root, "outside/outside-secret.txt"), "12345");
  return path.join(root, "drive");
}

/** Index text of every entry, to look for anything from outside the drive. */
const paths = (index: SearchIndex) => dump(index).entries.join("\n");

for (const swapped of ["shared/docs", "shared"])
  test(`never follows ${swapped} swapped for a symlink after it was queued`, async () => {
    // Folders are read root first, then shared, then shared/docs: the swap
    // lands after the folder above the swapped one was listed.
    const at = swapped === "shared" ? 1 : 2;
    const swap = (drive: string) => {
      rmSync(path.join(drive, swapped), { recursive: true });
      symlinkSync(
        path.join(root, swapped === "shared" ? "outside" : "outside/docs"),
        path.join(drive, swapped),
      );
    };
    let drive = await swapTree();
    let reads = 0;
    const crawled = createSearchIndex();
    await crawl(crawled, drive, () => {
      if (reads++ === at) swap(drive);
      return false;
    });
    expect(reads).toBeGreaterThan(at);
    expect(paths(crawled)).not.toContain("outside-secret");

    await rm(path.join(root, "drive"), { recursive: true });
    await rm(path.join(root, "outside"), { recursive: true });
    drive = await swapTree();
    const index = createSearchIndex();
    await crawl(index, drive);
    let slices = 0;
    const swapping: Serialize = async (work) => {
      if (slices++ === at) swap(drive);
      return work();
    };
    await reconcile(index, drive, swapping);
    expect(slices).toBeGreaterThan(at);
    expect(paths(index)).not.toContain("outside-secret");
  });

test("empties the index when the data root itself is gone", async () => {
  const drive = path.join(root, "drive");
  await mkdir(path.join(drive, "docs"), { recursive: true });
  await writeFile(path.join(drive, "docs", "a.txt"), "abc");
  const index = createSearchIndex();
  await crawl(index, drive);
  expect(index.bytesAt("")).toBe(3);
  await rm(drive, { recursive: true });
  await reconcile(index, drive, direct);
  expect(dump(index)).toEqual({ total: 0, entries: [] });
});

test("finds entries added behind its back even when the folder's time is set back", async () => {
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "a.txt"), "a");
  // Times a host process can set back exactly; it cannot set the change time.
  const time = 1_700_000_000;
  await utimes(path.join(root, "docs"), time, time);
  const index = createSearchIndex();
  await crawl(index, root);
  await writeFile(path.join(root, "docs", "b.txt"), "bb");
  await rm(path.join(root, "docs", "a.txt"));
  await utimes(path.join(root, "docs"), time, time);
  // Sizes change without any entry changing.
  await reconcile(index, root, direct);
  expect(dump(index)).toEqual(await fresh());
  await writeFile(path.join(root, "docs", "b.txt"), "bigger now");
  await reconcile(index, root, direct);
  expect(dump(index)).toEqual(await fresh());
});

test("a folder changed in the same clock tick as its listing is listed again", async () => {
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/a.txt"), "a");
  // A coarse clock that has not ticked: every change since stamps this same change time.
  const tick = (await stat(path.join(root, "docs"))).ctimeMs;
  let now = tick + 1;
  const restore = useCrawlerEnvironmentForTest({
    now: () => now,
    statFolder: (fd) => ({ ...fstatSync(fd), ctimeMs: tick }),
  });
  try {
    const index = createSearchIndex();
    await crawl(index, root);
    // Added in the tick the folder was listed in, so its change time reads as before.
    await writeFile(path.join(root, "docs/b.txt"), "b");
    await reconcile(index, root, direct);
    expect(dump(index).entries).toContain("docs/b.txt file 1");
    // Once its change time is old enough to tell changes apart, a settled folder is trusted:
    // later passes only state its files, listing each folder in full once every
    // `fullListingEvery` passes.
    now = tick + 10_000;
    await reconcile(index, root, direct);
    let listed = 0;
    for (let pass = 0; pass < fullListingEvery; pass++)
      listed += (await reconcile(index, root, direct)).listed;
    // The root and docs.
    expect(listed).toBe(2);
  } finally {
    restore();
  }
});

test("a trusted folder is still listed in full within a bounded number of passes", async () => {
  // Storage whose clock runs behind can make a fresh change look settled; with a coarse
  // timestamp, an entry added in that same tick leaves the identity as recorded.
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs/a.txt"), "a");
  const tick = (await stat(path.join(root, "docs"))).ctimeMs;
  const restore = useCrawlerEnvironmentForTest({
    now: () => tick + 60_000,
    statFolder: (fd) => ({ ...fstatSync(fd), ctimeMs: tick }),
  });
  try {
    const index = createSearchIndex();
    await crawl(index, root);
    await writeFile(path.join(root, "docs/b.txt"), "b");
    let passes = 0;
    while (!dump(index).entries.includes("docs/b.txt file 1") && passes < 64) {
      await reconcile(index, root, direct);
      passes++;
    }
    expect(passes).toBeLessThanOrEqual(fullListingEvery);
  } finally {
    restore();
  }
});
