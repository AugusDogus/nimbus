import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { copyItem } from "@nimbus/api/file-operations";
import { readableFile } from "@nimbus/api/versions-router";
import { openTestDrive, type TestDrive } from "./drive-testing";

/**
 * Someone without access to a path learns nothing about it: a request for an existing file,
 * a missing one, a folder, or a path through a file gets the same refusal.
 */
describe("paths the caller cannot read", () => {
  let drive: TestDrive;
  beforeEach(async () => {
    drive = await openTestDrive();
    await drive.write("private/salary.xlsx", "secret");
    await mkdir(drive.absolute("private/folder"));
    await drive.write("carol/own.txt", "mine");
    await drive.grant("carol", "carol", "admin");
  });
  afterEach(async () => {
    await drive.close();
  });

  const probes = [
    "private/salary.xlsx",
    "private/missing.xlsx",
    "private/folder",
    "private/salary.xlsx/inside",
  ];

  test("files.copy refuses an unreadable source the same way whether it exists or not", async () => {
    for (const sourcePath of probes)
      await expect(
        drive
          .caller("carol")
          .files.copy({ sourcePath, destinationPath: "carol" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      copyItem(
        drive.store,
        await drive.access("carol"),
        "private/salary.xlsx",
        "carol/copy.xlsx",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("files.copy refuses an unwritable destination the same way whether it exists or not", async () => {
    for (const destinationPath of probes)
      await expect(
        drive
          .caller("carol")
          .files.copy({ sourcePath: "carol/own.txt", destinationPath }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("version history and version downloads refuse without telling files from folders", async () => {
    const carol = await drive.access("carol");
    for (const path of probes) {
      await expect(
        drive.caller("carol").versions.list({ path }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(readableFile(carol, path)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  test("a path running through a file is a missing item, not a server error", async () => {
    await expect(
      drive.caller("owner").files.list({ path: "private/salary.xlsx/inside" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      drive.caller("carol").files.list({ path: "private/salary.xlsx/inside" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
