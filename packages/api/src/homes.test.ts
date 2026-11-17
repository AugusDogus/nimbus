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
  let previousHomes: string | undefined;
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
    previousHomes = process.env.NIMBUS_HOMES_PATH;
    delete process.env.NIMBUS_HOMES_PATH;
    memory = createTestDriveStore();
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
    if (previousHomes === undefined) delete process.env.NIMBUS_HOMES_PATH;
    else process.env.NIMBUS_HOMES_PATH = previousHomes;
  });
  const ready = async () =>
    expect(await Homes.prepare(memory.store)).toMatchObject({ kind: "ready" });

  it("derives portable folder names from the email", () => {
    expect(Homes.folderName("Jane.Doe+files@example.test")).toBe(
      "jane.doe-files",
    );
    expect(Homes.folderName("..@example.test")).toBe("user");
    expect(Homes.folderName("CON@example.test")).toBe("con-home");
  });

  it("gives an account a private folder it administers, once", async () => {
    await ready();
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "Reader@example.test",
      }),
    ).toEqual({ kind: "created", path: "users/reader" });
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "reader@example.test",
      }),
    ).toEqual({ kind: "existing", path: "users/reader" });
    expect((await stat(path.join(root, "users/reader"))).isDirectory()).toBe(
      true,
    );
    await caller("reader").files.createFolder({
      path: "users/reader",
      name: "notes",
    });
    await caller("reader").shares.create({
      path: "users/reader/notes",
      expiresAt: null,
    });
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "users" }),
      ).map((entry) => entry.name),
    ).toEqual(["reader"]);
  });

  it("never adopts an existing folder, comparing names case-insensitively", async () => {
    await ready();
    await mkdir(path.join(root, "users/Reader"), { recursive: true });
    expect(
      await Homes.provision(memory.store, {
        id: "reader",
        email: "reader@example.test",
      }),
    ).toEqual({ kind: "created", path: "users/reader-2" });
  });

  it("keeps other accounts' homes hidden and backfills accounts without one", async () => {
    await ready();
    const results = await Homes.backfill(memory.store);
    expect(results.map((result) => result.kind)).toEqual([
      "created",
      "created",
    ]);
    expect((await readdir(path.join(root, "users"))).sort()).toEqual([
      "owner",
      "reader",
    ]);
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "users" }),
      ).map((entry) => entry.name),
    ).toEqual(["reader"]);
    await expect(
      caller("reader").files.list({ path: "users/owner" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await Homes.backfill(memory.store)).toEqual([]);
  });

  it("protects homes and their containing folders from rename, move, and delete", async () => {
    await ready();
    await Homes.backfill(memory.store);
    await expect(
      caller("user-1").files.rename({ path: "users/reader", newName: "mine" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("user-1").files.move({
        sourcePath: "users/reader",
        destinationPath: "",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("reader").files.delete({ path: "users/reader" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("user-1").files.delete({ path: "users" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller("reader").files.createFolder({
      path: "users/reader",
      name: "inside",
    });
    await caller("reader").files.rename({
      path: "users/reader/inside",
      newName: "renamed",
    });
    await caller("reader").files.delete({ path: "users/reader/renamed" });
  });

  it("reads the container from NIMBUS_HOMES_PATH and rejects unsafe values", () => {
    expect(Homes.containerPath(undefined)).toBe("users");
    expect(Homes.containerPath("")).toBe("users");
    expect(Homes.containerPath("people")).toBe("people");
    expect(Homes.containerPath("team/people")).toBe("team/people");
    for (const value of [
      "/users",
      "users/",
      "a//b",
      ".",
      "..",
      "../users",
      "team/../users",
      ".nimbus",
      ".Nimbus/users",
      "team/.nimbus",
      "a\\b",
      " users",
      "users ",
      "us\u0000ers",
    ])
      expect(() => Homes.containerPath(value)).toThrow("NIMBUS_HOMES_PATH");
  });

  it("creates and records the container on a fresh install and reuses it after a restart", async () => {
    expect(await Homes.prepare(memory.store)).toEqual({
      kind: "ready",
      path: "users",
      created: true,
    });
    expect(await memory.store.listHomeContainers()).toEqual(["users"]);
    expect(await readdir(path.join(root, "users"))).toEqual([]);
    await Homes.backfill(memory.store);
    // A restart, also after the folder went missing outside Nimbus.
    expect(await Homes.prepare(memory.store)).toEqual({
      kind: "ready",
      path: "users",
      created: false,
    });
    await rm(path.join(root, "users"), { recursive: true });
    expect(await Homes.prepare(memory.store)).toMatchObject({ kind: "ready" });
    expect((await stat(path.join(root, "users"))).isDirectory()).toBe(true);
  });

  it("refuses a shared folder it did not create, so its grants never cover new homes", async () => {
    // An existing install has its own "users" folder, shared read-only with the reader.
    await mkdir(path.join(root, "users/old-project"), { recursive: true });
    await memory.store.saveGrant({
      id: "reader-users",
      subject: { type: "user", id: "reader" },
      path: "users",
      permission: "read",
    });
    const result = await Homes.prepare(memory.store);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.message).toContain('"users" (1 item)');
    expect(result.message).toContain("1 sharing grant");
    expect(result.message).toContain("No folders or sharing were changed");
    expect(result.message).toContain("NIMBUS_HOMES_PATH");
    expect(await memory.store.listHomeContainers()).toEqual([]);
    expect(await readdir(path.join(root, "users"))).toEqual(["old-project"]);
    // Startup stops here; an account created anyway gets no home in the shared folder.
    expect(
      (await Homes.provision(memory.store, { id: "user-1", email: "owner@x" }))
        .kind,
    ).toBe("failed");
    expect(await readdir(path.join(root, "users"))).toEqual(["old-project"]);

    // The fix: use another folder. The reader still sees only the old folder's content.
    process.env.NIMBUS_HOMES_PATH = "people";
    await ready();
    await Homes.backfill(memory.store);
    await Bun.write(path.join(root, "people/owner/diary.txt"), "private");
    expect(
      FileListing.entries(
        await caller("reader").files.list({ path: "users" }),
      ).map((entry) => entry.name),
    ).toEqual(["old-project"]);
    await expect(
      caller("reader").files.list({ path: "people/owner" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an existing folder even when it is empty or differs only in case", async () => {
    await mkdir(path.join(root, "Users"));
    const result = await Homes.prepare(memory.store);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind === "refused")
      expect(result.message).toContain('"Users" (0 items)');
    await rm(path.join(root, "Users"), { recursive: true });
    await Bun.write(path.join(root, "users"), "a file, not a folder");
    expect(await Homes.prepare(memory.store)).toMatchObject({
      kind: "refused",
    });
    expect(await memory.store.listHomeContainers()).toEqual([]);
  });

  it("refuses a path covered by sharing on a folder above it, or linked or bookmarked before", async () => {
    process.env.NIMBUS_HOMES_PATH = "team/people";
    await memory.store.saveGrant({
      id: "team",
      subject: { type: "user", id: "reader" },
      path: "team",
      permission: "read",
    });
    const above = await Homes.prepare(memory.store);
    expect(above).toMatchObject({ kind: "refused" });
    if (above.kind === "refused")
      expect(above.message).toContain(
        "1 sharing grant on it or on a folder above it",
      );
    await memory.store.removeGrant("team");
    // Records left at a path whose folder is gone would apply to new content there.
    await memory.store.createShare({
      id: "link",
      token: "token",
      path: "team/people/old",
      createdBy: "user-1",
      createdAt: 1,
      expiresAt: null,
      passwordHash: null,
      downloadCount: 0,
      maxDownloads: null,
      mode: "download",
    });
    await memory.store.saveBookmark("reader", {
      path: "team/people",
      starred: true,
      accessedAt: 1,
      visits: 1,
    });
    const linked = await Homes.prepare(memory.store);
    expect(linked).toMatchObject({ kind: "refused" });
    if (linked.kind === "refused") {
      expect(linked.message).toContain("1 public link");
      expect(linked.message).toContain("1 bookmark");
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps existing homes in place when the container changes, and still protects the old one", async () => {
    await ready();
    await Homes.provision(memory.store, {
      id: "reader",
      email: "reader@example.test",
    });
    process.env.NIMBUS_HOMES_PATH = "people";
    await ready();
    expect(await Homes.backfill(memory.store)).toEqual([
      { kind: "created", path: "people/owner" },
    ]);
    expect(await memory.store.homeOf("reader")).toBe("users/reader");
    await expect(
      caller("user-1").files.delete({ path: "users" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Switching back reuses the folder Nimbus created first.
    process.env.NIMBUS_HOMES_PATH = "users";
    expect(await Homes.prepare(memory.store)).toEqual({
      kind: "ready",
      path: "users",
      created: false,
    });
  });

  it("records the container only after creating it, and removes it when recording fails", async () => {
    const failing = {
      ...memory.store,
      addHomeContainer: async () => {
        // The folder exists before the record is written.
        expect((await stat(path.join(root, "users"))).isDirectory()).toBe(true);
        throw new Error("database is locked");
      },
    };
    await expect(Homes.prepare(failing)).rejects.toThrow("database is locked");
    expect(await readdir(root)).toEqual([]);
    // A crash between the two leaves an unrecorded folder, which is never adopted.
    await mkdir(path.join(root, "users"));
    expect(await Homes.prepare(memory.store)).toMatchObject({
      kind: "refused",
    });
  });

  it("creates no new home while a grant or link covers the container", async () => {
    await ready();
    await memory.store.saveGrant({
      id: "root-reader",
      subject: { type: "user", id: "reader" },
      path: "",
      permission: "read",
    });
    const result = await Homes.provision(memory.store, {
      id: "user-1",
      email: "owner@example.test",
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed")
      expect(result.message).toContain("1 sharing grant");
    expect(await readdir(path.join(root, "users"))).toEqual([]);
    // Sharing inside an existing home does not block other homes.
    await memory.store.removeGrant("root-reader");
    await Homes.provision(memory.store, {
      id: "reader",
      email: "reader@example.test",
    });
    await memory.store.saveGrant({
      id: "inside-home",
      subject: { type: "user", id: "user-1" },
      path: "users/reader",
      permission: "read",
    });
    expect(
      await Homes.provision(memory.store, {
        id: "user-1",
        email: "owner@example.test",
      }),
    ).toEqual({ kind: "created", path: "users/owner" });
  });

  it("compares sharing records and protected folders case-insensitively", async () => {
    await memory.store.createShare({
      id: "link",
      token: "token",
      path: "USERS",
      createdBy: "user-1",
      createdAt: 1,
      expiresAt: null,
      passwordHash: null,
      downloadCount: 0,
      maxDownloads: null,
      mode: "download",
    });
    expect(await Homes.prepare(memory.store)).toMatchObject({
      kind: "refused",
    });
    await memory.store.revokeShare("link", "user-1");
    await ready();
    await Homes.backfill(memory.store);
    // On a case-insensitive volume these name the protected folders.
    for (const alias of ["USERS", "Users/Reader"])
      await expect(
        Homes.requireNotHome(memory.store, alias),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await Homes.requireNotHome(memory.store, "users-old");
  });

  it("protects an empty container from rename, move, and delete", async () => {
    await ready();
    await expect(
      caller("user-1").files.rename({ path: "users", newName: "other" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller("user-1").files.delete({ path: "users" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports a failure as a value when the home container is not set up", async () => {
    const result = await Homes.provision(memory.store, {
      id: "reader",
      email: "reader@example.test",
    });
    expect(result.kind).toBe("failed");
    expect(await memory.store.homeOf("reader")).toBeNull();
  });
});
