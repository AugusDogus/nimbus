import { afterEach, beforeEach, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
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
const at = (relative: string) => path.join(root, relative);
/** The version store, plus claims of vacant paths as the drive store makes them. */
const drive = () => ({
  versions: store,
  claimVacant: async (relative: string) => {
    await store.removeAt(relative);
  },
  caseVariants: async () => [],
  hasRecordsNear: async () => true,
});
const staged = async (content: string) => {
  const file = path.join(root, ".nimbus", "uploads", `${clock}.tmp`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
};
const save = async (relative: string, content: string) =>
  FileVersions.commitReplacement({
    drive: drive(),
    dataRoot: root,
    path: relative,
    incoming: await staged(content),
    archivedBy: "editor",
    now: ++clock,
  });
/** Whether `directory`'s filesystem clones files (reflinks), which version saves try first. */
const clonesFiles = async (directory: string) => {
  const probe = path.join(directory, ".clone-probe");
  await writeFile(probe, "probe");
  try {
    await copyFile(
      probe,
      `${probe}.clone`,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
    );
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true });
    await rm(`${probe}.clone`, { force: true });
  }
};
const contents = async (relative: string) =>
  Promise.all(
    (await FileVersions.history(store, relative)).map(async (version) => {
      const found = await FileVersions.find(store, relative, version.id);
      if (!found)
        throw new Error(`Version ${version.id} is missing for ${relative}.`);
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
  expect(await save("notes.txt", "first")).toEqual({ kind: "created" });
  // Not written for a while, so without reflinks no writer is likely to hold it open.
  const quiet = new Date(Date.now() - 5 * 60 * 1000);
  await utimes(at("notes.txt"), quiet, quiet);
  const original = await stat(at("notes.txt"));
  const result = await save("notes.txt", "second");
  expect(await readFile(at("notes.txt"), "utf8")).toBe("second");
  if (result.kind !== "replaced" || !result.version)
    throw new Error("Expected a kept version.");
  expect(result.version).toMatchObject({
    path: "notes.txt",
    name: "notes.txt",
    size: 5,
    archivedBy: "editor",
  });
  const found = await FileVersions.find(store, "notes.txt", result.version.id);
  if (!found) throw new Error("The new version is not attached to the file.");
  const payload = await stat(found.payload(root));
  if (await clonesFiles(root))
    // A reflink: its own inode sharing the old extents, so a writer of the old inode cannot
    // change it.
    expect(payload.ino).not.toBe(original.ino);
  // Without reflinks, the old inode itself, preserved by hardlink.
  else expect(payload.ino).toBe(original.ino);
  await save("notes.txt", "third");
  expect(await contents("notes.txt")).toEqual(["second", "first"]);
});

test("history follows Nimbus moves and stays with the file it belongs to", async () => {
  await save("draft.txt", "one");
  await save("draft.txt", "two");
  await mkdir(at("archive"));
  await rename(at("draft.txt"), at("archive/final.txt"));
  // The drive store relocates history in the transaction that moves links and grants.
  store.relocate("draft.txt", "archive/final.txt");
  expect(await contents("archive/final.txt")).toEqual(["one"]);
  await save("other.txt", "unrelated");
  expect(await FileVersions.history(store, "other.txt")).toEqual([]);
  const [version] = await FileVersions.history(store, "archive/final.txt");
  expect(
    version && (await FileVersions.find(store, "other.txt", version.id)),
  ).toBeNull();
});

test("history survives another program replacing the file by renaming over it", async () => {
  // Editors and sync tools save by writing a temporary file and renaming it over the original.
  await save("report.txt", "v1");
  await save("report.txt", "v2");
  await writeFile(at(".report.txt.tmp"), "v3 from another program");
  await rename(at(".report.txt.tmp"), at("report.txt"));
  expect(await contents("report.txt")).toEqual(["v1"]);
  await save("report.txt", "v4");
  expect(await contents("report.txt")).toEqual([
    "v3 from another program",
    "v1",
  ]);
});

test("history left by a file removed outside Nimbus never attaches to a new file there", async () => {
  await save("plan.txt", "old plan");
  await save("plan.txt", "old plan, revised");
  // Renamed by another program: Nimbus cannot see it, so history stays at the old path.
  await rename(at("plan.txt"), at("plan-moved.txt"));
  expect(await FileVersions.history(store, "plan-moved.txt")).toEqual([]);
  expect(await save("plan.txt", "a different plan")).toEqual({
    kind: "created",
  });
  expect(await FileVersions.history(store, "plan.txt")).toEqual([]);
});

test("restoring a version keeps the current content as a new version", async () => {
  await save("report.txt", "v1");
  await save("report.txt", "v2");
  const [first] = await FileVersions.history(store, "report.txt");
  if (!first) throw new Error("Expected a version.");
  const result = await FileVersions.restore({
    drive: drive(),
    dataRoot: root,
    path: "report.txt",
    id: first.id,
    archivedBy: "editor",
  });
  expect(result.kind).toBe("replaced");
  expect(await readFile(at("report.txt"), "utf8")).toBe("v1");
  expect((await contents("report.txt")).sort()).toEqual(["v1", "v2"]);
  // The live file never shares an inode with its history.
  const live = await stat(at("report.txt"));
  for (const version of await FileVersions.history(store, "report.txt")) {
    const found = await FileVersions.find(store, "report.txt", version.id);
    expect(found && (await stat(found.payload(root))).ino).not.toBe(live.ino);
  }
  expect(
    await FileVersions.restore({
      drive: drive(),
      dataRoot: root,
      path: "report.txt",
      id: "00000000-0000-4000-8000-000000000000",
      archivedBy: null,
    }),
  ).toEqual({ kind: "not-found" });
});

test("each file keeps a bounded number of versions", async () => {
  for (let index = 0; index <= versionRetention.maxCount + 2; index++)
    await save("busy.txt", `save ${index}`);
  const history = await FileVersions.history(store, "busy.txt");
  expect(history).toHaveLength(versionRetention.maxCount);
  expect(
    await readFile(
      (
        await FileVersions.find(store, "busy.txt", history.at(-1)?.id ?? "")
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
  await mkdir(at("project"));
  await save("project/a.txt", "a1");
  await save("project/a.txt", "a2");
  await save("project-notes.txt", "n1");
  await save("project-notes.txt", "n2");
  await save("kept.txt", "k1");
  await save("kept.txt", "k2");
  // Trash relocates the folder's history to its trash location; purging discards it there.
  store.relocate("project", FileVersions.trashLocation("trash-1"));
  await FileVersions.discard(
    store,
    root,
    FileVersions.trashLocation("trash-1"),
  );
  expect(await contents("kept.txt")).toEqual(["k1"]);
  // A sibling sharing the folder's name as a prefix is unaffected.
  expect(await contents("project-notes.txt")).toEqual(["n1"]);
  expect(
    (await readdir(path.join(root, ".nimbus", "versions"))).length,
  ).toBeGreaterThan(0);
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
  expect(await FileVersions.history(store, "kept.txt")).toEqual([]);
  // ctime cannot be set from userspace; a fresh orphan is retained for a day.
  expect(await readdir(path.dirname(orphan))).toEqual([
    "ab000000-0000-4000-8000-000000000000",
  ]);
  await FileVersions.cleanup(store, root, Date.now() + 2 * 24 * 60 * 60 * 1000);
  expect(await readdir(path.dirname(orphan))).toEqual([]);
});

test("replacing an empty file keeps no version but keeps earlier history", async () => {
  // WebDAV clients often LOCK a new path, creating an empty file, then PUT it.
  await save("locked.txt", "");
  expect(await save("locked.txt", "content")).toEqual({
    kind: "replaced",
    version: null,
  });
  expect(await FileVersions.history(store, "locked.txt")).toEqual([]);
  await save("locked.txt", "");
  await save("locked.txt", "again");
  expect(await contents("locked.txt")).toEqual(["content"]);
});

test("moving a file over another keeps the destination's history and discards the moved file's", async () => {
  // Save-by-replace editors and WebDAV MOVE or COPY with Overwrite commit a live file over the target.
  await save("report.txt", "report v1");
  await save("report.txt", "report v2");
  await save("draft.txt", "draft v1");
  await save("draft.txt", "draft v2");
  const result = await FileVersions.commitReplacement({
    drive: drive(),
    dataRoot: root,
    path: "report.txt",
    incoming: at("draft.txt"),
    archivedBy: "editor",
  });
  await FileVersions.discard(store, root, "draft.txt");
  expect(result.kind).toBe("replaced");
  expect(await readFile(at("report.txt"), "utf8")).toBe("draft v2");
  expect(await contents("report.txt")).toEqual(["report v2", "report v1"]);
  expect(
    (await store.archivedBefore(Number.MAX_SAFE_INTEGER))
      .map((version) => version.name)
      .sort(),
  ).toEqual(["report.txt", "report.txt"]);
});

/** How saves preserve versions under `parent`, probed, for the test name. */
async function preservingIn(parent: string) {
  const probe = await mkdtemp(path.join(parent, "nimbus-clone-probe-"));
  try {
    return (await clonesFiles(probe)) ? "reflinks" : "no reflinks";
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

// On disk and in the temporary folder: usually one with reflinks (btrfs, xfs) and one without
// (tmpfs, ext4); the behaviour holds either way.
for (const parent of ["/var/tmp", os.tmpdir()])
  test(`a saved version stays as it was when another program keeps writing to the old file, in ${parent} (${await preservingIn(parent)})`, async () => {
    const otherRoot = await mkdtemp(path.join(parent, "nimbus-versions-"));
    const previousRoot = root;
    root = otherRoot;
    try {
      await writeFile(at("log.txt"), "first line\n");
      // A program on the host still has the file open for writing when it is replaced.
      const writer = await open(at("log.txt"), "a");
      try {
        await save("log.txt", "replacement");
        await writer.write("written after the save\n");
        await writer.sync();
      } finally {
        await writer.close();
      }
      expect(await contents("log.txt")).toEqual(["first line\n"]);
    } finally {
      root = previousRoot;
      await rm(otherRoot, { recursive: true, force: true });
    }
  });
