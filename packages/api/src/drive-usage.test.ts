import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { applyChange, crawl } from "./search-crawler";
import { createSearchIndex } from "./search-index";
import { provideSearchService } from "./search-service";
import { crawlingSearchService, createTestDriveStore } from "./testing";

describe("storage usage from the drive index", () => {
  let root: string;
  let previousRoot: string | undefined;
  const indexed = async () => {
    const index = createSearchIndex();
    await crawl(index, root);
    return index;
  };
  const caller = (id: string) =>
    appRouter.createCaller({
      headers: new Headers(),
      drive: createTestDriveStore().store,
      session: { user: { id } },
      sessionStillValid: async () => true,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_userId, preferences) => preferences,
      },
    });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-usage-"));
    process.env.NIMBUS_DATA_ROOT = root;
    provideSearchService(crawlingSearchService(root));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("totals files per folder and for the drive, excluding .nimbus and symlinks", async () => {
    await mkdir(path.join(root, "docs/deep"), { recursive: true });
    await writeFile(path.join(root, "alpha.txt"), "hello");
    await writeFile(path.join(root, "docs/a.txt"), "1234");
    await writeFile(path.join(root, "docs/deep/b.txt"), "12");
    await mkdir(path.join(root, ".nimbus"));
    await writeFile(path.join(root, ".nimbus/internal.txt"), "internal data");
    await symlink(path.join(root, "alpha.txt"), path.join(root, "link.txt"));
    const index = await indexed();
    expect(index.bytesAt("")).toBe(11);
    expect(index.bytesAt("docs")).toBe(6);
    expect(index.bytesAt("docs/deep")).toBe(2);
    expect(index.bytesAt("missing")).toBeNull();
  });

  it("follows changes, deletions and folders that appear or vanish", async () => {
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/a.txt"), "hello");
    const index = await indexed();
    await writeFile(path.join(root, "docs/a.txt"), "hello world");
    await applyChange(index, root, path.join(root, "docs/a.txt"));
    expect(index.bytesAt("")).toBe(11);
    await mkdir(path.join(root, "moved-in"));
    await writeFile(path.join(root, "moved-in/b.txt"), "123");
    await applyChange(index, root, path.join(root, "moved-in"));
    expect(index.bytesAt("")).toBe(14);
    await rm(path.join(root, "docs"), { recursive: true });
    await applyChange(index, root, path.join(root, "docs"));
    expect(index.bytesAt("")).toBe(3);
    // A file replaced by a folder of the same name.
    await rm(path.join(root, "moved-in/b.txt"));
    await mkdir(path.join(root, "moved-in/b.txt"));
    await applyChange(index, root, path.join(root, "moved-in/b.txt"));
    expect(index.bytesAt("")).toBe(0);
  });

  it("is reported to server administrators only, beside filesystem capacity", async () => {
    await writeFile(path.join(root, "visible.txt"), "hello");
    const result = await caller("user-1").files.storage();
    expect(result.usedBytes).toBe(5);
    expect(result).toHaveProperty("capacity");
    await expect(caller("reader").files.storage()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
