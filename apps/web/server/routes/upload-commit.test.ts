import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import {
  lockFile,
  forgetFileMutationsForTest,
} from "@nimbus/api/file-mutations";
import { FileVersions } from "@nimbus/api/file-versions";
import { createTestDriveStore } from "@nimbus/api/testing";
import { UploadStore } from "@/server/upload-store";
import { commitUpload, UploadMetadata } from "./upload-commit";

describe("committing finished uploads", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  let store: UploadStore;
  let next = 0;
  const stage = async (body: string) => {
    const id = `upload-${next++}`;
    await writeFile(path.join(store.directory, id), body);
    return id;
  };
  const commit = async (
    body: string,
    metadata: Partial<UploadMetadata> & { filename: string },
    userId = "user-1",
  ) =>
    commitUpload(
      store,
      memory.store.versions,
      await stage(body),
      UploadMetadata.parse({ targetPath: "docs", owner: userId, ...metadata }),
      () => getAccess(memory.store, userId),
    );

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-upload-commit-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, ".nimbus/uploads"), { recursive: true });
    store = new UploadStore({ directory: path.join(root, ".nimbus/uploads") });
    await writeFile(path.join(root, "docs/notes.txt"), "original");
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("keeps both by default and numbers the new file", async () => {
    expect(await commit("second", { filename: "notes.txt" })).toEqual({
      kind: "published",
      path: "docs/notes (1).txt",
      replaced: false,
    });
    expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
      "original",
    );
  });

  it("replaces an existing file when asked", async () => {
    expect(
      await commit("replacement", {
        filename: "notes.txt",
        conflict: "replace",
      }),
    ).toEqual({ kind: "published", path: "docs/notes.txt", replaced: true });
    expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
      "replacement",
    );
    expect(
      await commit("new", { filename: "fresh.txt", conflict: "replace" }),
    ).toEqual({ kind: "published", path: "docs/fresh.txt", replaced: false });
  });

  it("keeps the replaced content as a version", async () => {
    await commit("replacement", { filename: "notes.txt", conflict: "replace" });
    const [version] = await FileVersions.history(
      memory.store.versions,
      "docs/notes.txt",
    );
    expect(version).toMatchObject({
      name: "notes.txt",
      size: "original".length,
      archivedBy: "user-1",
    });
  });

  it("never replaces a folder or a WebDAV-locked file", async () => {
    await mkdir(path.join(root, "docs/photos"));
    await expect(
      commit("file", { filename: "photos", conflict: "replace" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    lockFile("docs/notes.txt", { userId: "user-1" });
    await expect(
      commit("locked", { filename: "notes.txt", conflict: "replace" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path.join(root, "docs/notes.txt"), "utf8")).toBe(
      "original",
    );
  });

  it("requires write access to replace", async () => {
    memory.grants.set("read", {
      id: "read",
      subject: { type: "user", id: "reader" },
      path: "docs",
      permission: "read",
    });
    await expect(
      commit("nope", { filename: "notes.txt", conflict: "replace" }, "reader"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("recreates nested folders from a folder upload", async () => {
    expect(
      await commit("deep", { filename: "a.txt", folder: "trip/day 1" }),
    ).toEqual({
      kind: "published",
      path: "docs/trip/day 1/a.txt",
      replaced: false,
    });
    expect(
      await commit("deeper", { filename: "b.txt", folder: "trip/day 1" }),
    ).toMatchObject({ path: "docs/trip/day 1/b.txt" });
    expect((await readdir(path.join(root, "docs/trip/day 1"))).sort()).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("refuses folder paths that escape the target or pass through a file", async () => {
    expect(
      UploadMetadata.safeParse({
        filename: "a.txt",
        targetPath: "docs",
        owner: "user-1",
        folder: "../escape",
      }).success,
    ).toBe(false);
    expect(
      UploadMetadata.safeParse({
        filename: "a.txt",
        targetPath: "docs",
        owner: "user-1",
        folder: "a//b",
      }).success,
    ).toBe(false);
    expect(
      UploadMetadata.safeParse({
        filename: "a.txt",
        targetPath: "docs",
        owner: "user-1",
        folder: ".nimbus",
      }).success,
    ).toBe(false);
    await expect(
      commit("x", { filename: "a.txt", folder: "notes.txt/inner" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
