import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileVersions, versionRetention } from "./file-versions";
import { createTestFileVersionStore } from "./file-versions-testing";

let root: string;
let store: ReturnType<typeof createTestFileVersionStore>;
let clock = 1_000;
const staged = async (content: string) => {
  const file = path.join(root, ".nimbus", "uploads", `${clock}.tmp`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
};
const save = async (target: string, content: string) =>
  FileVersions.commitReplacement({
    store,
    dataRoot: root,
    target,
    incoming: await staged(content),
    archivedBy: "editor",
    now: ++clock,
  });
const contents = async (target: string) =>
  Promise.all(
    (await FileVersions.history(store, target)).map(async (version) => {
      const found = await FileVersions.find(store, target, version.id);
      if (!found)
        throw new Error(`Version ${version.id} is missing for ${target}.`);
      return readFile(found.payload(root), "utf8");
    }),
  );

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-versions-"));
  store = createTestFileVersionStore();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("replacing a file keeps its previous content as a version without copying it", async () => {
  const target = path.join(root, "notes.txt");
  expect(await save(target, "first")).toEqual({ kind: "created" });
  const original = await stat(target);
  const result = await save(target, "second");
  expect(await readFile(target, "utf8")).toBe("second");
  if (result.kind !== "replaced" || !result.version)
    throw new Error("Expected a kept version.");
  expect(result.version).toMatchObject({
    name: "notes.txt",
    size: 5,
    archivedBy: "editor",
  });
  const found = await FileVersions.find(store, target, result.version.id);
  if (!found) throw new Error("The new version is not attached to the file.");
  // The version is the old inode itself, preserved by hardlink.
  expect((await stat(found.payload(root))).ino).toBe(original.ino);
  await save(target, "third");
  expect(await contents(target)).toEqual(["second", "first"]);
});

test("history follows renames and moves, and stays with the file it belongs to", async () => {
  const target = path.join(root, "draft.txt");
  await save(target, "one");
  await save(target, "two");
  await mkdir(path.join(root, "archive"));
  const moved = path.join(root, "archive", "final.txt");
  await rename(target, moved);
  expect(await contents(moved)).toEqual(["one"]);
  const other = path.join(root, "other.txt");
  await save(other, "unrelated");
  expect(await FileVersions.history(store, other)).toEqual([]);
  const [version] = await FileVersions.history(store, moved);
  expect(
    version && (await FileVersions.find(store, other, version.id)),
  ).toBeNull();
});

test("restoring a version keeps the current content as a new version", async () => {
  const target = path.join(root, "report.txt");
  await save(target, "v1");
  await save(target, "v2");
  const [first] = await FileVersions.history(store, target);
  if (!first) throw new Error("Expected a version.");
  const result = await FileVersions.restore({
    store,
    dataRoot: root,
    target,
    id: first.id,
    archivedBy: "editor",
  });
  expect(result.kind).toBe("replaced");
  expect(await readFile(target, "utf8")).toBe("v1");
  expect((await contents(target)).sort()).toEqual(["v1", "v2"]);
  // The live file never shares an inode with its history.
  const live = await stat(target);
  for (const version of await FileVersions.history(store, target)) {
    const found = await FileVersions.find(store, target, version.id);
    expect(found && (await stat(found.payload(root))).ino).not.toBe(live.ino);
  }
  expect(
    await FileVersions.restore({
      store,
      dataRoot: root,
      target,
      id: "00000000-0000-4000-8000-000000000000",
      archivedBy: null,
    }),
  ).toEqual({ kind: "not-found" });
});

test("each file keeps a bounded number of versions", async () => {
  const target = path.join(root, "busy.txt");
  for (let index = 0; index <= versionRetention.maxCount + 2; index++)
    await save(target, `save ${index}`);
  const history = await FileVersions.history(store, target);
  expect(history).toHaveLength(versionRetention.maxCount);
  expect(
    await readFile(
      (
        await FileVersions.find(store, target, history.at(-1)?.id ?? "")
      )?.payload(root) ?? "",
      "utf8",
    ),
  ).toBe("save 2");
  const payloads = (
    await Promise.all(
      (await readdir(path.join(root, ".nimbus", "versions"))).map((shard) =>
        readdir(path.join(root, ".nimbus", "versions", shard)),
      ),
    )
  ).flat();
  expect(payloads).toHaveLength(versionRetention.maxCount);
});

test("permanent deletion and age limits remove history and payloads", async () => {
  const folder = path.join(root, "project");
  await mkdir(folder);
  const kept = path.join(root, "kept.txt");
  await save(path.join(folder, "a.txt"), "a1");
  await save(path.join(folder, "a.txt"), "a2");
  await save(kept, "k1");
  await save(kept, "k2");
  await FileVersions.discardTree(store, root, folder);
  expect(await contents(kept)).toEqual(["k1"]);
  // An orphaned payload from an interrupted save is swept once it is old.
  const orphan = path.join(
    root,
    ".nimbus",
    "versions",
    "ab",
    "ab000000-0000-4000-8000-000000000000",
  );
  await mkdir(path.dirname(orphan), { recursive: true });
  await writeFile(orphan, "orphan");
  await utimes(orphan, new Date(0), new Date(0));
  await FileVersions.cleanup(
    store,
    root,
    clock + versionRetention.maxAgeMs + 1,
  );
  expect(await FileVersions.history(store, kept)).toEqual([]);
  // ctime cannot be set from userspace; a fresh orphan is retained for a day.
  expect(await readdir(path.dirname(orphan))).toEqual([
    "ab000000-0000-4000-8000-000000000000",
  ]);
  await FileVersions.cleanup(store, root, Date.now() + 2 * 24 * 60 * 60 * 1000);
  expect(await readdir(path.dirname(orphan))).toEqual([]);
});

test("replacing an empty file keeps no version but keeps earlier history", async () => {
  const target = path.join(root, "locked.txt");
  // WebDAV clients often LOCK a new path, creating an empty file, then PUT it.
  await save(target, "");
  expect(await save(target, "content")).toEqual({
    kind: "replaced",
    version: null,
  });
  expect(await FileVersions.history(store, target)).toEqual([]);
  await save(target, "");
  await save(target, "again");
  expect(await contents(target)).toEqual(["content"]);
});

test("moving a file over another keeps the destination's history and discards the moved file's", async () => {
  // Save-by-replace editors and WebDAV MOVE or COPY with Overwrite commit a live file over the target.
  const original = path.join(root, "report.txt");
  const draft = path.join(root, "draft.txt");
  await save(original, "report v1");
  await save(original, "report v2");
  await save(draft, "draft v1");
  await save(draft, "draft v2");
  const result = await FileVersions.commitReplacement({
    store,
    dataRoot: root,
    target: original,
    incoming: draft,
    archivedBy: "editor",
  });
  expect(result.kind).toBe("replaced");
  expect(await readFile(original, "utf8")).toBe("draft v2");
  expect(await contents(original)).toEqual(["report v2", "report v1"]);
  expect(
    (await store.archivedBefore(Number.MAX_SAFE_INTEGER))
      .map((version) => version.name)
      .sort(),
  ).toEqual(["report.txt", "report.txt"]);
});
