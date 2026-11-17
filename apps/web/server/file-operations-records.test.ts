import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { moveItem } from "@nimbus/api/file-operations";
import { openTestDrive, type TestDrive } from "./drive-testing";

/** Sharing records through moves, trash and restore, on the real SQLite store. */
describe("sharing records through file operations", () => {
  let drive: TestDrive;
  beforeEach(async () => {
    drive = await openTestDrive();
  });
  afterEach(async () => {
    await drive.close();
  });

  test("a move over a file that fails keeps the moved file's sharing", async () => {
    await drive.write("src.txt", "incoming");
    await drive.write("dst.txt", "previous");
    await drive.grant("src.txt", "carol", "read");
    const link = await drive.share("src.txt");
    // Saving the replaced content as a version fails, so the move fails.
    const versions = drive.absolute(".nimbus/versions");
    await mkdir(versions, { recursive: true });
    await chmod(versions, 0o500);
    try {
      await expect(
        moveItem(
          drive.store,
          await drive.access("owner"),
          "src.txt",
          "dst.txt",
          { existing: "replace" },
        ),
      ).rejects.toThrow();
    } finally {
      await chmod(versions, 0o700);
    }
    expect(await readFile(drive.absolute("src.txt"), "utf8")).toBe("incoming");
    expect(await readFile(drive.absolute("dst.txt"), "utf8")).toBe("previous");
    expect((await drive.access("carol")).can("src.txt", "read")).toBe(true);
    expect(await drive.store.getShare(link)).not.toBeNull();
  });

  test("a move over a file that succeeds drops the moved file's sharing", async () => {
    await drive.write("src.txt", "incoming");
    await drive.write("dst.txt", "previous");
    await drive.grant("src.txt", "carol", "read");
    await drive.grant("dst.txt", "bob", "read");
    await moveItem(
      drive.store,
      await drive.access("owner"),
      "src.txt",
      "dst.txt",
      { existing: "replace" },
    );
    expect(await readFile(drive.absolute("dst.txt"), "utf8")).toBe("incoming");
    // The destination keeps its own sharing, as a save-by-replace editor expects.
    expect((await drive.access("bob")).can("dst.txt", "read")).toBe(true);
    expect((await drive.access("carol")).can("dst.txt", "read")).toBe(false);
    expect(await drive.store.grantsForPath("src.txt")).toEqual([]);
  });
});
