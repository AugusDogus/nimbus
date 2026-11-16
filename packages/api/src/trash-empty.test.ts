import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

describe("emptying trash", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id = "user-1") =>
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
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-trash-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "shared/folder"), { recursive: true });
    await writeFile(path.join(root, "shared/admin.txt"), "admin");
    await writeFile(path.join(root, "shared/reader.txt"), "reader");
    await writeFile(path.join(root, "shared/folder/inside.txt"), "inside");
    memory.grants.set("write", {
      id: "write",
      subject: { type: "user", id: "reader" },
      path: "shared",
      permission: "write",
    });
  });
  afterEach(async () => {
    globalThis.nimbusFileMutations?.delete(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("permanently deletes only the caller's items for ordinary users", async () => {
    await caller().files.delete({ path: "shared/admin.txt" });
    await caller("reader").files.delete({ path: "shared/reader.txt" });
    expect(await caller("reader").trash.empty()).toEqual({ deleted: 1 });
    expect(await caller("reader").trash.list()).toEqual([]);
    expect((await caller().trash.list()).map((item) => item.path)).toEqual([
      "shared/admin.txt",
    ]);
    expect(await readdir(path.join(root, ".nimbus/trash"))).toHaveLength(1);
  });

  it("permanently deletes everyone's items for administrators, including folders", async () => {
    await caller().files.delete({ path: "shared/folder" });
    await caller("reader").files.delete({ path: "shared/reader.txt" });
    expect(await caller().trash.empty()).toEqual({ deleted: 2 });
    expect(await caller().trash.list()).toEqual([]);
    expect(await readdir(path.join(root, ".nimbus/trash"))).toEqual([]);
    expect(await caller().trash.empty()).toEqual({ deleted: 0 });
  });
});
