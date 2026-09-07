import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import {
  fileLock,
  lockFile,
  mutateFiles,
  unlockFile,
  webDAVLockTokens,
} from "./file-mutations";
import { moveItem } from "./file-operations";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

describe("filesystem mutation coordination", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = () =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id: "user-1" } },
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mutations-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/first.txt"), "first");
    await writeFile(path.join(root, "docs/second.txt"), "second");
  });
  afterEach(async () => {
    globalThis.nimbusFileMutations?.delete(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("preserves both files when concurrent renames choose the same name", async () => {
    const results = await Promise.allSettled([
      caller().files.rename({ path: "docs/first.txt", newName: "result.txt" }),
      caller().files.rename({ path: "docs/second.txt", newName: "result.txt" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const contents = await Promise.all(
      (await readdir(path.join(root, "docs"))).map((name) =>
        readFile(path.join(root, "docs", name), "utf8"),
      ),
    );
    expect(contents.sort()).toEqual(["first", "second"]);
  });

  it("prevents browser writes beneath WebDAV locks, including writes by the lock owner", async () => {
    const lock = lockFile("docs", { userId: "user-1" });
    await expect(
      caller().files.delete({ path: "docs/first.txt" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      caller().files.createFolder({ path: "docs", name: "locked" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    unlockFile("docs", "user-1", `<${lock.token}>`);
    await caller().files.createFolder({ path: "docs", name: "unlocked" });
    expect(await readdir(path.join(root, "docs"))).toContain("unlocked");
  });

  it("requires the lock owner and a positive token condition", async () => {
    const lock = lockFile("docs/first.txt", { userId: "user-1" });
    expect(webDAVLockTokens(`(Not <${lock.token}>)`)).toEqual([]);
    expect(webDAVLockTokens(`(<${lock.token}>)`)).toEqual([lock.token]);
    await expect(
      mutateFiles(
        ["docs/first.txt"],
        { userId: "reader", lockTokens: [lock.token] },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await mutateFiles(
      ["docs/first.txt"],
      { userId: "user-1", lockTokens: [lock.token] },
      async () => {},
    );
    expect(fileLock("docs/first.txt")?.token).toBe(lock.token);
  });

  it("removes locks when a move removes their original resource", async () => {
    const lock = lockFile("docs/first.txt", { userId: "user-1" });
    const access = await getAccess(memory.store, "user-1");
    await moveItem(memory.store, access, "docs/first.txt", "docs/moved.txt", [
      lock.token,
    ]);
    expect(fileLock("docs/first.txt")).toBeUndefined();
    expect(await readFile(path.join(root, "docs/moved.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("rechecks revoked permissions before a mutation commits", async () => {
    memory.grants.set("write", {
      id: "write",
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "write",
    });
    const previousAccess = await getAccess(memory.store, "reader");
    memory.grants.delete("write");
    await expect(
      moveItem(
        memory.store,
        previousAccess,
        "docs/first.txt",
        "docs/moved.txt",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
  });
});
