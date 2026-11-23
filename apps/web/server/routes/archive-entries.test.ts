import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { createTestDriveStore } from "@nimbus/api/testing";
import {
  archiveEntries,
  archiveName,
  resolveArchiveRoots,
} from "./archive-entries";

describe("archive entries", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const names = async (paths: string[], userId = "user-1") => {
    const access = await getAccess(memory.store, userId);
    const result: string[] = [];
    for await (const entry of archiveEntries(
      await resolveArchiveRoots(paths, access),
      async () => access,
    ))
      result.push(entry.name);
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

  it("checks access again before each member, and ends once it is withdrawn", async () => {
    memory.grants.set("reader-docs", {
      id: "reader-docs",
      subject: { type: "user", id: "reader" },
      path: "docs",
      permission: "read",
    });
    const access = async () => getAccess(memory.store, "reader");
    const roots = await resolveArchiveRoots(["docs"], await access());
    const seen: string[] = [];
    const walking = (async () => {
      for await (const entry of archiveEntries(roots, access)) {
        seen.push(entry.name);
        // Withdrawn once the archive has started: what is not yet read must stay unread.
        if (entry.name === "docs/") memory.grants.delete("reader-docs");
      }
    })();
    await expect(walking).rejects.toThrow();
    expect(seen).toEqual(["docs/"]);
  });

  it("ends when the session or link that started it is gone", async () => {
    const roots = await resolveArchiveRoots(
      ["docs"],
      await getAccess(memory.store, "user-1"),
    );
    let signedIn = true;
    const access = async () => {
      if (!signedIn) throw new Error("Signed out.");
      return getAccess(memory.store, "user-1");
    };
    const seen: string[] = [];
    const walking = (async () => {
      for await (const entry of archiveEntries(roots, access)) {
        seen.push(entry.name);
        signedIn = false;
      }
    })();
    await expect(walking).rejects.toThrow("Signed out.");
    expect(seen).toEqual(["docs/"]);
  });

  it("places each selected item at the top level and walks folders", async () => {
    expect(await names(["docs/notes.txt", "docs/trip"])).toEqual([
      "notes.txt",
      "trip/",
      "trip/day 1/",
      "trip/day 1/photo.jpg",
    ]);
  });

  it("numbers items from different folders that share a name", async () => {
    expect(await names(["docs/notes.txt", "other/notes.txt"])).toEqual([
      "notes.txt",
      "notes (1).txt",
    ]);
  });

  it("rejects unreadable or missing items before streaming", async () => {
    const reader = await getAccess(memory.store, "reader");
    await expect(
      resolveArchiveRoots(["docs/notes.txt"], reader),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const admin = await getAccess(memory.store, "user-1");
    await expect(
      resolveArchiveRoots(["docs/missing.txt"], admin),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(resolveArchiveRoots([], admin)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("names the archive after the item or the shared parent folder", () => {
    expect(archiveName([{ relative: "docs/trip", name: "trip" }])).toBe(
      "trip.zip",
    );
    expect(
      archiveName([
        { relative: "docs/a", name: "a" },
        { relative: "docs/b", name: "b" },
      ]),
    ).toBe("docs.zip");
    expect(
      archiveName([
        { relative: "a", name: "a" },
        { relative: "b", name: "b" },
      ]),
    ).toBe("Nimbus download.zip");
    expect(
      archiveName([
        { relative: "docs/a", name: "a" },
        { relative: "other/b", name: "b" },
      ]),
    ).toBe("Nimbus download.zip");
  });
});
