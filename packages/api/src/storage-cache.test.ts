import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

import {
  getStorageUsage,
  noteFileEvent,
  resetStorageCacheForTest,
} from "./storage-cache";

const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 20));
const waitForRescan = () => new Promise((resolve) => setTimeout(resolve, 2200));

describe("storage cache", () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-storage-"));
    process.env.NIMBUS_DATA_ROOT = root;
    resetStorageCacheForTest();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    process.env.NIMBUS_DATA_ROOT = previousRoot;
    resetStorageCacheForTest();
  });

  it("computes initial usage", async () => {
    const filePath = path.join(root, "alpha.txt");
    const content = "hello";
    await writeFile(filePath, content);

    const used = await getStorageUsage();
    expect(used).toBe(Buffer.byteLength(content));
  });

  it("keeps Nimbus file usage separate from optional filesystem capacity", async () => {
    await writeFile(path.join(root, "visible.txt"), "hello");
    await mkdir(path.join(root, ".nimbus"));
    await writeFile(
      path.join(root, ".nimbus", "internal.txt"),
      "internal data",
    );
    const caller = appRouter.createCaller({
      headers: new Headers(),
      drive: createTestDriveStore().store,
      session: { user: { id: "user-1" } },
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_userId, preferences) => preferences,
      },
    });
    const result = await caller.files.storage();
    expect(result.usedBytes).toBe(5);
    expect(await getStorageUsage()).toBe(5);
    expect(result).toHaveProperty("capacity");
    if (result.capacity !== null) {
      expect(result.capacity.totalBytes).toBeGreaterThan(0);
      expect(result.capacity.availableBytes).toBeGreaterThanOrEqual(0);
      expect(result.capacity.availableBytes).toBeLessThanOrEqual(
        result.capacity.totalBytes,
      );
    }
  });

  it("restricts storage information to server administrators", async () => {
    const caller = appRouter.createCaller({
      headers: new Headers(),
      drive: createTestDriveStore().store,
      session: { user: { id: "reader" } },
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_userId, preferences) => preferences,
      },
    });
    await expect(caller.files.storage()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("updates usage on change and delete", async () => {
    const filePath = path.join(root, "bravo.txt");
    const original = "hello";
    await writeFile(filePath, original);
    await getStorageUsage();

    const updated = "hello world";
    await writeFile(filePath, updated);
    noteFileEvent({ path: filePath, event: "change", ts: Date.now() });
    await waitForAsync();

    const afterUpdate = await getStorageUsage();
    expect(afterUpdate).toBe(Buffer.byteLength(updated));

    await rm(filePath, { force: true });
    noteFileEvent({ path: filePath, event: "change", ts: Date.now() });
    await waitForAsync();

    const afterDelete = await getStorageUsage();
    expect(afterDelete).toBe(0);
  });

  it("ignores symlinks", async () => {
    const targetPath = path.join(root, "target.txt");
    const linkPath = path.join(root, "link.txt");
    const content = "hello";
    await writeFile(targetPath, content);

    try {
      await symlink(targetPath, linkPath);
    } catch {
      return;
    }

    const used = await getStorageUsage();
    expect(used).toBe(Buffer.byteLength(content));
  });

  it("rebuilds after directory changes", async () => {
    const baseline = await getStorageUsage();
    expect(baseline).toBe(0);

    const nestedDir = path.join(root, "nested");
    await mkdir(nestedDir);
    const filePath = path.join(nestedDir, "nested.txt");
    const content = "nested";
    await writeFile(filePath, content);

    noteFileEvent({ path: nestedDir, event: "change", ts: Date.now() });
    await waitForRescan();

    const used = await getStorageUsage();
    expect(used).toBe(Buffer.byteLength(content));
  });
});
