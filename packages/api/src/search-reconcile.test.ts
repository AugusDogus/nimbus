import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyChange,
  crawl,
  reconcile,
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
    // Search still finds what is there after the churn, and nothing that is gone.
    const names = (await listAll(root)).map((entry) => path.basename(entry));
    const sample = names.find(
      (name) => name.startsWith("moved-") || name.startsWith("n"),
    );
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
