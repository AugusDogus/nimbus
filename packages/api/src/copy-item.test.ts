import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import type { DriveStore } from "./drive-store";
import { randomUUID } from "node:crypto";
import { copyItem, moveItem, type CopyOptions } from "./file-operations";
import type { Permission } from "./drive-store";
import { TransferCancelledError } from "./transfer-cancel";
import { lockFile, forgetFileMutationsForTest } from "./file-mutations";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

describe("copying files and folders", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const copy = async (
    sourcePath: string,
    targetPath: string,
    options: CopyOptions = {},
    userId = "user-1",
    store: DriveStore = memory.store,
  ) =>
    copyItem(
      store,
      await getAccess(memory.store, userId),
      sourcePath,
      targetPath,
      options,
    );
  const caller = (id = "user-1") =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id } },
      sessionStillValid: async () => true,
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-copy-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs/nested"), { recursive: true });
    await writeFile(path.join(root, "docs/first.txt"), "first");
    await writeFile(path.join(root, "docs/nested/deep.txt"), "deep");
    await mkdir(path.join(root, "archive"));
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("copies a folder tree and leaves no staging files behind", async () => {
    expect(await copy("docs", "archive/docs")).toMatchObject({
      path: "archive/docs",
      replaced: false,
    });
    expect(
      await readFile(path.join(root, "archive/docs/nested/deep.txt"), "utf8"),
    ).toBe("deep");
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
    expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual([]);
  });

  it("copies only the folder itself at depth zero", async () => {
    await copy("docs", "archive/empty", { depth: "0" });
    expect(await readdir(path.join(root, "archive/empty"))).toEqual([]);
  });

  it("refuses an existing destination and leaves it untouched", async () => {
    await writeFile(path.join(root, "archive/first.txt"), "existing");
    await expect(
      copy("docs/first.txt", "archive/first.txt"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(path.join(root, "archive/first.txt"), "utf8")).toBe(
      "existing",
    );
  });

  it("requires read on the source and write on the destination", async () => {
    await expect(
      copy("docs/first.txt", "archive/first.txt", {}, "reader"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    memory.grants.set("read-docs", {
      id: "read-docs",
      subject: { type: "user", id: "reader" },
      path: "docs",
      permission: "read",
    });
    memory.grants.set("write-archive", {
      id: "write-archive",
      subject: { type: "user", id: "reader" },
      path: "archive",
      permission: "write",
    });
    expect(
      await copy("docs/first.txt", "archive/first.txt", {}, "reader"),
    ).toMatchObject({ path: "archive/first.txt" });
    await expect(
      copy("archive/first.txt", "docs/first copy.txt", {}, "reader"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reloads access before publishing a staged copy", async () => {
    // The caller's access was loaded before the copy. The store now reports the role as revoked.
    const revoking: DriveStore = {
      ...memory.store,
      async getUser(id) {
        const user = await memory.store.getUser(id);
        return user && { ...user, role: "user" };
      },
    };
    await expect(
      copy("docs", "archive/docs", {}, "user-1", revoking),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readdir(path.join(root, "archive"))).toEqual([]);
  });

  it("respects WebDAV locks on the destination and accepts the lock owner's token", async () => {
    const lock = lockFile("archive", { userId: "user-1" });
    await expect(
      copy("docs/first.txt", "archive/first.txt"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      await copy("docs/first.txt", "archive/first.txt", {
        lockTokens: [lock.token],
      }),
    ).toMatchObject({ path: "archive/first.txt" });
  });

  it("rejects copying into itself, the drive root, or internal storage, and skips symbolic links", async () => {
    await expect(copy("docs", "docs/nested/docs")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(copy("docs", "")).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      copy("docs/first.txt", ".nimbus/first.txt"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await symlink(
      path.join(root, "docs/first.txt"),
      path.join(root, "docs/link.txt"),
    );
    await copy("docs", "archive/docs");
    expect((await readdir(path.join(root, "archive/docs"))).sort()).toEqual([
      "first.txt",
      "nested",
    ]);
  });

  it("copies into a folder through the API, keeping both on clashes and duplicating in place", async () => {
    expect(
      await caller().files.copy({
        sourcePath: "docs/first.txt",
        destinationPath: "archive",
      }),
    ).toMatchObject({ name: "first.txt", path: "archive/first.txt" });
    expect(
      await caller().files.copy({
        sourcePath: "docs/first.txt",
        destinationPath: "archive",
      }),
    ).toMatchObject({ name: "first (1).txt", path: "archive/first (1).txt" });
    expect(
      await caller().files.copy({
        sourcePath: "docs/first.txt",
        destinationPath: "docs",
      }),
    ).toMatchObject({ name: "first (1).txt", path: "docs/first (1).txt" });
    expect(
      await caller().files.copy({ sourcePath: "docs", destinationPath: "" }),
    ).toMatchObject({ name: "docs (1)", path: "docs (1)" });
    expect(
      await readFile(path.join(root, "docs (1)/nested/deep.txt"), "utf8"),
    ).toBe("deep");
    await expect(
      caller().files.copy({
        sourcePath: "docs",
        destinationPath: "docs/nested",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().files.copy({
        sourcePath: "docs/missing.txt",
        destinationPath: "archive",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("copies a folder through the API without folder admin, but moving it still requires admin", async () => {
    memory.grants.set("write-root", {
      id: "write-root",
      subject: { type: "user", id: "reader" },
      path: "",
      permission: "write",
    });
    expect(
      await caller("reader").files.copy({
        sourcePath: "docs",
        destinationPath: "archive",
      }),
    ).toMatchObject({ name: "docs", path: "archive/docs" });
    expect(
      await readFile(path.join(root, "archive/docs/nested/deep.txt"), "utf8"),
    ).toBe("deep");
    await expect(
      caller("reader").files.move({
        sourcePath: "docs",
        destinationPath: "archive/docs",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("copies a folder with read on it and write on the destination, but cannot move it", async () => {
    memory.grants.set("read-docs", {
      id: "read-docs",
      subject: { type: "user", id: "reader" },
      path: "docs",
      permission: "read",
    });
    memory.grants.set("write-archive", {
      id: "write-archive",
      subject: { type: "user", id: "reader" },
      path: "archive",
      permission: "write",
    });
    // Internal storage is never listed, so a nested `.nimbus` folder stays out of the copy.
    await mkdir(path.join(root, "docs/.nimbus"));
    await writeFile(path.join(root, "docs/.nimbus/hidden.txt"), "hidden");
    expect(
      await caller("reader").files.copy({
        sourcePath: "docs",
        destinationPath: "archive",
      }),
    ).toMatchObject({ name: "docs", path: "archive/docs" });
    expect((await readdir(path.join(root, "archive/docs"))).sort()).toEqual([
      "first.txt",
      "nested",
    ]);
    expect(
      await readFile(path.join(root, "archive/docs/nested/deep.txt"), "utf8"),
    ).toBe("deep");
    await expect(
      caller("reader").files.move({
        sourcePath: "docs",
        destinationPath: "archive",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
    await expect(
      caller("reader").files.copy({
        sourcePath: "archive/docs",
        destinationPath: "docs",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not retry other names when a WebDAV lock blocks the destination", async () => {
    lockFile("archive", { userId: "user-1" });
    await expect(
      caller().files.copy({
        sourcePath: "docs/first.txt",
        destinationPath: "archive",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(path.join(root, "archive"))).toEqual([]);
  });

  it("stops a cancelled copy before its next file, leaving no copy and no staged files", async () => {
    const access = await getAccess(memory.store, "user-1");
    const controller = new AbortController();
    // Cancelled once the copy reaches the nested folder's files: "first.txt" is staged by then.
    const cancelling = {
      ...access,
      can: (requested: string, permission: Permission) => {
        if (requested === "docs/nested/deep.txt") controller.abort();
        return access.can(requested, permission);
      },
    };
    await expect(
      copyItem(memory.store, cancelling, "docs", "archive/docs", {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TransferCancelledError);
    expect(await readdir(path.join(root, "archive"))).toEqual([]);
    expect(await readdir(path.join(root, ".nimbus/uploads"))).toEqual([]);
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("answers cancelled for every item of a cancelled transfer, also those sent later, and copies the rest", async () => {
    const transfer = randomUUID();
    expect(
      await caller().files.copy({
        sourcePath: "docs/first.txt",
        destinationPath: "archive",
        transfer,
      }),
    ).toMatchObject({ kind: "transferred", path: "archive/first.txt" });
    await caller().files.cancelTransfer({ transfer });
    expect(
      await caller().files.copy({
        sourcePath: "docs/nested",
        destinationPath: "archive",
        transfer,
      }),
    ).toEqual({ kind: "cancelled" });
    expect(await readdir(path.join(root, "archive"))).toEqual(["first.txt"]);
    // Another account's transfer of the same id is its own.
    memory.grants.set("write-root", {
      id: "write-root",
      subject: { type: "user", id: "reader" },
      path: "",
      permission: "write",
    });
    expect(
      await caller("reader").files.copy({
        sourcePath: "docs/nested",
        destinationPath: "archive",
        transfer,
      }),
    ).toMatchObject({ kind: "transferred", path: "archive/nested" });
  });

  it("leaves the items of a cancelled move where they are", async () => {
    const transfer = randomUUID();
    await caller().files.cancelTransfer({ transfer });
    expect(
      await caller().files.move({
        sourcePath: "docs/first.txt",
        destinationPath: "archive",
        transfer,
      }),
    ).toEqual({ kind: "cancelled" });
    expect(await readdir(path.join(root, "archive"))).toEqual([]);
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("changes nothing for a move whose transfer was cancelled before its turn came", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      moveItem(
        memory.store,
        await getAccess(memory.store, "user-1"),
        "docs/first.txt",
        "docs/renamed.txt",
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(TransferCancelledError);
    expect((await readdir(path.join(root, "docs"))).sort()).toEqual([
      "first.txt",
      "nested",
    ]);
  });
});
