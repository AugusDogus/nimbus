import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getAccess } from "./access";
import { DriveFile } from "./drive-file";
import { readFileText } from "./file-content";
import { copyItem } from "./file-operations";
import { FileVersions } from "./file-versions";
import { forgetFileMutationsForTest } from "./file-mutations";
import { createTestDriveStore } from "./testing";

/**
 * A checked path can have a component swapped for a symlink before Nimbus opens it. Opening a
 * path through such a link must fail instead of reading whatever the link points to.
 * Here the links exist from the start, standing in for ones swapped in after `safePath`.
 */
describe("drive files opened after their path was checked", () => {
  let root: string;
  let outside: string;
  let previousRoot: string | undefined;
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp("/var/tmp/nimbus-drive-file-");
    outside = await mkdtemp("/var/tmp/nimbus-outside-");
    process.env.NIMBUS_DATA_ROOT = root;
    await writeFile(path.join(outside, "secret.txt"), "server secret");
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/report.txt"), "report");
    // A folder and a file replaced by links to content outside the drive.
    await symlink(outside, path.join(root, "swapped"));
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "docs/link.txt"),
    );
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  test("opening refuses a symlink in the last component or in a folder on the way", async () => {
    for (const relative of ["docs/link.txt", "swapped/secret.txt"])
      await expect(
        DriveFile.openForReading(path.join(root, relative)),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const opened = await DriveFile.openFile(path.join(root, "docs/report.txt"));
    try {
      expect(opened.stats.size).toBe("report".length);
    } finally {
      await opened.handle.close();
    }
  });

  test("a folder swapped for a symlink to a differently cased folder is refused", async () => {
    // On case-sensitive storage "PRIVATE" is another folder, perhaps one the reader may not see.
    await mkdir(path.join(root, "PRIVATE"));
    await writeFile(path.join(root, "PRIVATE/salary.txt"), "private");
    await symlink(path.join(root, "PRIVATE"), path.join(root, "private"));
    await expect(
      DriveFile.openForReading(path.join(root, "private/salary.txt")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("renames through a swapped folder are refused or undone", async () => {
    await writeFile(path.join(root, "docs/mine.txt"), "mine");
    // The item to move is reached through a symlink: refused before anything moves.
    await expect(
      DriveFile.renameChecked(
        path.join(root, "swapped/secret.txt"),
        path.join(root, "docs/taken.txt"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
      "server secret",
    );
    // The destination folder is a symlink: the item lands elsewhere and is moved back.
    await expect(
      DriveFile.renameChecked(
        path.join(root, "docs/mine.txt"),
        path.join(root, "swapped/mine.txt"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(root, "docs/mine.txt"), "utf8")).toBe(
      "mine",
    );
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  test("a save into a folder swapped for a symlink does not stay outside the drive", async () => {
    const memory = createTestDriveStore();
    const incoming = path.join(root, "incoming.txt");
    await writeFile(incoming, "new");
    await expect(
      FileVersions.commitReplacement({
        drive: memory.store,
        dataRoot: root,
        path: "swapped/new.txt",
        incoming,
        archivedBy: "user-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readdir(outside)).toEqual(["secret.txt"]);
    expect(await readFile(incoming, "utf8")).toBe("new");
  });

  test("copying refuses to read through a symlink", async () => {
    await expect(
      DriveFile.copy(
        path.join(root, "swapped/secret.txt"),
        path.join(root, "docs/copied.txt"),
        0,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readdir(path.join(root, "docs"))).not.toContain("copied.txt");
  });

  test("saving a version refuses a file reached through a symlink", async () => {
    const memory = createTestDriveStore();
    const incoming = path.join(root, "incoming.txt");
    await writeFile(incoming, "new");
    await expect(
      FileVersions.commitReplacement({
        drive: memory.store,
        dataRoot: root,
        path: "swapped/secret.txt",
        incoming,
        archivedBy: "user-1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
      "server secret",
    );
    expect(await readFile(incoming, "utf8")).toBe("new");
    const saved = await readdir(path.join(root, ".nimbus/versions"), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    expect(saved.filter((entry) => entry.isFile())).toEqual([]);
  });

  test("copies and text reads through the API never return linked content", async () => {
    const memory = createTestDriveStore();
    const access = await getAccess(memory.store, "user-1");
    await expect(
      copyItem(memory.store, access, "docs/link.txt", "docs/copy.txt"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readFileText(access, "docs/link.txt", { offset: 0, maxBytes: 100 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await readFileText(access, "docs/report.txt", {
        offset: 0,
        maxBytes: 100,
      }),
    ).toMatchObject({ kind: "text", content: "report" });
  });
});
