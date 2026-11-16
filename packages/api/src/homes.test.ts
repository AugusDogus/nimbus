import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { Homes } from "./homes";
import { createTestDriveStore } from "./testing";
import { FileListing } from "./file-listing";
import { forgetFileMutationsForTest } from "./file-mutations";

describe("home folders", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id: string) =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id } },
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-homes-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("derives portable folder names from the email", () => {
    expect(Homes.folderName("Jane.Doe+files@example.test")).toBe(
      "jane.doe-files",
    );
    expect(Homes.folderName("..@example.test")).toBe("user");
    expect(Homes.folderName("CON@example.test")).toBe("con-home");
  });

  it("gives an account a private folder it administers, once", async () => {
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "Reader@example.test",
      }),
    ).toEqual({ kind: "created", path: "homes/reader" });
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "reader@example.test",
      }),
    ).toEqual({ kind: "existing", path: "homes/reader" });
    expect((await stat(path.join(root, "homes/reader"))).isDirectory()).toBe(
      true,
    );
    await caller("reader").files.createFolder({
      path: "homes/reader",
      name: "notes",
    });
    await caller("reader").shares.create({
      path: "homes/reader/notes",
      expiresAt: null,
    });
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "homes" }),
      ).map((entry) => entry.name),
    ).toEqual(["reader"]);
  });

  it("never adopts an existing folder, comparing names case-insensitively", async () => {
    await mkdir(path.join(root, "homes/Reader"), { recursive: true });
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "reader@example.test",
      }),
    ).toEqual({ kind: "created", path: "homes/reader-2" });
  });

  it("keeps other accounts' homes hidden and backfills accounts without one", async () => {
    const results = await Homes.backfill(memory.store);
    expect(results.map((result) => result.kind)).toEqual([
      "created",
      "created",
    ]);
    expect((await readdir(path.join(root, "homes"))).sort()).toEqual([
      "owner",
      "reader",
    ]);
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "homes" }),
      ).map((entry) => entry.name),
    ).toEqual(["reader"]);
    await expect(
      caller("reader").files.list({ path: "homes/owner" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await Homes.backfill(memory.store)).toEqual([]);
  });

  it("protects homes and their containing folders from rename, move, and delete", async () => {
    await Homes.backfill(memory.store);
    await expect(
      caller("user-1").files.rename({ path: "homes/reader", newName: "mine" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("user-1").files.move({
        sourcePath: "homes/reader",
        destinationPath: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("reader").files.delete({ path: "homes/reader" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("user-1").files.delete({ path: "homes" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller("reader").files.createFolder({
      path: "homes/reader",
      name: "inside",
    });
    await caller("reader").files.rename({
      path: "homes/reader/inside",
      newName: "renamed",
    });
    await caller("reader").files.delete({ path: "homes/reader/renamed" });
  });

  it("reports a failure as a value when the data root cannot hold homes", async () => {
    await Bun.write(path.join(root, "homes"), "a file, not a folder");
    const result = await Homes.provision(memory.store, {
      id: "reader",
      email: "reader@example.test",
    });
    expect(result.kind).toBe("failed");
    expect(await memory.store.homeOf("reader")).toBeNull();
  });
});
