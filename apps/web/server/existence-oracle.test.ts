import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { copyItem } from "@nimbus/api/file-operations";
import { lockFile } from "@nimbus/api/file-mutations";
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
    await symlink(drive.absolute("carol"), drive.absolute("private/link"));
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
    "private/link",
    "private/link/own.txt",
  ];

  /** The refusal each probe gets: all the same, code and message, or the probes differ. */
  const refusals = async (attempt: (path: string) => Promise<unknown>) => {
    const seen = new Set<string>();
    for (const path of probes) {
      const outcome = await attempt(path).then(
        () => "allowed",
        (error: unknown) =>
          error instanceof Error && "code" in error
            ? `${String(error.code)}: ${error.message}`
            : String(error),
      );
      seen.add(outcome);
    }
    return [...seen];
  };

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

  test("copy and version history refuse every probe with one message, symbolic links included", async () => {
    const carol = await drive.access("carol");
    const copySources = await refusals((sourcePath) =>
      drive
        .caller("carol")
        .files.copy({ sourcePath, destinationPath: "carol" }),
    );
    expect(copySources).toHaveLength(1);
    expect(copySources[0]).toStartWith("FORBIDDEN");
    expect(
      await refusals((destinationPath) =>
        drive
          .caller("carol")
          .files.copy({ sourcePath: "carol/own.txt", destinationPath }),
      ),
    ).toHaveLength(1);
    expect(
      await refusals((sourcePath) =>
        copyItem(drive.store, carol, sourcePath, "carol/copy.xlsx"),
      ),
    ).toHaveLength(1);
    expect(
      await refusals((path) => drive.caller("carol").versions.list({ path })),
    ).toHaveLength(1);
    expect(await refusals((path) => readableFile(carol, path))).toHaveLength(1);
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

  test("people who are not server administrators see group names, not members", async () => {
    await drive.store.saveGroup({
      id: "finance",
      name: "Finance",
      memberIds: ["alice", "bob"],
    });
    expect(await drive.caller("carol").access.groups()).toEqual([
      { id: "finance", name: "Finance", memberIds: [] },
    ]);
    expect(await drive.caller("owner").access.groups()).toEqual([
      { id: "finance", name: "Finance", memberIds: ["alice", "bob"] },
    ]);
  });

  test("a WebDAV lock on a path the caller cannot change does not reveal it exists", async () => {
    lockFile("private/salary.xlsx", { userId: "owner" });
    const carol = drive.caller("carol");
    await expect(
      carol.files.delete({ path: "private/salary.xlsx" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      carol.files.rename({ path: "private/salary.xlsx", newName: "x.xlsx" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    lockFile("private/new", { userId: "owner" });
    await expect(
      carol.files.createFolder({ path: "private", name: "new" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
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
