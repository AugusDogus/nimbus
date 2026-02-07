import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { appRouter } from "./routers";
import { publishFileEvent } from "./file-events";
import {
  getListCache,
  getListCacheKey,
  resetListCacheForTest,
  setListCache,
} from "./list-cache";
import { getPermissionsHash } from "./perms-hash";
import { statPath } from "./fs-utils";

const createCaller = () => {
  return appRouter.createCaller({
    headers: new Headers(),
    session: { user: { id: "user-1" } },
    preferences: {
      getUserPreferences: async () => null,
      setUserPreferences: async (_userId, prefs) => prefs,
    },
  });
};

describe("list-cache", () => {
  let root: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-list-cache-"));
    process.env.NIMBUS_DATA_ROOT = root;
    resetListCacheForTest();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    process.env.NIMBUS_DATA_ROOT = previousRoot;
    resetListCacheForTest();
  });

  it("returns memoized list results in files.list", async () => {
    const caller = createCaller();
    const dirStats = await statPath(root);
    const permsHash = getPermissionsHash({ user: { id: "user-1" } });
    const listKey = getListCacheKey({
      relativePath: "",
      includeStats: false,
      dirMtimeMs: dirStats.mtimeMs,
      permsHash,
    });
    const memoized = [
      { name: "cached.txt", path: "cached.txt", type: "file", mtime: null, size: null },
    ];
    setListCache(listKey, memoized);

    const results = await caller.files.list({});
    expect(results).toEqual(memoized);
  });

  it("invalidates list cache on file events", async () => {
    const dirStats = await statPath(root);
    const permsHash = getPermissionsHash({ user: { id: "user-1" } });
    const listKey = getListCacheKey({
      relativePath: "",
      includeStats: false,
      dirMtimeMs: dirStats.mtimeMs,
      permsHash,
    });
    setListCache(listKey, [
      { name: "alpha.txt", path: "alpha.txt", type: "file", mtime: null, size: null },
    ]);
    expect(getListCache(listKey)).not.toBeNull();

    const filePath = path.join(root, "alpha.txt");
    publishFileEvent({ path: filePath, event: "change", ts: Date.now() });

    expect(getListCache(listKey)).toBeNull();
  });
});
