import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    getStorageUsage,
    noteFileEvent,
    resetStorageCacheForTest,
} from "./storage-cache";

const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 20));

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
});
