import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { createTestDriveStore } from "@nimbus/api/testing";
import { archiveEntries, archiveName, resolveArchiveRoots } from "./archive-entries";

describe("archive entries", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const names = async (paths: string[], userId = "user-1") => {
    const access = await getAccess(memory.store, userId);
    const result: string[] = [];
    for await (const entry of archiveEntries(await resolveArchiveRoots(paths, access), access)) result.push(entry.name);
    return result;
  };
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-archive-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs/trip/day 1"), { recursive: true });
    await mkdir(path.join(root, "other"), { recursive: true });
    await writeFile(path.join(root, "docs/notes.txt"), "notes");
    await writeFile(path.join(root, "docs/trip/day 1/photo.jpg"), "photo");
    await writeFile(path.join(root, "other/notes.txt"), "other notes");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("places each selected item at the top level and walks folders", async () => {
    expect(await names(["docs/notes.txt", "docs/trip"])).toEqual(["notes.txt", "trip/", "trip/day 1/", "trip/day 1/photo.jpg"]);
  });

  it("numbers items from different folders that share a name", async () => {
    expect(await names(["docs/notes.txt", "other/notes.txt"])).toEqual(["notes.txt", "notes (1).txt"]);
  });

  it("rejects unreadable or missing items before streaming", async () => {
    const reader = await getAccess(memory.store, "reader");
    await expect(resolveArchiveRoots(["docs/notes.txt"], reader)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await getAccess(memory.store, "user-1");
    await expect(resolveArchiveRoots(["docs/missing.txt"], admin)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolveArchiveRoots([], admin)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("names the archive after the item or the shared parent folder", () => {
    expect(archiveName([{ relative: "docs/trip", name: "trip" }])).toBe("trip.zip");
    expect(archiveName([{ relative: "docs/a", name: "a" }, { relative: "docs/b", name: "b" }])).toBe("docs.zip");
    expect(archiveName([{ relative: "a", name: "a" }, { relative: "b", name: "b" }])).toBe("Nimbus download.zip");
    expect(archiveName([{ relative: "docs/a", name: "a" }, { relative: "other/b", name: "b" }])).toBe("Nimbus download.zip");
  });
});
