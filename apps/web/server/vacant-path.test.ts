import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { commitStagedFile, stageFile } from "@nimbus/api/file-content";
import { copyItem } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { Homes } from "@nimbus/api/homes";
import { openTestDrive, type TestDrive } from "./drive-testing";
import { UploadStore } from "./upload-store";
import { commitUpload, UploadMetadata } from "./routes/upload-commit";

/**
 * Sharing records and history belong to a path. When content is removed outside Nimbus (over
 * SMB, by a shell), its records stay behind at that path. Content Nimbus creates there later
 * must start with none of them, whichever way it is created.
 */
describe("content created where removed content left records", () => {
  let drive: TestDrive;
  let shareId: string;
  beforeEach(async () => {
    drive = await openTestDrive();
  });
  afterEach(async () => {
    await drive.close();
  });

  /** Leave Carol's grant, a public link and one version at `relative`, then delete it outside Nimbus. */
  async function abandon(relative: string, kind: "file" | "dir") {
    if (kind === "dir") await drive.write(`${relative}/old.txt`, "old");
    else await drive.write(relative, "old");
    await drive.grant(relative, "carol", "write");
    shareId = await drive.share(relative);
    await drive.store.versions.add({
      id: crypto.randomUUID(),
      path: relative,
      name: path.basename(relative),
      size: 3,
      modifiedAt: 1,
      archivedAt: Date.now(),
      archivedBy: "owner",
    });
    await rm(drive.absolute(relative), { recursive: true, force: true });
  }

  async function expectNoRecordsAt(relative: string) {
    const carol = await drive.access("carol");
    expect(carol.can(relative, "read")).toBe(false);
    expect(await drive.store.grantsForPath(relative)).toEqual([]);
    expect(await drive.store.getShare(shareId)).toBeNull();
    expect(await FileVersions.history(drive.store.versions, relative)).toEqual(
      [],
    );
  }

  test("a folder created in the browser", async () => {
    await mkdir(drive.absolute("projects"));
    await abandon("projects/secret", "dir");
    await drive
      .caller("owner")
      .files.createFolder({ path: "projects", name: "secret" });
    await expectNoRecordsAt("projects/secret");
  });

  test("a copy into a free name", async () => {
    await drive.write("a/new.txt", "new");
    await mkdir(drive.absolute("b"));
    await abandon("b/new.txt", "file");
    await copyItem(
      drive.store,
      await drive.access("owner"),
      "a/new.txt",
      "b/new.txt",
    );
    await expectNoRecordsAt("b/new.txt");
  });

  test("a file written by WebDAV PUT, MCP or another staged write", async () => {
    await abandon("put.txt", "file");
    const staged = await stageFile("fresh", drive.absolute("put.txt"));
    try {
      const outcome = await commitStagedFile(
        {
          userId: "owner",
          drive: drive.store,
          authorize: () => drive.access("owner"),
        },
        "put.txt",
        staged,
        () => true,
      );
      expect(outcome.kind).toBe("created");
    } finally {
      await staged.discard();
    }
    await expectNoRecordsAt("put.txt");
  });

  test("an uploaded file and the folders of a folder upload", async () => {
    const uploads = new UploadStore({
      directory: drive.absolute(".nimbus/uploads"),
    });
    await mkdir(uploads.directory, { recursive: true });
    await abandon("album", "dir");
    await writeFile(path.join(uploads.directory, "upload-1"), "photo");
    expect(
      await commitUpload(
        uploads,
        drive.store,
        "upload-1",
        UploadMetadata.parse({
          targetPath: "",
          folder: "album",
          owner: "owner",
          filename: "photo.jpg",
        }),
        () => drive.access("owner"),
      ),
    ).toMatchObject({ kind: "published", path: "album/photo.jpg" });
    await expectNoRecordsAt("album");

    await abandon("album/photo (1).jpg", "file");
    await writeFile(path.join(uploads.directory, "upload-2"), "photo");
    expect(
      await commitUpload(
        uploads,
        drive.store,
        "upload-2",
        UploadMetadata.parse({
          targetPath: "album",
          owner: "owner",
          filename: "photo.jpg",
        }),
        () => drive.access("owner"),
      ),
    ).toMatchObject({ kind: "published", path: "album/photo (1).jpg" });
    await expectNoRecordsAt("album/photo (1).jpg");
  });

  test("a home folder", async () => {
    expect(await Homes.prepare(drive.store, "users")).toMatchObject({
      kind: "ready",
    });
    await abandon("users/carol", "dir");
    // Carol's own grant is the one a new home gets; Bob's stale one must not survive.
    await drive.grant("users/carol", "bob", "read");
    expect(
      await Homes.provision(drive.store, {
        id: "carol",
        email: "carol@example.test",
      }),
    ).toEqual({ kind: "created", path: "users/carol" });
    expect((await drive.access("bob")).can("users/carol", "read")).toBe(false);
    expect(await drive.store.getShare(shareId)).toBeNull();
    expect(
      (await drive.store.grantsForPath("users/carol")).map(
        (grant) => grant.subject.id,
      ),
    ).toEqual(["carol"]);
  });

  test("existing content keeps its records: only a vacant path is claimed", async () => {
    await drive.write("kept.txt", "kept");
    await drive.grant("kept.txt", "carol", "read");
    await expect(
      drive.caller("owner").files.createFolder({ name: "kept.txt" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await drive.access("carol")).can("kept.txt", "read")).toBe(true);
  });
});
